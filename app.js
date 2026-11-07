// State Collections loaded dynamically from Google Sheet DB (with offline embedded snapshot fallback)
    let ADMISSIONS_DATA = [];
    let OTHER_EXAMS_DATA = [];
    let SITE_CONFIG = {};

    function getAllSourcesCombined() {
      return ADMISSIONS_DATA.concat(OTHER_EXAMS_DATA);
    }

    // Security helpers: strict HTML escaping and HTTPS-only URL validation
    function escapeHtml(str) {
      if (str === null || str === undefined) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function sanitizeUrl(rawUrl) {
      if (!rawUrl) return "https://jeemain.nta.nic.in/";
      try {
        const parsed = new URL(String(rawUrl).trim());
        if (parsed.protocol === "https:") {
          return parsed.href;
        }
      } catch (e) {}
      return "https://jeemain.nta.nic.in/";
    }

    function sanitizeCsvCell(val) {
      let s = val === null || val === undefined ? "" : String(val).trim();
      if (/^[=+\-@\t\r]/.test(s)) {
        s = "'" + s;
      }
      return `"${s.replace(/"/g, '""')}"`;
    }

    function formatToIstString(date = new Date()) {
      try {
        const options = {
          timeZone: "Asia/Kolkata",
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false
        };
        const formatter = new Intl.DateTimeFormat("en-US", options);
        const parts = formatter.formatToParts(date);
        const p = {};
        parts.forEach(({ type, value }) => { p[type] = value; });
        return `${p.month} ${p.day}, ${p.year} ${p.hour}:${p.minute} IST`;
      } catch (e) {
        return "Oct 29, 2026 20:35 IST";
      }
    }

    function getLatestDatasetTimestamp() {
      try {
        const saved = localStorage.getItem("monitor_last_verified_ist");
        if (saved && !saved.includes("Oct 27") && !saved.includes("Oct 28")) return saved;
      } catch (e) {}

      let latest = "Oct 29, 2026 20:35 IST";
      const allItems = getAllSourcesCombined();
      for (const item of allItems) {
        if (item.lastVerified && item.lastVerified !== "Live Synced" && !item.lastVerified.includes("Oct 27")) {
          latest = item.lastVerified;
          break;
        }
      }
      return latest;
    }

    function updateFooterAndModalVerification(timestamp) {
      const ts = timestamp || getLatestDatasetTimestamp() || formatToIstString();
      const footerEl = document.getElementById("footer-last-verified");
      if (footerEl) footerEl.textContent = ts;
      const modalEl = document.getElementById("modal-last-verified");
      if (modalEl) modalEl.textContent = ts;
      try {
        localStorage.setItem("monitor_last_verified_ist", ts);
      } catch (e) {}
    }

    // Persistent User Application Tracker State
    const STORAGE_KEY = "eng_admissions_user_tracker_2027_v2";
    const LEGACY_STORAGE_KEY = "eng_admissions_user_tracker_2027_v1";
    const BACKUP_STORAGE_KEY = "eng_trk_data";
    const COMPACT_COOKIE_KEY = "eng_trk_27";
    const TAB_STORAGE_KEY = "eng_admissions_active_tab_2027";
    const VALID_USER_STATUSES = ["NONE", "SHORTLISTED", "IN_PROGRESS", "APPLIED"];
    const TRACKED_STATUSES = ["SHORTLISTED", "IN_PROGRESS", "APPLIED"];
    let userTracker = {};

    function isTrackedStatus(st) {
      return TRACKED_STATUSES.includes(st);
    }

    function getTrackedIds() {
      return Object.keys(userTracker).filter((id) => isTrackedStatus(userTracker[id]));
    }

    function encodeCompactCookie(tracker) {
      const src = tracker || userTracker;
      const codeMap = { SHORTLISTED: "S", IN_PROGRESS: "P", APPLIED: "A" };
      const pairs = [];
      Object.keys(src).forEach((id) => {
        const st = src[id];
        if (st && codeMap[st]) {
          pairs.push(id + ":" + codeMap[st]);
        }
      });
      return pairs.join("|");
    }

    function decodeCompactCookie(str) {
      const revMap = { S: "SHORTLISTED", P: "IN_PROGRESS", A: "APPLIED" };
      const out = {};
      if (!str) return out;
      const delimiter = str.includes("|") ? "|" : ",";
      const parts = str.split(delimiter);
      const allItems = typeof getAllSourcesCombined === "function" ? getAllSourcesCombined() : [];

      parts.forEach((part) => {
        const colonIdx = part.lastIndexOf(":");
        if (colonIdx > 0) {
          const key = part.substring(0, colonIdx).trim();
          const code = part.substring(colonIdx + 1).trim();
          if (revMap[code]) {
            const numIdx = parseInt(key, 10);
            if (!Number.isNaN(numIdx) && String(numIdx) === key && allItems[numIdx]) {
              out[allItems[numIdx].id] = revMap[code];
            } else if (key) {
              out[key] = revMap[code];
            }
          }
        }
      });
      return out;
    }

    function validateAndMergeTrackerMap(candidate, overwriteExisting) {
      if (!candidate || typeof candidate !== "object") return 0;
      let count = 0;
      Object.keys(candidate).forEach((k) => {
        if (!k || typeof k !== "string") return;
        const cleanKey = k.trim();
        const v = String(candidate[cleanKey] || candidate[k] || "").trim().toUpperCase();
        if (TRACKED_STATUSES.includes(v)) {
          if (overwriteExisting || !(cleanKey in userTracker)) {
            userTracker[cleanKey] = v;
            count++;
          }
        }
      });
      return count;
    }

    function loadUserTracker() {
      userTracker = {};
      let hasData = false;

      // Layer 1: URL Hash (#trk=... or #tracker=...) - immune to iframe sandboxing
      try {
        const hash = window.location.hash || "";
        if (hash.includes("trk=") || hash.includes("tracker=")) {
          const hashStr = hash.startsWith("#") ? hash.substring(1) : hash;
          const params = new URLSearchParams(hashStr);
          const code = params.get("trk") || params.get("tracker");
          if (code) {
            const raw = decodeURIComponent(code);
            if (raw.includes(":") || raw.includes("|")) {
              const decoded = decodeCompactCookie(raw);
              if (validateAndMergeTrackerMap(decoded, true) > 0) hasData = true;
            } else {
              try {
                const decoded = JSON.parse(atob(raw));
                if (validateAndMergeTrackerMap(decoded, true) > 0) hasData = true;
              } catch (_) {}
            }
          }
        }
      } catch (e) {}

      // Layer 2: localStorage (v2, backup key, and legacy v1)
      try {
        const rawV2 = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(BACKUP_STORAGE_KEY);
        if (rawV2) {
          const parsed = JSON.parse(rawV2);
          if (validateAndMergeTrackerMap(parsed, !hasData) > 0) hasData = true;
        }
      } catch (e) {}

      try {
        const rawV1 = localStorage.getItem(LEGACY_STORAGE_KEY);
        if (rawV1) {
          const parsed = JSON.parse(rawV1);
          if (validateAndMergeTrackerMap(parsed, !hasData) > 0) hasData = true;
        }
      } catch (e) {}

      // Layer 3: sessionStorage (guaranteed survival across tab refreshes)
      try {
        const rawSession = sessionStorage.getItem(STORAGE_KEY) || sessionStorage.getItem(BACKUP_STORAGE_KEY);
        if (rawSession) {
          const parsed = JSON.parse(rawSession);
          if (validateAndMergeTrackerMap(parsed, !hasData) > 0) hasData = true;
        }
      } catch (e) {}

      // Layer 4: Persistent First-Party Cookies
      try {
        const cookiePairs = document.cookie ? document.cookie.split(/;\s*/) : [];
        for (const pair of cookiePairs) {
          const eqIdx = pair.indexOf("=");
          if (eqIdx > 0) {
            const k = pair.substring(0, eqIdx).trim();
            const val = pair.substring(eqIdx + 1).trim();
            if ((k === STORAGE_KEY || k === BACKUP_STORAGE_KEY) && val) {
              try {
                const parsed = JSON.parse(decodeURIComponent(val));
                if (validateAndMergeTrackerMap(parsed, !hasData) > 0) hasData = true;
              } catch (_) {}
            } else if (k === COMPACT_COOKIE_KEY && val) {
              try {
                const decoded = decodeCompactCookie(decodeURIComponent(val));
                if (validateAndMergeTrackerMap(decoded, !hasData) > 0) hasData = true;
              } catch (_) {}
            }
          }
        }
      } catch (e) {}

      // Layer 5: In-tab window.name failsafe
      try {
        if (window.name && window.name.startsWith("{")) {
          const wData = JSON.parse(window.name);
          if (wData && (wData[STORAGE_KEY] || wData[BACKUP_STORAGE_KEY])) {
            const candidate = wData[STORAGE_KEY] || wData[BACKUP_STORAGE_KEY];
            if (validateAndMergeTrackerMap(candidate, !hasData) > 0) hasData = true;
          }
        }
      } catch (e) {}
    }

    function saveUserTracker() {
      const serialized = JSON.stringify(userTracker);
      const compact = encodeCompactCookie(userTracker);

      // Layer 1: Primary localStorage
      try {
        localStorage.setItem(STORAGE_KEY, serialized);
        localStorage.setItem(BACKUP_STORAGE_KEY, serialized);
      } catch (e) {}

      // Layer 2: sessionStorage (active tab survival)
      try {
        sessionStorage.setItem(STORAGE_KEY, serialized);
        sessionStorage.setItem(BACKUP_STORAGE_KEY, serialized);
      } catch (e) {}

      // Layer 3: Persistent First-Party Cookies
      try {
        const encodedCompact = encodeURIComponent(compact);
        const encodedJson = encodeURIComponent(serialized);
        const expires = "expires=" + new Date(Date.now() + 365 * 864e5).toUTCString();

        document.cookie = COMPACT_COOKIE_KEY + "=" + encodedCompact + "; " + expires + "; path=/; SameSite=Lax";
        document.cookie = STORAGE_KEY + "=" + encodedJson + "; " + expires + "; path=/; SameSite=Lax";

        if (window.location.protocol === "https:") {
          document.cookie = COMPACT_COOKIE_KEY + "=" + encodedCompact + "; " + expires + "; path=/; SameSite=None; Secure";
          document.cookie = STORAGE_KEY + "=" + encodedJson + "; " + expires + "; path=/; SameSite=None; Secure";
        }
      } catch (e) {}

      // Layer 4: URL Hash Sync (#trk=...) - persists across iframe reloads
      try {
        if (compact) {
          const newHash = "#trk=" + encodeURIComponent(compact);
          if (window.history && window.history.replaceState) {
            window.history.replaceState(null, "", newHash);
          } else {
            window.location.hash = "trk=" + encodeURIComponent(compact);
          }
        } else {
          if (window.history && window.history.replaceState) {
            const cleanUrl = window.location.pathname + window.location.search;
            window.history.replaceState(null, "", cleanUrl);
          }
        }
      } catch (e) {}

      // Layer 5: In-tab window.name failsafe
      try {
        let wData = {};
        if (window.name && window.name.startsWith("{")) {
          try { wData = JSON.parse(window.name); } catch (_) {}
        }
        wData[STORAGE_KEY] = userTracker;
        wData[BACKUP_STORAGE_KEY] = userTracker;
        window.name = JSON.stringify(wData);
      } catch (e) {}

    }

    // Current Filter, Sync & View State
    const appState = {
      statusTab: "OPEN",
      previousTabBeforeSearch: null,
      tierFilter: "ALL",
      routeFilter: "ALL",
      searchQuery: "",
      sortBy: "STATUS_PRIORITY",
      viewMode: "CARDS",
      otherCategoryFilter: "ALL",
      syncStatus: "OFFLINE_SNAPSHOT",
      lastSyncedCount: 0,
      snapshotDate: "Oct 29, 2026",
      siteConfig: {}
    };

    function getDaysRemaining(deadlineIso) {
      if (!deadlineIso || !/^\d{4}-\d{2}-\d{2}$/.test(deadlineIso)) return null;
      const now = new Date();
      const target = new Date(deadlineIso + "T23:59:59+05:30");
      if (Number.isNaN(target.getTime())) return null;
      const diffMs = target.getTime() - now.getTime();
      return Math.ceil(diffMs / (1000 * 60 * 60 * 24));
    }

    function parseSingleDeadlineIso(str) {
      if (!str) return null;
      const s = String(str).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      if (/rolling|session-wise|phase-wise|round-wise|tba|via |expected|window|\//i.test(s)) {
        return null;
      }
      const cleaned = s.replace(/\(.*?\)/g, "").trim();
      const m = cleaned.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(202\d)$/);
      if (m) {
        const dt = new Date(`${m[1]} ${m[2]}, ${m[3]} 12:00:00 GMT+0530`);
        if (!Number.isNaN(dt.getTime())) {
          const yyyy = dt.getFullYear();
          const mm = String(dt.getMonth() + 1).padStart(2, "0");
          const dd = String(dt.getDate()).padStart(2, "0");
          return `${yyyy}-${mm}-${dd}`;
        }
      }
      return null;
    }

    function reconcileAutoClosedStatuses() {
      getAllSourcesCombined().forEach((item) => {
        if (item.deadlineIso) {
          const days = getDaysRemaining(item.deadlineIso);
          if (days !== null && days < 0) {
            item.status = "CLOSED";
            item.priority = "DEADLINE PASSED";
          }
        }
      });
    }

    function showToast(msg) {
      const toast = document.getElementById("toast-banner");
      const text = document.getElementById("toast-message");
      if (!toast || !text) return;
      text.textContent = msg;
      toast.classList.remove("hidden");
      toast.classList.add("flex");
      if (window._toastTimer) clearTimeout(window._toastTimer);
      window._toastTimer = setTimeout(() => {
        toast.classList.add("hidden");
        toast.classList.remove("flex");
      }, 2200);
    }

    function updateUserStatus(itemId, newStatus) {
      if (!itemId) return;
      if (!newStatus || newStatus === "NONE") {
        delete userTracker[itemId];
        showToast("Removed from shortlist");
      } else if (TRACKED_STATUSES.includes(newStatus)) {
        userTracker[itemId] = newStatus;
        const labels = {
          SHORTLISTED: "Added to Shortlist",
          IN_PROGRESS: "Marked In Progress",
          APPLIED: "Marked Applied"
        };
        showToast(labels[newStatus] || "Status updated");
      }
      saveUserTracker();
      renderApp();
    }

    function getFilteredAndSortedItems() {
      reconcileAutoClosedStatuses();
      const q = appState.searchQuery.trim().toLowerCase();

      let sourcePool;
      if (appState.statusTab === "ALLIED") {
        sourcePool = OTHER_EXAMS_DATA;
      } else if (appState.statusTab === "MY_TRACKED" || appState.statusTab === "ALL") {
        sourcePool = getAllSourcesCombined();
      } else {
        sourcePool = ADMISSIONS_DATA;
      }
      const filtered = sourcePool.filter((item) => {
        if (appState.statusTab === "OPEN" && item.status !== "OPEN") return false;
        if (appState.statusTab === "IMMINENT" && item.status !== "IMMINENT") return false;
        if (appState.statusTab === "UPCOMING" && item.status !== "UPCOMING") return false;
        if (appState.statusTab === "CLOSED" && item.status !== "CLOSED") return false;
        if (appState.statusTab === "MY_TRACKED" && !isTrackedStatus(userTracker[item.id])) return false;

        if (appState.statusTab === "ALLIED") {
          if (appState.otherCategoryFilter === "OPEN_ONLY") {
            if (item.status !== "OPEN") return false;
          } else if (appState.otherCategoryFilter !== "ALL" && item.categoryCode !== appState.otherCategoryFilter) {
            return false;
          }
        }

        if (appState.tierFilter === "KARNATAKA") {
          if (!item.isKarnataka) return false;
        } else if (appState.tierFilter !== "ALL" && item.tierCode !== appState.tierFilter) {
          return false;
        }

        if (appState.routeFilter !== "ALL" && !item.routes.includes(appState.routeFilter)) return false;

        if (q) {
          const hay = [
            item.id,
            item.name,
            item.shortTag,
            item.tierLabel,
            item.routesText,
            item.feeOrNotes,
            item.deadlineText,
            item.priority
          ].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      const statusOrder = { OPEN: 1, IMMINENT: 2, UPCOMING: 3, CLOSED: 4 };
      const tierOrder = { TIER_1: 1, TIER_2: 2, TIER_3: 3 };

      filtered.sort((a, b) => {
        if (appState.sortBy === "STATUS_PRIORITY") {
          const sDiff = (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9);
          if (sDiff !== 0) return sDiff;
          const tDiff = (tierOrder[a.tierCode] || 9) - (tierOrder[b.tierCode] || 9);
          if (tDiff !== 0) return tDiff;
          if (a.status === "OPEN" && b.status === "OPEN") {
            const da = a.deadlineIso ? new Date(a.deadlineIso).getTime() : Number.MAX_SAFE_INTEGER;
            const db = b.deadlineIso ? new Date(b.deadlineIso).getTime() : Number.MAX_SAFE_INTEGER;
            if (da !== db) return da - db;
          }
          return 0;
        }
        if (appState.sortBy === "TIER_ASC") {
          const tDiff = (tierOrder[a.tierCode] || 9) - (tierOrder[b.tierCode] || 9);
          if (tDiff !== 0) return tDiff;
          return (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9);
        }
        if (appState.sortBy === "DEADLINE_ASC") {
          const da = a.deadlineIso ? new Date(a.deadlineIso).getTime() : Number.MAX_SAFE_INTEGER;
          const db = b.deadlineIso ? new Date(b.deadlineIso).getTime() : Number.MAX_SAFE_INTEGER;
          if (da !== db) return da - db;
          return (tierOrder[a.tierCode] || 9) - (tierOrder[b.tierCode] || 9);
        }
        if (appState.sortBy === "NAME_ASC") {
          return a.name.localeCompare(b.name);
        }
        return 0;
      });

      return filtered;
    }

    function getStatusBadgeHtml(item) {
      if (item.status === "OPEN") {
        return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-emerald-50 text-emerald-800 border border-emerald-200">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-600"></span>Open
        </span>`;
      }
      if (item.status === "IMMINENT") {
        return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>Opening Soon
        </span>`;
      }
      if (item.status === "CLOSED") {
        return `<span class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200">Closed</span>`;
      }
      return `<span class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-slate-50 text-slate-600 border border-slate-200">Upcoming</span>`;
    }

    function getTierBadgeHtml(item) {
      const safeTierLabel = escapeHtml(item.tierLabel);
      if (item.tierCode === "TIER_1") {
        return `<span class="tier-1-badge text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-amber-50 text-amber-800 border border-amber-200">${safeTierLabel}</span>`;
      }
      if (item.tierCode === "TIER_2") {
        return `<span class="tier-2-badge text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-sky-50 text-sky-800 border border-sky-200">${safeTierLabel}</span>`;
      }
      return `<span class="tier-3-badge text-[10px] font-medium px-1.5 py-0.5 rounded-sm bg-slate-100 text-slate-600 border border-slate-200">${safeTierLabel}</span>`;
    }

    function getCountdownPillHtml(item) {
      const days = getDaysRemaining(item.deadlineIso);
      if (days === null) {
        if (item.status === "OPEN") {
          return `<span class="px-1.5 py-0.5 rounded-sm text-[10px] font-medium text-slate-500 bg-slate-100">Rolling</span>`;
        }
        return "";
      }
      if (days < 0) {
        return `<span class="px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-rose-50 text-rose-700 border border-rose-200">Closed</span>`;
      }
      if (days === 0) {
        return `<span class="px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-rose-600 text-white">Today</span>`;
      }
      if (days <= 14) {
        return `<span class="px-1.5 py-0.5 rounded-sm text-[10px] font-semibold bg-amber-50 text-amber-800 border border-amber-200">${days}d left</span>`;
      }
      return `<span class="px-1.5 py-0.5 rounded-sm text-[10px] font-medium text-slate-600 bg-slate-50 border border-slate-200">${days}d left</span>`;
    }

    function getRoutesBadgesHtml(item) {
      if (item.routes && item.routes.length) {
        return item.routes.map((rt) => {
          return `<span class="inline-block px-1.5 py-0.5 rounded-sm text-[10px] font-medium bg-slate-50 text-slate-600 border border-slate-200 whitespace-nowrap mr-1">${escapeHtml(rt)}</span>`;
        }).join("");
      }
      return `<span class="text-slate-500 text-[11px]">${escapeHtml(item.routesText || "Direct")}</span>`;
    }

    function renderCards(items) {
      const container = document.getElementById("cards-view-container");
      container.innerHTML = items.map((item) => {
        const rawSt = userTracker[item.id];
        const myStatus = isTrackedStatus(rawSt) ? rawSt : "NONE";
        const isOpen = item.status === "OPEN";
        const isClosed = item.status === "CLOSED";
        const cardBorder = isOpen
          ? "border-slate-300 border-l-2 border-l-emerald-600"
          : isClosed
          ? "border-slate-200 opacity-75"
          : "border-slate-200";

        const safeId = escapeHtml(item.id);
        const safeName = escapeHtml(item.name);
        const safeRoutesText = escapeHtml(item.routesText);
        const safeOpenDate = escapeHtml(item.openDate);
        const safeDeadlineText = escapeHtml(item.deadlineText);
        const safeExamWindow = escapeHtml(item.examWindow);
        const safeNotes = escapeHtml(item.feeOrNotes);
        const safeOfficialUrl = escapeHtml(sanitizeUrl(item.officialUrl));
        const safeApplyUrl = escapeHtml(sanitizeUrl(item.applyUrl));

        return `
          <article class="bg-white rounded border ${cardBorder} hover:border-slate-300 transition-colors flex flex-col justify-between">
            <div class="p-3.5 space-y-2.5">
              <!-- Top Row: Status + Countdown & Tier -->
              <div class="flex items-center justify-between gap-2">
                <div class="flex items-center gap-1.5">
                  ${getStatusBadgeHtml(item)}
                  ${getCountdownPillHtml(item)}
                </div>
                ${getTierBadgeHtml(item)}
              </div>

              <!-- Title & Route Tags -->
              <div>
                <h3 class="text-sm font-semibold text-slate-900 leading-snug" title="${safeName}">
                  ${safeName}
                </h3>
                <div class="mt-1.5 flex items-center flex-wrap gap-y-1" title="${safeRoutesText}">
                  ${getRoutesBadgesHtml(item)}
                </div>
              </div>

              <!-- Compact Key Dates Strip -->
              <div class="grid grid-cols-2 gap-2 pt-2 border-t border-slate-100 text-xs">
                <div>
                  <span class="text-[10px] text-slate-400 block">${isOpen ? 'Deadline' : 'Opens / Deadline'}</span>
                  <span class="font-medium ${isOpen ? 'text-emerald-800' : 'text-slate-800'} mt-0.5 block truncate" title="Opens: ${safeOpenDate} • Deadline: ${safeDeadlineText}">
                    ${isOpen ? safeDeadlineText : safeOpenDate}
                  </span>
                </div>
                <div>
                  <span class="text-[10px] text-slate-400 block">Exam / Counselling</span>
                  <span class="text-slate-700 mt-0.5 block truncate" title="${safeExamWindow}">${safeExamWindow}</span>
                </div>
              </div>

              <!-- Concise Notes (2-line clamp, full on hover) -->
              <p class="text-[11px] text-slate-500 leading-relaxed line-clamp-2" title="${safeNotes}">
                ${safeNotes}
              </p>
            </div>

            <!-- Single-Row Card Footer -->
            <div class="px-3.5 py-2 bg-slate-50/50 border-t border-slate-100 flex items-center justify-between gap-2">
              <select
                data-track-id="${safeId}"
                aria-label="Track application status"
                class="track-select text-[11px] font-medium rounded-sm border px-1.5 py-1 focus:outline-none ${
                  myStatus === 'APPLIED'
                    ? 'bg-emerald-50 border-emerald-300 text-emerald-900'
                    : myStatus === 'IN_PROGRESS'
                    ? 'bg-amber-50 border-amber-300 text-amber-900'
                    : myStatus === 'SHORTLISTED'
                    ? 'bg-indigo-50 border-indigo-300 text-indigo-900'
                    : 'bg-white border-slate-200 text-slate-600'
                }"
              >
                <option value="NONE" ${myStatus === 'NONE' ? 'selected' : ''}>Track</option>
                <option value="SHORTLISTED" ${myStatus === 'SHORTLISTED' ? 'selected' : ''}>Shortlisted</option>
                <option value="IN_PROGRESS" ${myStatus === 'IN_PROGRESS' ? 'selected' : ''}>In Progress</option>
                <option value="APPLIED" ${myStatus === 'APPLIED' ? 'selected' : ''}>Applied</option>
              </select>

              <div class="flex items-center gap-1.5">
                <a
                  href="${safeOfficialUrl}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="px-2 py-1 rounded-sm text-[11px] font-medium border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 transition"
                >
                  Official
                </a>
                <a
                  href="${safeApplyUrl}"
                  target="_blank"
                  rel="noopener noreferrer"
                  class="px-2.5 py-1 rounded-sm text-[11px] font-medium transition ${
                    isOpen
                      ? 'bg-emerald-700 hover:bg-emerald-600 text-white'
                      : 'bg-slate-900 hover:bg-slate-800 text-white'
                  }"
                >
                  ${isOpen ? 'Apply ↗' : 'Portal ↗'}
                </a>
              </div>
            </div>
          </article>
        `;
      }).join("");
    }

    function getCompactStatusBadgeHtml(item) {
      if (item.status === "OPEN") {
        return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-emerald-50 text-emerald-800 border border-emerald-200 whitespace-nowrap">
          <span class="w-1.5 h-1.5 rounded-full bg-emerald-600"></span>Open
        </span>`;
      }
      if (item.status === "IMMINENT") {
        return `<span class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-amber-50 text-amber-800 border border-amber-200 whitespace-nowrap">
          <span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span>Soon
        </span>`;
      }
      if (item.status === "CLOSED") {
        return `<span class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-slate-100 text-slate-600 border border-slate-200 whitespace-nowrap">Closed</span>`;
      }
      return `<span class="inline-flex items-center px-1.5 py-0.5 rounded-sm text-[11px] font-medium bg-slate-50 text-slate-600 border border-slate-200 whitespace-nowrap">Upcoming</span>`;
    }

    function renderTable(items) {
      const tbody = document.getElementById("table-body-rows");
      tbody.innerHTML = items.map((item) => {
        const rawSt = userTracker[item.id];
        const myStatus = isTrackedStatus(rawSt) ? rawSt : "NONE";
        const isOpen = item.status === "OPEN";
        const isClosed = item.status === "CLOSED";

        const safeId = escapeHtml(item.id);
        const safeName = escapeHtml(item.name);
        const safeShortTag = escapeHtml(item.shortTag || item.name);
        const safeRoutesText = escapeHtml(item.routesText);
        const safeOpenDate = escapeHtml(item.openDate);
        const safeDeadlineText = escapeHtml(item.deadlineText);
        const safeNotes = escapeHtml(item.feeOrNotes);
        const safeOfficialUrl = escapeHtml(sanitizeUrl(item.officialUrl));
        const safeApplyUrl = escapeHtml(sanitizeUrl(item.applyUrl));

        return `
          <tr class="hover:bg-slate-50/70 transition-colors">
            <td class="py-2 px-3 whitespace-nowrap align-middle">
              ${getCompactStatusBadgeHtml(item)}
            </td>
            <td class="py-2 px-3 align-middle min-w-[220px] max-w-[300px]" title="${safeNotes}">
              <div class="font-medium text-slate-900 leading-tight">${safeShortTag}</div>
              <div class="text-[11px] text-slate-500 truncate" title="${safeName}">${safeName}</div>
            </td>
            <td class="py-2 px-3 whitespace-nowrap align-middle">
              ${getTierBadgeHtml(item)}
            </td>
            <td class="py-2 px-3 whitespace-nowrap align-middle" title="${safeRoutesText}">
              ${getRoutesBadgesHtml(item)}
            </td>
            <td class="py-2 px-3 whitespace-nowrap align-middle text-slate-600 text-xs">
              ${safeOpenDate}
            </td>
            <td class="py-2 px-3 whitespace-nowrap align-middle">
              <div class="flex items-center gap-1.5 whitespace-nowrap">
                <span class="font-medium text-xs ${isOpen ? 'text-emerald-800' : isClosed ? 'text-rose-800' : 'text-slate-800'}">${safeDeadlineText}</span>
                ${item.deadlineIso ? getCountdownPillHtml(item) : ''}
              </div>
            </td>
            <td class="py-2 px-3 whitespace-nowrap align-middle">
              <select
                data-track-id="${safeId}"
                class="track-select text-[11px] font-medium rounded-sm border border-slate-200 px-1.5 py-0.5 bg-white focus:outline-none"
              >
                <option value="NONE" ${myStatus === 'NONE' ? 'selected' : ''}>Track</option>
                <option value="SHORTLISTED" ${myStatus === 'SHORTLISTED' ? 'selected' : ''}>Shortlisted</option>
                <option value="IN_PROGRESS" ${myStatus === 'IN_PROGRESS' ? 'selected' : ''}>In Progress</option>
                <option value="APPLIED" ${myStatus === 'APPLIED' ? 'selected' : ''}>Applied</option>
              </select>
            </td>
            <td class="py-2 px-3 whitespace-nowrap align-middle text-right space-x-1">
              <a
                href="${safeOfficialUrl}"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center px-2 py-0.5 rounded-sm border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 font-medium text-[11px]"
              >
                Info
              </a>
              <a
                href="${safeApplyUrl}"
                target="_blank"
                rel="noopener noreferrer"
                class="inline-flex items-center px-2 py-0.5 rounded-sm font-medium text-white text-[11px] ${
                  isOpen ? 'bg-emerald-700 hover:bg-emerald-600' : 'bg-slate-900 hover:bg-slate-800'
                }"
              >
                ${isOpen ? 'Apply ↗' : 'Portal ↗'}
              </a>
            </td>
          </tr>
        `;
      }).join("");
    }

    function renderSiteBanner() {
      const cfg = appState.siteConfig || {};
      const titleEl = document.getElementById("banner-title");
      if (titleEl && cfg.active_banner_title) titleEl.textContent = cfg.active_banner_title;
      const textEl = document.getElementById("banner-text");
      if (textEl && cfg.active_banner_text) textEl.innerHTML = cfg.active_banner_text;
      const linkEl = document.getElementById("banner-link");
      if (linkEl && cfg.active_banner_url) linkEl.href = cfg.active_banner_url;
      const btnEl = document.getElementById("banner-btn-text");
      if (btnEl && cfg.active_banner_btn_text) btnEl.textContent = cfg.active_banner_btn_text;
    }

    function renderRemindersModalTable() {
      const allSources = getAllSourcesCombined();
      const fixedDeadlineItems = allSources.filter((item) => Boolean(item.deadlineIso));
      fixedDeadlineItems.sort((a, b) => new Date(a.deadlineIso) - new Date(b.deadlineIso));

      const tbody = document.getElementById("reminders-table-body");
      if (!tbody) return;

      tbody.innerHTML = fixedDeadlineItems.map((item) => {
        const dIso = item.deadlineIso;
        const calcDate = (days) => {
          const dt = new Date(dIso + "T00:00:00+05:30");
          dt.setDate(dt.getDate() - days);
          const yyyy = dt.getFullYear();
          const mm = String(dt.getMonth() + 1).padStart(2, "0");
          const dd = String(dt.getDate()).padStart(2, "0");
          return `${yyyy}-${mm}-${dd}`;
        };
        const daysLeft = getDaysRemaining(dIso);
        const rowClass = daysLeft !== null && daysLeft <= 3 ? "bg-amber-50/60" : "";
        return `
          <tr class="${rowClass}">
            <td class="py-2 px-3 font-medium text-slate-900">${escapeHtml(item.shortTag || item.name)}</td>
            <td class="py-2 px-3 font-mono font-semibold text-emerald-700">${escapeHtml(dIso)}</td>
            <td class="py-2 px-3 font-mono text-slate-500">${calcDate(14)}</td>
            <td class="py-2 px-3 font-mono text-slate-500">${calcDate(7)}</td>
            <td class="py-2 px-3 font-mono text-slate-500">${calcDate(3)}</td>
            <td class="py-2 px-3 font-mono text-slate-500">${calcDate(1)}</td>
            <td class="py-2 px-3 font-mono font-semibold text-rose-700">${dIso}</td>
          </tr>
        `;
      }).join("");
    }

    function updateMetricsAndTabs() {
      reconcileAutoClosedStatuses();

      const openItems = ADMISSIONS_DATA.filter((i) => i.status === "OPEN");
      const imminentItems = ADMISSIONS_DATA.filter((i) => i.status === "IMMINENT");
      const upcomingItems = ADMISSIONS_DATA.filter((i) => i.status === "UPCOMING");
      const closedItems = ADMISSIONS_DATA.filter((i) => i.status === "CLOSED");

      const t1Items = ADMISSIONS_DATA.filter((i) => i.tierCode === "TIER_1");
      const t2Items = ADMISSIONS_DATA.filter((i) => i.tierCode === "TIER_2");
      const t3Items = ADMISSIONS_DATA.filter((i) => i.tierCode === "TIER_3");
      const kaItems = ADMISSIONS_DATA.filter((i) => i.isKarnataka);

      const openCount = openItems.length;
      const imminentCount = imminentItems.length;
      const upcomingCount = upcomingItems.length;
      const closedCount = closedItems.length;
      const totalCount = ADMISSIONS_DATA.length;
      const kaOpenCount = kaItems.filter((i) => i.status === "OPEN").length;
      const fixedDeadlineOpenCount = openItems.filter((i) => Boolean(i.deadlineIso)).length;

      const trackedIds = getTrackedIds();
      const appliedIds = trackedIds.filter((id) => userTracker[id] === "APPLIED");
      const appliedOpenCount = openItems.filter((i) => userTracker[i.id] === "APPLIED").length;

      document.getElementById("kpi-open-count").textContent = String(openCount);
      document.getElementById("kpi-open-sub").textContent = `${fixedDeadlineOpenCount} Fixed • ${openCount - fixedDeadlineOpenCount} Rolling`;
      document.getElementById("kpi-open-list").textContent = openItems.map((i) => i.shortTag).join(", ");

      document.getElementById("kpi-imminent-count").textContent = String(imminentCount);
      document.getElementById("kpi-imminent-list").textContent = imminentItems.map((i) => i.shortTag).join(", ");

      document.getElementById("kpi-ka-count").textContent = String(kaItems.length);
      document.getElementById("kpi-ka-open-sub").textContent = `${kaOpenCount} Open`;

      document.getElementById("kpi-total-count").textContent = String(totalCount);

      const syncBadge = document.getElementById("kpi-sync-badge");
      const syncSub = document.getElementById("kpi-sync-sub");
      if (appState.syncStatus === "LIVE_SYNCED") {
        syncBadge.textContent = "Synced";
        syncBadge.className = "text-[10px] text-emerald-700 font-medium";
        syncSub.textContent = `${appState.lastSyncedCount} Total`;
      } else if (appState.syncStatus === "SYNCING") {
        syncBadge.textContent = "Syncing";
        syncBadge.className = "text-[10px] text-amber-700 font-medium";
        syncSub.textContent = "Updating...";
      } else {
        syncBadge.textContent = "Snapshot";
        syncBadge.className = "text-[10px] text-slate-400 font-medium";
        syncSub.textContent = `${t1Items.length} T1 • ${t2Items.length} T2 • ${t3Items.length} T3`;
      }

      document.getElementById("kpi-tracked-count").textContent = String(trackedIds.length);
      document.getElementById("kpi-applied-pill").textContent = `${appliedIds.length} Applied`;
      document.getElementById("kpi-progress-label").textContent = `${appliedOpenCount}/${openCount} Open Applied`;
      const pct = openCount > 0 ? Math.min(100, Math.round((appliedOpenCount / openCount) * 100)) : 0;
      document.getElementById("kpi-progress-bar").style.width = `${pct}%`;

      document.getElementById("tab-btn-open").textContent = `Open Now (${openCount})`;
      document.getElementById("tab-btn-imminent").textContent = `Opening Soon (${imminentCount})`;
      document.getElementById("tab-btn-upcoming").textContent = `Upcoming (${upcomingCount})`;
      const alliedBtn = document.getElementById("tab-btn-allied");
      if (alliedBtn) {
        alliedBtn.textContent = `Allied UG Exams (${OTHER_EXAMS_DATA.length})`;
      }
      const alliedBar = document.getElementById("allied-category-filter-bar");
      if (alliedBar) {
        if (appState.statusTab === "ALLIED") {
          alliedBar.classList.remove("hidden");
          alliedBar.classList.add("flex");
        } else {
          alliedBar.classList.add("hidden");
          alliedBar.classList.remove("flex");
        }
      }
      document.getElementById("tab-btn-closed").textContent = `Closed (${closedCount})`;
      document.getElementById("tab-btn-all").textContent = `All Sources (${totalCount})`;
      document.getElementById("tab-btn-tracked").textContent = `My Shortlist (${trackedIds.length})`;

      const closedTabBtn = document.getElementById("tab-btn-closed");
      if (closedCount === 0 && appState.statusTab !== "CLOSED") {
        closedTabBtn.classList.add("hidden");
      } else {
        closedTabBtn.classList.remove("hidden");
      }

      const alliedTotal = OTHER_EXAMS_DATA.length;
      const spaceCount = OTHER_EXAMS_DATA.filter((x) => x.categoryCode === "SPACE_RESEARCH").length;
      const mgmtCount = OTHER_EXAMS_DATA.filter((x) => x.categoryCode === "MANAGEMENT").length;
      const centralCount = OTHER_EXAMS_DATA.filter((x) => x.categoryCode === "CENTRAL_UNIV").length;
      const designCount = OTHER_EXAMS_DATA.filter((x) => x.categoryCode === "DESIGN_ARCH").length;
      const defenceCount = OTHER_EXAMS_DATA.filter((x) => x.categoryCode === "DEFENCE").length;
      const alliedOpenCount = OTHER_EXAMS_DATA.filter((x) => x.status === "OPEN").length;

      document.querySelectorAll(".other-cat-btn").forEach((btn) => {
        const cat = btn.getAttribute("data-other-cat");
        if (cat === "ALL") btn.textContent = `All (${alliedTotal})`;
        else if (cat === "SPACE_RESEARCH") btn.textContent = `Space & Research (${spaceCount})`;
        else if (cat === "MANAGEMENT") btn.textContent = `Management (${mgmtCount})`;
        else if (cat === "CENTRAL_UNIV") btn.textContent = `Central & Liberal (${centralCount})`;
        else if (cat === "DESIGN_ARCH") btn.textContent = `Design & Arch (${designCount})`;
        else if (cat === "DEFENCE") btn.textContent = `Defence (${defenceCount})`;
        else if (cat === "OPEN_ONLY") btn.textContent = `Open Now (${alliedOpenCount})`;
      });

      document.getElementById("opt-tier-all").textContent = `All Tiers & Regions (${totalCount})`;
      document.getElementById("opt-tier-1").textContent = `Tier 1 (${t1Items.length})`;
      document.getElementById("opt-tier-2").textContent = `Tier 2 (${t2Items.length})`;
      document.getElementById("opt-tier-3").textContent = `Tier 3 (${t3Items.length})`;
      document.getElementById("opt-tier-ka").textContent = `Karnataka & Bengaluru (${kaItems.length})`;

      document.getElementById("btn-reset-filters").textContent = "Reset Filters";
      document.getElementById("btn-empty-reset").textContent = "Show All Monitored Sources";

      document.querySelectorAll(".status-tab").forEach((btn) => {
        const tab = btn.getAttribute("data-status-tab");
        const isSelected = tab === appState.statusTab;
        btn.setAttribute("aria-selected", isSelected ? "true" : "false");
        const hiddenClass = (tab === "CLOSED" && closedCount === 0) ? " hidden" : "";
        if (isSelected) {
          btn.className = "status-tab px-2.5 py-1 rounded-sm text-xs font-semibold bg-slate-900 text-white transition" + hiddenClass;
        } else {
          btn.className = "status-tab px-2.5 py-1 rounded-sm text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 transition" + hiddenClass;
        }
      });

      const btnCards = document.getElementById("btn-view-cards");
      const btnTable = document.getElementById("btn-view-table");
      if (appState.viewMode === "CARDS") {
        btnCards.className = "px-2 py-0.5 rounded-sm text-xs font-medium bg-white text-slate-900 shadow-xs transition";
        btnTable.className = "px-2 py-0.5 rounded-sm text-xs font-medium text-slate-600 hover:text-slate-900 transition";
      } else {
        btnTable.className = "px-2 py-0.5 rounded-sm text-xs font-medium bg-white text-slate-900 shadow-xs transition";
        btnCards.className = "px-2 py-0.5 rounded-sm text-xs font-medium text-slate-600 hover:text-slate-900 transition";
      }
    }

    function getFilteredOtherExams() {
      reconcileAutoClosedStatuses();
      const q = appState.searchQuery.trim().toLowerCase();
      const statusOrder = { OPEN: 1, IMMINENT: 2, UPCOMING: 3, CLOSED: 4 };
      const tierOrder = { TIER_1: 1, TIER_2: 2, TIER_3: 3 };

      const list = OTHER_EXAMS_DATA.filter((item) => {
        if (appState.otherCategoryFilter === "OPEN_ONLY") {
          if (item.status !== "OPEN") return false;
        } else if (appState.otherCategoryFilter !== "ALL" && item.categoryCode !== appState.otherCategoryFilter) {
          return false;
        }
        if (q) {
          const hay = [
            item.id,
            item.name,
            item.shortTag,
            item.categoryLabel,
            item.tierLabel,
            item.routesText,
            item.feeOrNotes,
            item.deadlineText,
            item.priority
          ].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      list.sort((a, b) => {
        const sDiff = (statusOrder[a.status] || 9) - (statusOrder[b.status] || 9);
        if (sDiff !== 0) return sDiff;
        return (tierOrder[a.tierCode] || 9) - (tierOrder[b.tierCode] || 9);
      });
      return list;
    }

    function renderOtherExamsSection() {
      document.querySelectorAll(".other-cat-btn").forEach((btn) => {
        const cat = btn.getAttribute("data-other-cat");
        if (cat === appState.otherCategoryFilter) {
          btn.className = "other-cat-btn px-2 py-0.5 rounded-sm text-[11px] font-semibold bg-slate-900 text-white transition";
        } else {
          btn.className = "other-cat-btn px-2 py-0.5 rounded-sm text-[11px] font-medium bg-slate-50 text-slate-700 border border-slate-200 hover:bg-slate-100 transition";
        }
      });
    }

    function renderApp() {
      updateFooterAndModalVerification();
      renderSiteBanner();
      renderRemindersModalTable();
      const filtered = getFilteredAndSortedItems();
      updateMetricsAndTabs();
      renderOtherExamsSection();

      const summaryEl = document.getElementById("results-summary-text");
      const statusLabels = {
        OPEN: "open applications",
        IMMINENT: "opening soon (Nov–Dec 2026)",
        ALL: "monitored sources",
        UPCOMING: "upcoming 2027 portals",
        CLOSED: "closed applications",
        ALLIED: "allied UG entrance exams",
        MY_TRACKED: "shortlisted / applied sources"
      };
      const filterSuffix = [];
      if (appState.tierFilter === "KARNATAKA") {
        filterSuffix.push("Karnataka & BLR");
      } else if (appState.tierFilter !== "ALL") {
        filterSuffix.push(appState.tierFilter.replace("_", " "));
      }
      if (appState.routeFilter !== "ALL") filterSuffix.push(appState.routeFilter);
      if (appState.searchQuery.trim()) filterSuffix.push(`"${appState.searchQuery.trim()}"`);
      const suffixText = filterSuffix.length > 0 ? ` • ${filterSuffix.join(" • ")}` : "";
      summaryEl.textContent = `${filtered.length} ${statusLabels[appState.statusTab] || "sources"}${suffixText}`;

      const cardsContainer = document.getElementById("cards-view-container");
      const tableContainer = document.getElementById("table-view-container");
      const emptyState = document.getElementById("empty-state");

      if (filtered.length === 0) {
        cardsContainer.classList.add("hidden");
        tableContainer.classList.add("hidden");
        emptyState.classList.remove("hidden");
        const matchingOther = getFilteredOtherExams().length;
        const emptyDesc = document.getElementById("empty-state-desc");
        if (emptyDesc && matchingOther > 0 && appState.searchQuery.trim()) {
          emptyDesc.textContent = `Found ${matchingOther} matching exam(s) under the Allied UG Exams tab.`;
        }
      } else {
        emptyState.classList.add("hidden");
        if (appState.viewMode === "CARDS") {
          tableContainer.classList.add("hidden");
          cardsContainer.classList.remove("hidden");
          renderCards(filtered);
        } else {
          cardsContainer.classList.add("hidden");
          tableContainer.classList.remove("hidden");
          renderTable(filtered);
        }
      }

      // Application tracking select changes are handled via global delegated listener
    }

    function exportCurrentViewCsv() {
      const items = getFilteredAndSortedItems().concat(getFilteredOtherExams());
      const headers = [
        "Event_ID",
        "Status",
        "Window_or_Priority",
        "Institution_or_Exam",
        "Institutional_Tier",
        "Accepted_Routes",
        "Open_Date",
        "Deadline",
        "Exam_or_Counselling_Window",
        "My_Application_Status",
        "Last_Verified",
        "Official_Website",
        "Direct_Apply_Portal"
      ];
      const rows = items.map((item) => {
        const rawSt = userTracker[item.id];
        const mySt = isTrackedStatus(rawSt) ? rawSt : "NOT_TRACKED";
        return [
          sanitizeCsvCell(item.id),
          sanitizeCsvCell(item.status),
          sanitizeCsvCell(item.priority),
          sanitizeCsvCell(item.name),
          sanitizeCsvCell(item.tierLabel),
          sanitizeCsvCell(item.routesText),
          sanitizeCsvCell(item.openDate),
          sanitizeCsvCell(item.deadlineText),
          sanitizeCsvCell(item.examWindow),
          sanitizeCsvCell(mySt),
          sanitizeCsvCell(item.lastVerified),
          sanitizeCsvCell(sanitizeUrl(item.officialUrl)),
          sanitizeCsvCell(sanitizeUrl(item.applyUrl))
        ];
      });
      const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "indian_engineering_admissions_2027_tracker.csv";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`Exported ${items.length} sources to CSV`);
    }

    function updateIstClock() {
      const clockEl = document.getElementById("live-ist-clock");
      if (!clockEl) return;
      try {
        const now = new Date();
        const formatted = new Intl.DateTimeFormat("en-IN", {
          timeZone: "Asia/Kolkata",
          month: "short",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        }).format(now);
        clockEl.textContent = `${formatted} IST`;
      } catch (e) {
        clockEl.textContent = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
      }
    }

    function loadFallbackSnapshot() {
      try {
        const snapEl = document.getElementById("embedded-fallback-data");
        if (snapEl) {
          const snap = JSON.parse(snapEl.textContent);
          if (snap.admissions && snap.admissions.length) {
            ADMISSIONS_DATA = snap.admissions;
          }
          if (snap.allied && snap.allied.length) {
            OTHER_EXAMS_DATA = snap.allied;
          }
          if (snap.siteConfig) {
            appState.siteConfig = snap.siteConfig;
          }
          if (snap.snapshotDate) {
            appState.snapshotDate = snap.snapshotDate;
          }
        }
      } catch (e) {
        console.error("Could not parse fallback snapshot JSON", e);
      }
    }

    document.addEventListener("DOMContentLoaded", () => {
      const THEME_KEY = "eng_admissions_theme_2027";
      const themeBtn = document.getElementById("btn-theme-toggle");
      const themeIcon = document.getElementById("theme-toggle-icon");
      const themeLabel = document.getElementById("theme-toggle-label");

      function applyTheme(isDark) {
        if (isDark) {
          document.documentElement.classList.add("dark");
          if (themeIcon) themeIcon.textContent = "☀️";
          if (themeLabel) themeLabel.textContent = "Light";
        } else {
          document.documentElement.classList.remove("dark");
          if (themeIcon) themeIcon.textContent = "🌙";
          if (themeLabel) themeLabel.textContent = "Dark";
        }
      }

      let savedTheme = null;
      try {
        savedTheme = localStorage.getItem(THEME_KEY);
      } catch (e) {}
      applyTheme(savedTheme === "dark");

      if (themeBtn) {
        themeBtn.addEventListener("click", () => {
          const isNowDark = !document.documentElement.classList.contains("dark");
          applyTheme(isNowDark);
          try {
            localStorage.setItem(THEME_KEY, isNowDark ? "dark" : "light");
          } catch (e) {}
        });
      }

      loadFallbackSnapshot();
      loadUserTracker();
      updateIstClock();
      setInterval(updateIstClock, 1000);

      // Restore previously selected tab across refresh
      try {
        const savedTab = localStorage.getItem(TAB_STORAGE_KEY) || sessionStorage.getItem(TAB_STORAGE_KEY);
        if (savedTab && ["OPEN", "IMMINENT", "UPCOMING", "ALLIED", "CLOSED", "ALL", "MY_TRACKED"].includes(savedTab)) {
          appState.statusTab = savedTab;
        }
      } catch (e) {}

      document.querySelectorAll(".status-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
          appState.statusTab = btn.getAttribute("data-status-tab") || "ALL";
          appState.previousTabBeforeSearch = null;
          try {
            localStorage.setItem(TAB_STORAGE_KEY, appState.statusTab);
            sessionStorage.setItem(TAB_STORAGE_KEY, appState.statusTab);
          } catch (e) {}
          renderApp();
        });
      });

      document.querySelectorAll(".kpi-card").forEach((card) => {
        card.addEventListener("click", () => {
          const target = card.getAttribute("data-kpi-status");
          appState.routeFilter = "ALL";
          appState.searchQuery = "";
          appState.previousTabBeforeSearch = null;
          document.getElementById("filter-route").value = "ALL";
          document.getElementById("search-input").value = "";
          document.getElementById("btn-clear-search").classList.add("hidden");

          if (target === "KARNATAKA") {
            appState.statusTab = "ALL";
            appState.tierFilter = "KARNATAKA";
            document.getElementById("filter-tier").value = "KARNATAKA";
          } else if (target) {
            appState.statusTab = target;
            appState.tierFilter = "ALL";
            document.getElementById("filter-tier").value = "ALL";
          }
          try {
            localStorage.setItem(TAB_STORAGE_KEY, appState.statusTab);
            sessionStorage.setItem(TAB_STORAGE_KEY, appState.statusTab);
          } catch (e) {}
          renderApp();
        });
      });

      const searchInput = document.getElementById("search-input");
      const clearBtn = document.getElementById("btn-clear-search");
      searchInput.addEventListener("input", (e) => {
        const val = e.target.value;
        appState.searchQuery = val;
        if (val.trim().length > 0) {
          clearBtn.classList.remove("hidden");
          if (getFilteredAndSortedItems().length === 0 && appState.statusTab !== "ALL") {
            if (!appState.previousTabBeforeSearch) {
              appState.previousTabBeforeSearch = appState.statusTab;
            }
            appState.statusTab = "ALL";
          }
        } else {
          clearBtn.classList.add("hidden");
          if (appState.previousTabBeforeSearch) {
            appState.statusTab = appState.previousTabBeforeSearch;
            appState.previousTabBeforeSearch = null;
          }
        }
        renderApp();
      });

      clearBtn.addEventListener("click", () => {
        searchInput.value = "";
        appState.searchQuery = "";
        clearBtn.classList.add("hidden");
        if (appState.previousTabBeforeSearch) {
          appState.statusTab = appState.previousTabBeforeSearch;
          appState.previousTabBeforeSearch = null;
        }
        renderApp();
      });

      document.getElementById("filter-tier").addEventListener("change", (e) => {
        appState.tierFilter = e.target.value;
        renderApp();
      });

      document.getElementById("filter-route").addEventListener("change", (e) => {
        appState.routeFilter = e.target.value;
        renderApp();
      });

      document.getElementById("sort-select").addEventListener("change", (e) => {
        appState.sortBy = e.target.value;
        renderApp();
      });

      document.getElementById("btn-view-cards").addEventListener("click", () => {
        appState.viewMode = "CARDS";
        renderApp();
      });
      document.getElementById("btn-view-table").addEventListener("click", () => {
        appState.viewMode = "TABLE";
        renderApp();
      });

      const resetAll = () => {
        appState.statusTab = "ALL";
        appState.previousTabBeforeSearch = null;
        appState.otherCategoryFilter = "ALL";
        appState.tierFilter = "ALL";
        appState.routeFilter = "ALL";
        appState.searchQuery = "";
        searchInput.value = "";
        clearBtn.classList.add("hidden");
        document.getElementById("filter-tier").value = "ALL";
        document.getElementById("filter-route").value = "ALL";
        renderApp();
      };
      document.getElementById("btn-reset-filters").addEventListener("click", resetAll);
      document.getElementById("btn-empty-reset").addEventListener("click", resetAll);

      document.querySelectorAll(".other-cat-btn").forEach((btn) => {
        btn.addEventListener("click", () => {
          appState.otherCategoryFilter = btn.getAttribute("data-other-cat") || "ALL";
          renderApp();
        });
      });

      document.getElementById("btn-export-csv").addEventListener("click", exportCurrentViewCsv);

      const modal = document.getElementById("reminders-modal");
      const openModal = () => {
        modal.classList.remove("hidden");
        modal.classList.add("flex");
      };
      const closeModal = () => {
        modal.classList.add("hidden");
        modal.classList.remove("flex");
      };
      document.getElementById("btn-open-reminders").addEventListener("click", openModal);
      document.getElementById("btn-close-reminders").addEventListener("click", closeModal);
      document.getElementById("btn-close-reminders-footer").addEventListener("click", closeModal);
      modal.addEventListener("click", (e) => {
        if (e.target === modal) closeModal();
      });

      const SHEET_ID = "1khafXco2_PCS7ZGj4g4v2QrBYCT6ZHqCdCPktnt2YCs";
      window.google = window.google || {};
      window.google.visualization = window.google.visualization || {};
      window.google.visualization.Query = window.google.visualization.Query || {};

      window.__handleGoogleSheetSync = function(response) {
        try {
          if (!response || !response.table || !response.table.rows) return;
          const rows = response.table.rows;
          if (!rows.length) return;

          const colMap = {};
          if (response.table.cols) {
            response.table.cols.forEach((col, idx) => {
              if (col.label) colMap[col.label.trim().toLowerCase()] = idx;
              if (col.id) colMap[col.id.trim().toLowerCase()] = idx;
            });
          }

          let startRow = 0;
          if (rows[0] && rows[0].c && rows[0].c[0] && String(rows[0].c[0].v || "").trim() === "Event_ID") {
            rows[0].c.forEach((cell, idx) => {
              if (cell && cell.v) colMap[String(cell.v).trim().toLowerCase()] = idx;
            });
            startRow = 1;
          }

          const valByHeader = (r, headerName, fallback = "") => {
            const key = headerName.trim().toLowerCase();
            const idx = colMap[key];
            if (idx === undefined) return fallback;
            const cell = r.c && r.c[idx];
            if (!cell || cell.v === null || cell.v === undefined) return fallback;
            return String(cell.v).trim();
          };

          const newAdmissions = [];
          const newAllied = [];
          let sheetLastChecked = "";

          for (let rIdx = startRow; rIdx < rows.length; rIdx++) {
            const r = rows[rIdx];
            const eventId = valByHeader(r, "Event_ID");
            if (!eventId || eventId === "Event_ID") continue;

            const activeVal = valByHeader(r, "Active", "TRUE").toUpperCase();
            if (activeVal === "FALSE") continue;

            const regStatusRaw = valByHeader(r, "Registration_Status").toUpperCase();
            let mappedStatus = "UPCOMING";
            if (regStatusRaw.includes("CLOSED") || regStatusRaw.includes("ENDED") || regStatusRaw.includes("EXPIRED")) {
              mappedStatus = "CLOSED";
            } else if (regStatusRaw === "OPEN") {
              mappedStatus = "OPEN";
            } else if (regStatusRaw.includes("IMMINENT") || regStatusRaw.includes("OPENING SOON")) {
              mappedStatus = "IMMINENT";
            }

            const lastChecked = valByHeader(r, "Last_Checked_IST");
            if (lastChecked && !lastChecked.includes("Oct 27")) {
              sheetLastChecked = lastChecked;
            }

            const deadlineText = valByHeader(r, "Application_Deadline");
            let deadlineIso = valByHeader(r, "Deadline_ISO");
            if (!deadlineIso) {
              deadlineIso = parseSingleDeadlineIso(deadlineText);
            }

            const routesRaw = valByHeader(r, "Routes");
            const routesList = routesRaw
              ? routesRaw.split("|").map((s) => s.trim()).filter(Boolean)
              : [valByHeader(r, "Accepted_Routes", "See Official Portal")];

            const item = {
              id: eventId,
              name: valByHeader(r, "Institution_or_Exam"),
              shortTag: valByHeader(r, "Short_Tag") || valByHeader(r, "Institution_or_Exam").slice(0, 22),
              tierCode: valByHeader(r, "Tier_Code", "TIER_3"),
              tierLabel: valByHeader(r, "Tier_Label", "Tier 3"),
              isKarnataka: valByHeader(r, "Is_Karnataka", "FALSE").toUpperCase() === "TRUE",
              status: mappedStatus,
              priority: valByHeader(r, "Alert_Classification") || "MONITORED",
              routes: routesList,
              routesText: valByHeader(r, "Accepted_Routes") || "See Official Portal",
              openDate: valByHeader(r, "Application_Open_Date") || "TBA",
              deadlineText: deadlineText || "TBA",
              deadlineIso: deadlineIso || null,
              examWindow: valByHeader(r, "Exam_or_Counselling_Window") || "TBA",
              feeOrNotes: valByHeader(r, "Application_Fee_or_Notes") || "",
              officialUrl: sanitizeUrl(valByHeader(r, "Official_Website")),
              applyUrl: sanitizeUrl(valByHeader(r, "Application_Portal_URL") || valByHeader(r, "Official_Website")),
              lastVerified: lastChecked || "Live Synced",
              categoryCode: valByHeader(r, "Category_Code", ""),
              categoryLabel: valByHeader(r, "Category_Label", ""),
              dataset: valByHeader(r, "Dataset", "ADMISSIONS"),
              displayOrder: parseInt(valByHeader(r, "Display_Order", "99"), 10) || 99
            };

            if (item.dataset === "ALLIED") {
              newAllied.push(item);
            } else {
              newAdmissions.push(item);
            }
          }

          if (newAdmissions.length > 0 || newAllied.length > 0) {
            ADMISSIONS_DATA = newAdmissions;
            OTHER_EXAMS_DATA = newAllied;
            appState.syncStatus = "LIVE_SYNCED";
            appState.lastSyncedCount = newAdmissions.length + newAllied.length;
            const verifiedTs = sheetLastChecked || formatToIstString();
            updateFooterAndModalVerification(verifiedTs);
            saveUserTracker();
            renderApp();
            showToast(`Synced ${appState.lastSyncedCount} records`);
          }
        } catch (err) {
          appState.syncStatus = "OFFLINE_SNAPSHOT";
          updateFooterAndModalVerification();
          updateMetricsAndTabs();
        } finally {
          const lbl = document.getElementById("sync-btn-label");
          if (lbl) lbl.textContent = "Sync Live DB";
        }
      };

      window.__handleSiteConfigSync = function(response) {
        try {
          if (!response || !response.table || !response.table.rows) return;
          const rows = response.table.rows;
          rows.forEach((r) => {
            if (r.c && r.c[0] && r.c[1] && r.c[0].v) {
              const k = String(r.c[0].v).trim();
              const v = String(r.c[1].v).trim();
              appState.siteConfig[k] = v;
            }
          });
          renderSiteBanner();
        } catch (e) {}
      };

      window.google.visualization.Query.setResponse = window.__handleGoogleSheetSync;

      function triggerLiveSheetSync(manual) {
        const lbl = document.getElementById("sync-btn-label");
        if (lbl) lbl.textContent = "Syncing...";
        appState.syncStatus = "SYNCING";
        updateMetricsAndTabs();

        const oldScript = document.getElementById("gsheet-jsonp-script");
        if (oldScript) oldScript.remove();
        const sTag = document.createElement("script");
        sTag.id = "gsheet-jsonp-script";
        sTag.src =
          "https://docs.google.com/spreadsheets/d/" +
          SHEET_ID +
          "/gviz/tq?sheet=Source_Registry_%26_State&tqx=responseHandler:__handleGoogleSheetSync&_ts=" +
          Date.now();
        sTag.onerror = function() {
          appState.syncStatus = "OFFLINE_SNAPSHOT";
          if (lbl) lbl.textContent = "Sync Live DB";
          const checkTs = formatToIstString();
          updateFooterAndModalVerification(checkTs);
          updateMetricsAndTabs();
          if (manual) {
            showToast("Verified via snapshot (" + checkTs + ")");
          }
        };
        document.body.appendChild(sTag);

        const oldCfg = document.getElementById("gsheet-config-script");
        if (oldCfg) oldCfg.remove();
        const cfgTag = document.createElement("script");
        cfgTag.id = "gsheet-config-script";
        cfgTag.src =
          "https://docs.google.com/spreadsheets/d/" +
          SHEET_ID +
          "/gviz/tq?sheet=Site_Config&tqx=responseHandler:__handleSiteConfigSync&_ts=" +
          Date.now();
        document.body.appendChild(cfgTag);
      }

      document.getElementById("btn-sync-sheet").addEventListener("click", () => {
        triggerLiveSheetSync(true);
      });

            // Delegated change listener for robust application status tracking
      document.addEventListener("change", (e) => {
        const sel = e.target && e.target.classList && e.target.classList.contains("track-select") ? e.target : null;
        if (sel) {
          const itemId = sel.getAttribute("data-track-id");
          if (itemId) {
            updateUserStatus(itemId, sel.value);
          }
        }
      });
      updateFooterAndModalVerification();
      renderApp();
      triggerLiveSheetSync(false);
    });