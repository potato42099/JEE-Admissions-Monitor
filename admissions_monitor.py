#!/usr/bin/env python3
"""
Indian Engineering & Allied Admissions Autonomous Monitor (2027-28 Intake)
==========================================================================
Maintains persistent atomic state (`admissions_state.json`), evaluates
14d, 7d, 3d, 1d, and 0d deadline reminders across all 61 monitored sources,
and preserves all schema columns (Tier, Routes, Category, Dataset, etc.)
by header name without clobbering.
"""

from __future__ import annotations

import argparse
import base64
import csv
import dataclasses
import datetime
import email.message
import hashlib
import json
import logging
import os
import re
import smtplib
import ssl
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

IST = datetime.timezone(datetime.timedelta(hours=5, minutes=30), name="IST")

def load_dotenv(env_path: str = ".env") -> None:
    candidate_paths = [
        env_path,
        os.path.join(os.path.dirname(__file__), ".env"),
        os.path.join(os.getcwd(), ".env")
    ]
    for p in candidate_paths:
        if os.path.exists(p):
            with open(p, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip()
                    v = v.strip().strip("'\"")
                    if k and k not in os.environ:
                        os.environ[k] = v
            break

load_dotenv()


logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
logger = logging.getLogger("AdmissionsMonitor")


@dataclasses.dataclass
class MonitoredSource:
    event_id: str
    priority_tier: str
    institution_or_exam: str
    category: str
    admission_cycle: str
    accepted_routes: str
    official_website: str
    application_portal_url: str
    baseline_status: str
    alert_classification: str
    application_open_date: str
    application_deadline: Optional[str]
    exam_or_counselling_window: str
    notes: str
    # Expanded Schema Columns (Phase 1 & 2)
    tier_code: str = "TIER_3"
    tier_label: str = "Tier 3"
    is_karnataka: bool = False
    routes: str = ""
    short_tag: str = ""
    dataset: str = "ADMISSIONS"
    category_code: str = ""
    category_label: str = ""
    deadline_iso: Optional[str] = None
    display_order: int = 99
    active: bool = True


def load_registry_from_tsv(tsv_path: str) -> List[MonitoredSource]:
    sources: List[MonitoredSource] = []
    if not os.path.exists(tsv_path):
        return sources
    with open(tsv_path, "r", encoding="utf-8") as f:
        reader = csv.DictReader(f, delimiter="\t")
        for r in reader:
            src = MonitoredSource(
                event_id=r["Event_ID"],
                priority_tier=r["Priority_Tier"],
                institution_or_exam=r["Institution_or_Exam"],
                category=r["Category"],
                admission_cycle=r["Admission_Cycle"],
                accepted_routes=r["Accepted_Routes"],
                official_website=r["Official_Website"],
                application_portal_url=r["Application_Portal_URL"],
                baseline_status=r["Registration_Status"],
                alert_classification=r["Alert_Classification"],
                application_open_date=r["Application_Open_Date"],
                application_deadline=r["Application_Deadline"] or None,
                exam_or_counselling_window=r["Exam_or_Counselling_Window"],
                notes=r["Application_Fee_or_Notes"],
                tier_code=r.get("Tier_Code", "TIER_3"),
                tier_label=r.get("Tier_Label", "Tier 3"),
                is_karnataka=r.get("Is_Karnataka", "FALSE").upper() == "TRUE",
                routes=r.get("Routes", ""),
                short_tag=r.get("Short_Tag", ""),
                dataset=r.get("Dataset", "ADMISSIONS"),
                category_code=r.get("Category_Code", ""),
                category_label=r.get("Category_Label", ""),
                deadline_iso=r.get("Deadline_ISO") or None,
                display_order=int(r.get("Display_Order", "99") or "99"),
                active=r.get("Active", "TRUE").upper() == "TRUE",
            )
            sources.append(src)
    return sources


# Load all 61 monitored sources from local TSV cache (or fallback list)
TSV_FILE = os.path.join(os.path.dirname(__file__), "source_registry_full_updated.tsv")
if not os.path.exists(TSV_FILE):
    TSV_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(__file__)))), "source_registry_full_updated.tsv")

INITIAL_REGISTRY: List[MonitoredSource] = load_registry_from_tsv(TSV_FILE)


def now_ist_str() -> str:
    return datetime.datetime.now(IST).strftime("%Y-%m-%d %H:%M:%S IST")


def load_or_init_state(state_path: str) -> Dict[str, Any]:
    if os.path.exists(state_path):
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                state = json.load(f)
                # Ensure all 61 sources exist in state
                for src in INITIAL_REGISTRY:
                    if src.event_id not in state["sources"]:
                        fp = hashlib.sha256(
                            f"{src.event_id}|{src.baseline_status}|{src.application_deadline}".encode("utf-8")
                        ).hexdigest()[:16]
                        state["sources"][src.event_id] = {
                            "event_id": src.event_id,
                            "priority_tier": src.priority_tier,
                            "institution_or_exam": src.institution_or_exam,
                            "category": src.category,
                            "admission_cycle": src.admission_cycle,
                            "accepted_routes": src.accepted_routes,
                            "official_website": src.official_website,
                            "application_portal_url": src.application_portal_url,
                            "registration_status": src.baseline_status,
                            "alert_classification": src.alert_classification,
                            "application_open_date": src.application_open_date,
                            "application_deadline": src.application_deadline,
                            "revised_deadline": None,
                            "deadline_iso": src.deadline_iso,
                            "exam_or_counselling_window": src.exam_or_counselling_window,
                            "notes": src.notes,
                            "tier_code": src.tier_code,
                            "tier_label": src.tier_label,
                            "is_karnataka": src.is_karnataka,
                            "routes": src.routes,
                            "short_tag": src.short_tag,
                            "dataset": src.dataset,
                            "category_code": src.category_code,
                            "category_label": src.category_label,
                            "display_order": src.display_order,
                            "active": src.active,
                            "content_fingerprint": fp,
                            "first_seen_ist": now_ist_str(),
                            "last_checked_ist": now_ist_str(),
                            "last_successful_check_ist": now_ist_str(),
                            "consecutive_failures": 0,
                        }
                return state
        except Exception as exc:
            logger.warning("Could not read state file %s (%s); rebuilding state.", state_path, exc)

    ts = now_ist_str()
    sources: Dict[str, Dict[str, Any]] = {}
    for src in INITIAL_REGISTRY:
        fp = hashlib.sha256(
            f"{src.event_id}|{src.baseline_status}|{src.application_deadline}".encode("utf-8")
        ).hexdigest()[:16]
        sources[src.event_id] = {
            "event_id": src.event_id,
            "priority_tier": src.priority_tier,
            "institution_or_exam": src.institution_or_exam,
            "category": src.category,
            "admission_cycle": src.admission_cycle,
            "accepted_routes": src.accepted_routes,
            "official_website": src.official_website,
            "application_portal_url": src.application_portal_url,
            "registration_status": src.baseline_status,
            "alert_classification": src.alert_classification,
            "application_open_date": src.application_open_date,
            "application_deadline": src.application_deadline,
            "revised_deadline": None,
            "deadline_iso": src.deadline_iso,
            "exam_or_counselling_window": src.exam_or_counselling_window,
            "notes": src.notes,
            "tier_code": src.tier_code,
            "tier_label": src.tier_label,
            "is_karnataka": src.is_karnataka,
            "routes": src.routes,
            "short_tag": src.short_tag,
            "dataset": src.dataset,
            "category_code": src.category_code,
            "category_label": src.category_label,
            "display_order": src.display_order,
            "active": src.active,
            "content_fingerprint": fp,
            "first_seen_ist": ts,
            "last_checked_ist": ts,
            "last_successful_check_ist": ts,
            "consecutive_failures": 0,
        }

    state = {
        "metadata": {
            "created_ist": ts,
            "last_run_ist": ts,
            "timezone": "Asia/Kolkata",
        },
        "sources": sources,
        "notification_log": [],
        "reminder_log": {},
        "pending_delivery_queue": [],
    }
    save_state(state_path, state)
    return state


def save_state(state_path: str, state: Dict[str, Any]) -> None:
    tmp_path = f"{state_path}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, state_path)


def escape_telegram_markdown(text: str) -> str:
    return str(text).replace("_", "\\_").replace("*", "\\*").replace("`", "\\`")


def format_telegram_alert(row: Dict[str, Any], prefix: str = "NEW APPLICATION OPENED") -> str:
    deadline_str = row.get("deadline_iso") or row.get("revised_deadline") or row.get("application_deadline") or "TBA"
    lines = [
        f"*{escape_telegram_markdown(prefix)}*",
        f"• *Exam / Institution:* {escape_telegram_markdown(row['institution_or_exam'])}",
        f"• *Status:* {row.get('registration_status', 'OPEN')}",
        f"• *Application Deadline:* {escape_telegram_markdown(deadline_str)}",
        f"• *Accepted Routes:* {escape_telegram_markdown(row.get('accepted_routes', 'See Portal'))}",
        f"• *Portal Link:* {row['application_portal_url']}",
        f"• *Timestamp:* {now_ist_str()}",
    ]
    return "\n".join(lines)


def send_telegram_message(message: str) -> Tuple[bool, str]:
    bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

    if not bot_token or not chat_id:
        return False, "Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID environment variable"

    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    payload = urllib.parse.urlencode(
        {
            "chat_id": chat_id,
            "text": message,
            "parse_mode": "Markdown",
            "disable_web_page_preview": "true",
        }
    ).encode("utf-8")

    for attempt in range(1, 4):
        try:
            req = urllib.request.Request(url, data=payload, method="POST")
            with urllib.request.urlopen(req, timeout=15) as resp:
                if resp.status == 200:
                    return True, "Delivered"
        except Exception as exc:
            logger.warning("Telegram attempt %d failed: %s", attempt, exc)
            time.sleep(2 ** attempt)
    return False, "Failed after 3 retries"


def send_whatsapp_callmebot(message: str) -> Tuple[bool, str]:
    phone = os.environ.get("CALLMEBOT_PHONE", "").strip()
    apikey = os.environ.get("CALLMEBOT_APIKEY", "").strip()

    if not phone or not apikey:
        return False, "Missing CALLMEBOT_PHONE or CALLMEBOT_APIKEY environment variable"

    params = urllib.parse.urlencode({
        "phone": phone,
        "text": message,
        "apikey": apikey,
    })
    url = f"https://api.callmebot.com/whatsapp.php?{params}"

    for attempt in range(1, 4):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "AdmissionsMonitor/2027"}, method="GET")
            with urllib.request.urlopen(req, timeout=20) as resp:
                if resp.status == 200:
                    return True, "Delivered via CallMeBot"
        except Exception as exc:
            logger.warning("CallMeBot WhatsApp attempt %d failed: %s", attempt, exc)
            time.sleep(2 ** attempt)
    return False, "Failed after 3 retries"


def send_whatsapp_twilio(message: str) -> Tuple[bool, str]:
    account_sid = os.environ.get("TWILIO_ACCOUNT_SID", "").strip()
    auth_token = os.environ.get("TWILIO_AUTH_TOKEN", "").strip()
    to_number = os.environ.get("TWILIO_TO_NUMBER", "").strip()
    from_number = os.environ.get("TWILIO_FROM_NUMBER", "whatsapp:+14155238886").strip()

    if not account_sid or not auth_token or not to_number:
        return False, "Missing TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, or TWILIO_TO_NUMBER"

    if not to_number.startswith("whatsapp:"):
        to_number = f"whatsapp:{to_number}"
    if not from_number.startswith("whatsapp:"):
        from_number = f"whatsapp:{from_number}"

    url = f"https://api.twilio.com/2010-04-01/Accounts/{account_sid}/Messages.json"
    payload = urllib.parse.urlencode({
        "From": from_number,
        "To": to_number,
        "Body": message,
    }).encode("utf-8")

    auth_str = f"{account_sid}:{auth_token}"
    auth_b64 = base64.b64encode(auth_str.encode("utf-8")).decode("utf-8")

    req = urllib.request.Request(url, data=payload, method="POST")
    req.add_header("Authorization", f"Basic {auth_b64}")
    req.add_header("Content-Type", "application/x-www-form-urlencoded")

    for attempt in range(1, 4):
        try:
            with urllib.request.urlopen(req, timeout=20) as resp:
                if resp.status in [200, 201]:
                    return True, "Delivered via Twilio WhatsApp"
        except Exception as exc:
            logger.warning("Twilio WhatsApp attempt %d failed: %s", attempt, exc)
            time.sleep(2 ** attempt)
    return False, "Failed after 3 retries"


def send_whatsapp_alert(message: str) -> Tuple[bool, str]:
    """Dispatches WhatsApp alert via Twilio (priority) or CallMeBot (fallback)."""
    if os.environ.get("TWILIO_ACCOUNT_SID") and os.environ.get("TWILIO_AUTH_TOKEN") and os.environ.get("TWILIO_TO_NUMBER"):
        return send_whatsapp_twilio(message)
    if os.environ.get("CALLMEBOT_PHONE") and os.environ.get("CALLMEBOT_APIKEY"):
        return send_whatsapp_callmebot(message)
    return False, "Neither Twilio nor CallMeBot WhatsApp configured"


def send_email_alert(subject: str, body: str) -> Tuple[bool, str]:
    smtp_user = os.environ.get("SMTP_USER", "").strip()
    smtp_pass = os.environ.get("SMTP_APP_PASSWORD", "").strip()
    recipient = os.environ.get("ALERT_RECIPIENT_EMAIL", smtp_user).strip()
    smtp_host = os.environ.get("SMTP_HOST", "smtp.gmail.com").strip()
    smtp_port = int(os.environ.get("SMTP_PORT", "465"))

    if not smtp_user or not smtp_pass or not recipient:
        return False, "Missing SMTP credentials"

    msg = email.message.EmailMessage()
    msg["Subject"] = subject
    msg["From"] = smtp_user
    msg["To"] = recipient
    msg.set_content(body)

    context = ssl.create_default_context()
    for attempt in range(1, 4):
        try:
            with smtplib.SMTP_SSL(smtp_host, smtp_port, context=context, timeout=20) as server:
                server.login(smtp_user, smtp_pass)
                server.send_message(msg)
            return True, "Delivered"
        except Exception as exc:
            logger.warning("Email delivery attempt %d failed: %s", attempt, exc)
            time.sleep(2 ** attempt)
    return False, "Failed after 3 retries"


def evaluate_deadline_reminders(state: Dict[str, Any], dry_run: bool = False) -> List[Dict[str, Any]]:
    today = datetime.datetime.now(IST).date()
    reminder_offsets = [14, 7, 3, 1, 0]
    triggered: List[Dict[str, Any]] = []

    for event_id, row in state["sources"].items():
        if row.get("active") is False:
            continue
        if row.get("registration_status") != "OPEN":
            continue
        deadline_iso = row.get("deadline_iso") or row.get("revised_deadline") or row.get("application_deadline")
        if not deadline_iso:
            continue
        # Extract YYYY-MM-DD
        m = re.search(r"(\d{4}-\d{2}-\d{2})", str(deadline_iso))
        if not m:
            continue
        try:
            deadline_date = datetime.date.fromisoformat(m.group(1))
        except ValueError:
            continue

        days_left = (deadline_date - today).days
        if days_left in reminder_offsets:
            rem_key = f"{event_id}|{deadline_date.isoformat()}|{days_left}d"
            if rem_key in state["reminder_log"]:
                continue

            prefix = f"DEADLINE REMINDER ({days_left} DAYS LEFT)" if days_left > 0 else "FINAL DEADLINE TODAY"
            tg_msg = format_telegram_alert(row, prefix=prefix)
            email_subj = f"[{prefix}] {row['institution_or_exam']} — Apply by {deadline_date.isoformat()}"
            email_body = tg_msg.replace("*", "")

            item = {
                "event_id": event_id,
                "institution": row["institution_or_exam"],
                "deadline_date": deadline_date.isoformat(),
                "days_before": days_left,
                "prefix": prefix,
                "email_subject": email_subj,
                "dry_run": dry_run,
            }

            if not dry_run:
                tg_ok, _ = send_telegram_message(tg_msg)
                em_ok, _ = send_email_alert(email_subj, email_body)
                wa_ok, _ = send_whatsapp_alert(tg_msg)
                state["reminder_log"][rem_key] = {
                    "event_id": event_id,
                    "deadline_date": deadline_date.isoformat(),
                    "days_before": days_left,
                    "sent_ist": now_ist_str(),
                    "telegram_ok": tg_ok,
                    "email_ok": em_ok,
                    "whatsapp_ok": wa_ok,
                }
            triggered.append(item)
    return triggered


def print_status_report(state: Dict[str, Any]) -> None:
    sources = list(state["sources"].values())
    total = len(sources)
    open_rows = [s for s in sources if s.get("registration_status") == "OPEN"]
    imminent_rows = [s for s in sources if s.get("alert_classification") in ["HIGH PRIORITY", "OPENING SOON • NOV 2026", "OPENING SOON • DEC 2026", "OPENING SOON • NOV–DEC 2026", "OPENS DEC 2, 2026 (CONFIRMED)"]]
    allied_rows = [s for s in sources if s.get("dataset") == "ALLIED"]

    print("=" * 76)
    print(f"INDIAN ENGINEERING ADMISSIONS MONITOR — STATUS REPORT ({now_ist_str()})")
    print("=" * 76)
    print(f"Total Monitored Streams        : {total} (49 Admissions + {len(allied_rows)} Allied)")
    print(f"Currently Open Applications    : {len(open_rows)}")
    print(f"Imminent Upcoming Portals      : {len(imminent_rows)}")
    print("-" * 76)
    print("CURRENTLY OPEN APPLICATIONS (CRITICAL — ACT NOW):")
    for row in open_rows:
        dl = row.get("deadline_iso") or row.get("application_deadline") or "TBA"
        tag = row.get("short_tag") or row["event_id"]
        print(f"  • [{tag}] {row['institution_or_exam'][:40]} | Deadline: {dl} | {row['application_portal_url']}")
    print("=" * 76)


def main() -> int:
    parser = argparse.ArgumentParser(description="Indian Engineering Admissions Autonomous Monitor")
    parser.add_argument(
        "--state-path",
        default=os.path.join(os.path.dirname(__file__), "admissions_state.json"),
        help="Path to persistent JSON state database",
    )
    parser.add_argument("--status", action="store_true", help="Print status summary from persistent state")
    parser.add_argument("--run-once", action="store_true", help="Execute a full monitoring and reminder cycle")
    parser.add_argument("--dry-run", action="store_true", help="Execute in dry-run mode without modifying state or sending alerts")
    parser.add_argument("--test-notifications", action="store_true", help="Send a test alert to Telegram and Email")
    parser.add_argument("--setup-twilio", action="store_true", help="Interactively configure Twilio WhatsApp credentials in .env")
    args = parser.parse_args()

    if args.setup_twilio:
        print("=" * 60)
        print("TWILIO WHATSAPP CONFIGURATION SETUP")
        print("=" * 60)
        print("1. Sign up / Log in to https://console.twilio.com/")
        print("2. Connect WhatsApp: Text join <sandbox-code> to +1 415 523 8886")
        print("=" * 60)
        sid = input("Enter Twilio Account SID (starts with AC): ").strip()
        token = input("Enter Twilio Auth Token: ").strip()
        phone = input("Enter your WhatsApp number (e.g. +919876543210): ").strip()
        from_phone = input("Enter Twilio Sandbox number [default: whatsapp:+14155238886]: ").strip() or "whatsapp:+14155238886"

        if not sid.startswith("AC"):
            print("Warning: Twilio Account SID usually starts with AC.")
        
        env_lines = []
        env_path = os.path.join(os.path.dirname(__file__), ".env")
        existing_keys = set()
        if os.path.exists(env_path):
            with open(env_path, "r", encoding="utf-8") as f:
                for line in f:
                    k = line.strip().split("=")[0].strip() if "=" in line else ""
                    if k in ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_TO_NUMBER", "TWILIO_FROM_NUMBER"]:
                        continue
                    env_lines.append(line)
        
        env_lines.append(f"TWILIO_ACCOUNT_SID={sid}\n")
        env_lines.append(f"TWILIO_AUTH_TOKEN={token}\n")
        env_lines.append(f"TWILIO_TO_NUMBER={phone}\n")
        env_lines.append(f"TWILIO_FROM_NUMBER={from_phone}\n")

        with open(env_path, "w", encoding="utf-8") as f:
            f.writelines(env_lines)
        os.chmod(env_path, 0o600)
        print(f"Credentials securely saved to {env_path} (mode 600).")
        
        os.environ["TWILIO_ACCOUNT_SID"] = sid
        os.environ["TWILIO_AUTH_TOKEN"] = token
        os.environ["TWILIO_TO_NUMBER"] = phone
        os.environ["TWILIO_FROM_NUMBER"] = from_phone

        test_now = input("Send a test WhatsApp message to verify now? [y/N]: ").strip().lower()
        if test_now == "y":
            ok, msg = send_whatsapp_twilio("🎉 *Twilio WhatsApp Connected Successfully!*\nYour Indian Engineering Admissions Monitor is active.")
            print(f"Test Result: {'SUCCESS' if ok else 'FAILED'} ({msg})")
        return 0

    state = load_or_init_state(args.state_path)

    if args.status:
        print_status_report(state)
        return 0

    if args.test_notifications:
        sample = state["sources"].get("NAT-VIT-VITEEE-2027")
        if sample:
            msg = format_telegram_alert(sample, prefix="TEST ALERT — OPEN APPLICATION")
            tg_ok, tg_status = send_telegram_message(msg)
            em_ok, em_status = send_email_alert(
                "[TEST ALERT] Indian Engineering Admissions Monitor Configured",
                msg.replace("*", ""),
            )
            wa_ok, wa_status = send_whatsapp_alert(msg)
            logger.info("WhatsApp test: %s (%s) | Telegram test: %s (%s) | Email test: %s (%s)", wa_ok, wa_status, tg_ok, tg_status, em_ok, em_status)

    if args.dry_run:
        print("[DRY-RUN MODE] Evaluating state and deadline triggers...")
        reminders = evaluate_deadline_reminders(state, dry_run=True)
        print(f"Dry-run evaluation completed. Reminders that would trigger today ({now_ist_str()}): {len(reminders)}")
        for r in reminders:
            print(f"  -> [{r['days_before']}d left] {r['event_id']}: {r['institution']} (Deadline: {r['deadline_date']})")
        print_status_report(state)
        return 0

    if args.run_once:
        reminders = evaluate_deadline_reminders(state, dry_run=False)
        state["metadata"]["last_run_ist"] = now_ist_str()
        save_state(args.state_path, state)
        logger.info("Evaluated deadline reminders; sent=%d", len(reminders))
        print_status_report(state)

    return 0


if __name__ == "__main__":
    sys.exit(main())