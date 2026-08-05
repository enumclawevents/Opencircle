(function () {
  const ALL_CATEGORIES = [
    "Music",
    "Food & Drink",
    "Arts & Culture",
    "Games & Trivia",
    "Community",
    "Family & Kids",
    "Sports & Fitness",
    "Nightlife",
    "Markets & Shopping",
    "Classes & Workshops",
    "Outdoors",
    "Business & Networking",
    "Charity & Fundraising",
    "Seasonal & Holiday"
  ];

  function initWrap(wrap) {
    const API = wrap.getAttribute("data-api") || "";
    const CITY = wrap.getAttribute("data-city") || "";
    const TRENDING_THRESHOLD = Number(wrap.getAttribute("data-trending-threshold") || "10") || 10;
    const PLACEHOLDER = wrap.getAttribute("data-placeholder") || "";
    const DEFAULT_ORGANIZER = (wrap.getAttribute("data-organizer") || "").trim();
    const MODE = (wrap.getAttribute("data-mode") || "upcoming").trim().toLowerCase() === "past" ? "past" : "upcoming";

    // ✅ base path for single event links
    let EVENT_BASE = (wrap.getAttribute("data-event-base") || "/events/").trim();
    if (!EVENT_BASE.startsWith("/")) EVENT_BASE = "/" + EVENT_BASE;
    if (!EVENT_BASE.endsWith("/")) EVENT_BASE = EVENT_BASE + "/";

    const input = wrap.querySelector(".oc-input");
    const btnSearch = wrap.querySelector(".oc-btn-primary");
    const selSort = wrap.querySelector(".oc-sort");
    const selDate = wrap.querySelector(".oc-date");
    const selCat = wrap.querySelector(".oc-category");
    const grid = wrap.querySelector(".oc-grid");
    const hasInitialCards = !!grid.querySelector(".oc-card-link");

    // ✅ Track views on event card click (delegated, only set once)
    grid.addEventListener(
      "click",
      (ev) => {
        const a = ev.target.closest("a.oc-card-link");
        if (!a) return;

        const API_BASE = (API || "").trim();
        if (!API_BASE) return;

        const eid = (a.getAttribute("data-oc-eid") || "").trim();
        const slug = (a.getAttribute("data-oc-slug") || "").trim();
        const idOrSlug = eid && eid !== "0" ? eid : slug;
        if (!idOrSlug) return;

        const sid = ocGetSid();
        const endpoint =
          API_BASE.replace(/\/$/, "") +
          "/events/" +
          encodeURIComponent(idOrSlug) +
          "/view";
        const payload = JSON.stringify({ sid });

        if (navigator.sendBeacon) {
          navigator.sendBeacon(
            endpoint,
            new Blob([payload], { type: "application/json" })
          );
          return;
        }

        fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: true
        }).catch(() => {});
      },
      true
    );

    const btnGrid = wrap.querySelector(".oc-view-grid");
    const btnList = wrap.querySelector(".oc-view-list");

    // ✅ NEW pagination controls (top + bottom)
    const pagers = wrap.querySelectorAll(".oc-pagination");

    let state = {
      limit: parseInt(wrap.getAttribute("data-limit") || "40", 10),
      offset: 0,
      page: 1,
      total: parseInt(wrap.getAttribute("data-total") || "0", 10) || 0,
      totalPages: parseInt(wrap.getAttribute("data-total-pages") || "1", 10) || 1,
      hasMore: false,
      urlCat: "",
      userTouchedCat: false
    };

    // --- URL deep-link params (cat/sort/date/q) ---
    const params = new URLSearchParams(window.location.search);
    const urlCatRaw = (params.get("cat") || params.get("category") || "").trim();
    state.urlCat = urlCatRaw ? urlCatRaw.toLowerCase() : "";

    const urlSort = (params.get("sort") || "").trim();
    const urlDate = (params.get("date") || "").trim();
    const urlQ = (params.get("q") || "").trim();
    const urlOrganizer = (params.get("organizer") || params.get("org") || DEFAULT_ORGANIZER || "").trim();
    const urlVenue = (params.get("venue") || params.get("location") || "").trim();
    const hasOrganizerFilter = !!urlOrganizer;
    const hasVenueFilter = !!urlVenue;

    if (urlSort && ["soonest", "latest", "trending_week", "recent", "featured"].includes(urlSort)) selSort.value = urlSort;
    if (!urlSort && MODE === "past") selSort.value = "latest";
    if (urlDate && ["any", "today", "week", "month"].includes(urlDate)) selDate.value = urlDate;
    if (urlQ) input.value = urlQ;

    function normalizeOrganizer(value) {
      return String(value || "")
        .toLowerCase()
        .replace(/&/g, "and")
        .replace(/['’`]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    }

    function organizerMatches(selected, candidate) {
      const selectedNorm = normalizeOrganizer(selected);
      const candidateNorm = normalizeOrganizer(candidate);
      if (!selectedNorm) return true;
      if (!candidateNorm) return false;
      return (
        candidateNorm === selectedNorm ||
        candidateNorm.includes(selectedNorm) ||
        selectedNorm.includes(candidateNorm)
      );
    }

    function normalizeVenue(value) {
      return String(value || "")
        .toLowerCase()
        .replace(/['’`]/g, "")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    }

    function venueMatches(selected, candidate) {
      const selectedNorm = normalizeVenue(selected);
      const candidateNorm = normalizeVenue(candidate);
      if (!selectedNorm) return true;
      if (!candidateNorm) return false;
      return (
        candidateNorm === selectedNorm ||
        candidateNorm.includes(selectedNorm) ||
        selectedNorm.includes(candidateNorm)
      );
    }

    function escAttr(str) {
      return (str || "")
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function ocGetSid() {
      try {
        let sid = localStorage.getItem("oc_sid");
        if (!sid) {
          const hasUUID =
            typeof crypto !== "undefined" &&
            crypto &&
            typeof crypto.randomUUID === "function";
          sid = hasUUID
            ? crypto.randomUUID()
            : "sid_" + Math.random().toString(36).slice(2) + Date.now();
          localStorage.setItem("oc_sid", sid);
        }
        return sid;
      } catch (e) {
        return null;
      }
    }

    function normalizeCategory(value) {
      return String(value || "").trim().toLowerCase();
    }

    function getCategoryLabel(value) {
      const normalized = normalizeCategory(value);
      if (!normalized) return "";
      const match = ALL_CATEGORIES.find((item) => normalizeCategory(item) === normalized);
      return match || String(value || "").trim();
    }

    function clamp(n, min, max) {
      return Math.max(min, Math.min(max, n));
    }

    function getUrlPage() {
      const u = new URL(window.location.href);
      const pg = parseInt(u.searchParams.get("pg") || "1", 10);
      return isNaN(pg) || pg < 1 ? 1 : pg;
    }

    function setUrlPage(pg) {
      const u = new URL(window.location.href);
      u.searchParams.set("pg", String(pg));
      window.history.pushState({ pg }, "", u.toString());
    }

    // Initialize from URL
    state.page = getUrlPage();
    if (hasOrganizerFilter && state.page < 1) state.page = 1;
    state.offset = (state.page - 1) * state.limit;

    function inRange(ts, mode) {
      if (mode === "any") return true;
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;

      if (mode === "today") {
        const end = start + 86400;
        return ts >= start && ts < end;
      }
      if (mode === "week") {
        const end = start + 7 * 86400;
        return ts >= start && ts < end;
      }
      if (mode === "month") {
        const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000;
        const mEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() / 1000;
        return ts >= mStart && ts < mEnd;
      }
      return true;
    }

    function normalizeImage(imgRaw) {
      const bad = ["none", "null", "undefined", "#"];
      const s = String(imgRaw || "").trim();
      if (!s) return PLACEHOLDER;
      if (bad.includes(s.toLowerCase())) return PLACEHOLDER;
      if (/^https?:\/\/none\/?$/i.test(s)) return PLACEHOLDER;
      return s.replace(/^http:\/\//i, "https://");
    }

    function normalizeCats(catsRaw) {
      if (!catsRaw) return [];
      let arr = catsRaw;
      if (typeof arr === "string") arr = arr.split(",").map((x) => x.trim());
      if (!Array.isArray(arr)) return [];
      const out = [];
      arr.forEach((c) => {
        const v = String(c || "").trim().toLowerCase();
        if (v) out.push(v);
      });
      return Array.from(new Set(out));
    }

    function buildCategoryOptions(cats) {
      if (!selCat) return;
      selCat.disabled = false;

      const cur = selCat.value || "";
      selCat.innerHTML =
        `<option value="">All Categories</option>` +
        cats.map((c) => `<option value="${escAttr(c)}">${escAttr(c)}</option>`).join("");

      selCat.value = cur;

      if (!state.userTouchedCat && state.urlCat) {
        const match = Array.from(selCat.options).find(
          (o) => normalizeCategory(o.value || "") === state.urlCat
        );
        if (match) selCat.value = match.value;
      }
    }

    // Always show category list
    buildCategoryOptions(ALL_CATEGORIES);

    function syncPagers() {
      const page = state.page;
      const pages = state.totalPages || 1;

      pagers.forEach((pager) => {
        const btnFirst = pager.querySelector(".oc-page-first");
        const btnPrev = pager.querySelector(".oc-page-prev");
        const btnNext = pager.querySelector(".oc-page-next");
        const btnLast = pager.querySelector(".oc-page-last");
        const inputPg = pager.querySelector(".oc-page-input");
        const totalEl = pager.querySelector(".oc-page-total");

        if (inputPg) inputPg.value = String(page);
        if (totalEl) totalEl.textContent = String(pages);

        const atFirst = page <= 1;
        const atLast = page >= pages;

        if (btnFirst) btnFirst.disabled = atFirst;
        if (btnPrev) btnPrev.disabled = atFirst;
        if (btnNext) btnNext.disabled = atLast;
        if (btnLast) btnLast.disabled = atLast;
      });
    }

    function goToPage(pg) {
      const pages = state.totalPages || 1;
      const newPage = clamp(parseInt(pg || 1, 10) || 1, 1, pages);

      if (newPage === state.page) {
        syncPagers();
        return;
      }

      state.page = newPage;
      state.offset = (state.page - 1) * state.limit;

      setUrlPage(state.page);
      load(false);

      const topPager = wrap.querySelector(".oc-pagination-top");
      if (topPager) topPager.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function bindPagerControls() {
      pagers.forEach((pager) => {
        const btnFirst = pager.querySelector(".oc-page-first");
        const btnPrev = pager.querySelector(".oc-page-prev");
        const btnNext = pager.querySelector(".oc-page-next");
        const btnLast = pager.querySelector(".oc-page-last");
        const inputPg = pager.querySelector(".oc-page-input");

        if (btnFirst) btnFirst.addEventListener("click", () => goToPage(1));
        if (btnPrev) btnPrev.addEventListener("click", () => goToPage(state.page - 1));
        if (btnNext) btnNext.addEventListener("click", () => goToPage(state.page + 1));
        if (btnLast) btnLast.addEventListener("click", () => goToPage(state.totalPages));

        if (inputPg) {
          inputPg.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              goToPage(inputPg.value);
            }
          });
          inputPg.addEventListener("blur", () => goToPage(inputPg.value));
        }
      });
    }

    function buildUrl() {
      const q = (input.value || "").trim();
      const sortMode = selSort.value || (MODE === "past" ? "latest" : "soonest");
      const dateMode = selDate.value || "any";
      const needsExpandedFetch = MODE === "past" || hasOrganizerFilter || hasVenueFilter || sortMode === "trending_week" || sortMode === "recent" || sortMode === "featured";
      const apiSort =
        sortMode === "latest" ? "latest" :
        sortMode === "trending_week" ? "trending" :
        sortMode === "recent" ? "id_desc" :
        sortMode === "featured" ? "trending" :
        "soonest";

      const selectedCat = selCat && selCat.value ? selCat.value.trim() : "";
      const cat = selectedCat || (!state.userTouchedCat ? getCategoryLabel(state.urlCat) : "");

      const endpoint = "/events";
      const u = new URL(API.replace(/\/$/, "") + endpoint);
      u.searchParams.set("city", CITY);
      u.searchParams.set("expand", "1");
      u.searchParams.set("limit", String(needsExpandedFetch ? 100 : state.limit));
      u.searchParams.set("offset", String(needsExpandedFetch ? 0 : state.offset));
      u.searchParams.set("sort", apiSort);
      if (MODE === "past") {
        u.searchParams.set("status", "past");
        u.searchParams.set("sort", "latest");
        u.searchParams.set("windowDays", "3650");
      }
      if (q) u.searchParams.set("q", q);
      if (cat) u.searchParams.set("category", cat);

      u.searchParams.set("_dateMode", dateMode);
      return u;
    }

    function syncFilterUrl() {
      const u = new URL(window.location.href);
      const q = (input.value || "").trim();
      const sortMode = selSort.value || (MODE === "past" ? "latest" : "soonest");
      const dateMode = selDate.value || "any";
      const selectedCat = selCat && selCat.value ? selCat.value.trim() : "";
      const category = selectedCat || (!state.userTouchedCat ? getCategoryLabel(state.urlCat) : "");

      if (q) u.searchParams.set("q", q);
      else u.searchParams.delete("q");

      if (sortMode && sortMode !== (MODE === "past" ? "latest" : "soonest")) u.searchParams.set("sort", sortMode);
      else u.searchParams.delete("sort");

      if (dateMode && dateMode !== "any") u.searchParams.set("date", dateMode);
      else u.searchParams.delete("date");

      if (category) {
        u.searchParams.set("cat", normalizeCategory(category));
        u.searchParams.delete("category");
      } else {
        u.searchParams.delete("cat");
        u.searchParams.delete("category");
      }

      if (urlOrganizer) u.searchParams.set("organizer", urlOrganizer);
      if (urlVenue) u.searchParams.set("venue", urlVenue);
      u.searchParams.set("pg", String(state.page || 1));
      window.history.replaceState({ pg: state.page || 1 }, "", u.toString());
    }

    function applyUrlFilters() {
      const current = new URLSearchParams(window.location.search);
      const currentQ = (current.get("q") || "").trim();
      const currentSort = (current.get("sort") || "").trim();
      const currentDate = (current.get("date") || "").trim();
      const currentCat = (current.get("cat") || current.get("category") || "").trim();

      if (input) input.value = currentQ;
      if (selSort) selSort.value = currentSort && ["soonest", "latest", "trending_week", "recent", "featured"].includes(currentSort) ? currentSort : (MODE === "past" ? "latest" : "soonest");
      if (selDate) selDate.value = currentDate && ["any", "today", "week", "month"].includes(currentDate) ? currentDate : "any";
      if (selCat) {
        const option = Array.from(selCat.options || []).find((opt) => normalizeCategory(opt.value) === normalizeCategory(currentCat));
        selCat.value = option ? option.value : "";
      }
      state.urlCat = normalizeCategory(currentCat);
    }

    async function fetchAllOrganizerItems(baseUrl) {
      const combined = [];
      let offset = 0;
      let pages = 0;
      let lastMeta = { total: 0, hasMore: false };

      while (pages < 50) {
        const pageUrl = new URL(baseUrl.toString());
        pageUrl.searchParams.set("limit", "100");
        pageUrl.searchParams.set("offset", String(offset));

        const resp = await fetch(pageUrl.toString(), { headers: { Accept: "application/json" } });
        const json = await resp.json();

        const arr = Array.isArray(json.data) ? json.data : [];
        const meta = json.meta || {};

        combined.push(...arr);
        lastMeta = meta;
        pages += 1;

        const hasMore = !!meta.hasMore;
        const nextOffset = Number(meta.nextOffset);
        if (!hasMore || arr.length === 0) break;

        if (Number.isFinite(nextOffset) && nextOffset > offset) {
          offset = nextOffset;
        } else {
          offset += arr.length;
        }
      }

      return { data: combined, meta: lastMeta };
    }

    function getTrendingScore(event) {
      const keys = [
        "views7d", "views_7d", "viewsLast7Days", "views_last_7_days",
        "weeklyViews", "weekly_views", "viewsWeek", "views_week",
        "trendingWeek", "trending_week", "trendingScore7d", "trending_score_7d",
        "trendingScore", "trending_score",
        "views", "viewCount", "view_count"
      ];
      for (const key of keys) {
        if (event && event[key] !== undefined && event[key] !== null && event[key] !== "") {
          const value = Number(event[key]);
          if (Number.isFinite(value)) return value;
        }
      }
      return 0;
    }

    function isHappeningNow(event) {
      if (MODE === "past") return false;
      const now = Math.floor(Date.now() / 1000);
      const startTs = Number(event && event.startTS) || (event && event.startISO ? Math.floor(Date.parse(event.startISO) / 1000) : 0);
      const endTs = Number(event && event.endTS) || (event && event.endISO ? Math.floor(Date.parse(event.endISO) / 1000) : 0);
      const effectiveEndTs = endTs || startTs;
      return !!startTs && startTs <= now && effectiveEndTs >= now;
    }

    function matchesMode(event) {
      const now = Math.floor(Date.now() / 1000);
      const startTs = Number(event && event.startTS) || 0;
      const endTs = Number(event && event.endTS) || 0;
      const effectiveEndTs = endTs || startTs;
      if (!startTs) return false;
      if (MODE === "past") return effectiveEndTs < now;
      return effectiveEndTs >= now;
    }

    function sortItems(items, sortMode) {
      const sorted = items.slice();

      if (sortMode === "latest") {
        sorted.sort((a, b) => (b.startTS || 0) - (a.startTS || 0));
        return sorted;
      }

      if (sortMode === "recent") {
        sorted.sort((a, b) => (b.id || 0) - (a.id || 0));
        return sorted;
      }

      if (sortMode === "featured") {
        sorted.sort((a, b) => {
          const featuredDelta = Number(!!b.featured) - Number(!!a.featured);
          if (featuredDelta !== 0) return featuredDelta;
          return (a.startTS || Number.MAX_SAFE_INTEGER) - (b.startTS || Number.MAX_SAFE_INTEGER);
        });
        return sorted;
      }

      if (sortMode === "trending_week") {
        sorted.sort((a, b) => {
          const scoreDelta = getTrendingScore(b.raw) - getTrendingScore(a.raw);
          if (scoreDelta !== 0) return scoreDelta;
          return (a.startTS || Number.MAX_SAFE_INTEGER) - (b.startTS || Number.MAX_SAFE_INTEGER);
        });
        return sorted;
      }

      sorted.sort((a, b) => (a.startTS || Number.MAX_SAFE_INTEGER) - (b.startTS || Number.MAX_SAFE_INTEGER));
      return sorted;
    }

    function dedupeTrendingWeekItems(items) {
      const bestBySeries = new Map();

      items.forEach((item) => {
        if (!item) return;

        const raw = item.raw || {};
        let seriesKey =
          String(raw.recurrenceId || raw.seriesId || raw.seriesKey || raw.parentId || "").trim();

        if (!seriesKey) {
          const slug = String(item.slug || "").trim().toLowerCase();
          if (slug) {
            seriesKey = "slug:" + slug;
          } else {
            const title = String(item.title || "").trim().toLowerCase();
            const location = String(item.location || "").trim().toLowerCase();
            seriesKey = "tl:" + title + "|" + location;
          }
        }

        const existing = bestBySeries.get(seriesKey);
        if (!existing) {
          bestBySeries.set(seriesKey, item);
          return;
        }

        const itemScore = getTrendingScore(item.raw);
        const existingScore = getTrendingScore(existing.raw);

        if (itemScore > existingScore) {
          bestBySeries.set(seriesKey, item);
          return;
        }

        if (itemScore === existingScore && (item.startTS || Number.MAX_SAFE_INTEGER) < (existing.startTS || Number.MAX_SAFE_INTEGER)) {
          bestBySeries.set(seriesKey, item);
        }
      });

      return Array.from(bestBySeries.values());
    }

    function render(items) {
      const dateMode = selDate.value || "any";
      const filtered = items.filter((e) => e.startTS && inRange(e.startTS, dateMode));
      const featuredIcon = `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M12 2.8l2.85 5.77 6.37.93-4.61 4.49 1.09 6.35L12 17.37 6.3 20.34l1.09-6.35L2.78 9.5l6.37-.93L12 2.8z"></path>
        </svg>
      `;
      const trendingIcon = `
        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
          <path d="M16 6h5v5h-2.5V9.77l-6.03 6.03-3.5-3.5-5.24 5.24L2 15.8l6.97-6.97 3.5 3.5L16.23 8.5H16V6z"></path>
        </svg>
      `;

      const icoCal = `
        <span class="oc-ico" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="16" y1="2" x2="16" y2="6"></line>
            <line x1="8" y1="2" x2="8" y2="6"></line>
            <line x1="3" y1="10" x2="21" y2="10"></line>
          </svg>
        </span>
      `;

      const icoClock = `
        <span class="oc-ico" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"></circle>
            <polyline points="12 6 12 12 16 14"></polyline>
          </svg>
        </span>
      `;

      const icoPin = `
        <span class="oc-ico" aria-hidden="true">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
            <circle cx="12" cy="10" r="3"></circle>
          </svg>
        </span>
      `;

      grid.innerHTML = filtered
        .map((e) => {
          const href = (e.url || (EVENT_BASE + (e.key || e.id) + "/")).replace(/"/g, "%22");
          const safeTitle = escAttr(e.title || "");
          const day = new Date(e.startTS * 1000).getDate();
          const mon = new Date(e.startTS * 1000).toLocaleString(undefined, { month: "short" });
          const trendingScore = getTrendingScore(e.raw);
          const happeningNow = isHappeningNow(e);
          const featuredBadge = e.featured
            ? `<div class="oc-grid-badge oc-grid-badge--featured" aria-label="Featured event" title="Featured event">${featuredIcon}</div>`
            : "";
          const happeningBadge = happeningNow
            ? `<div class="oc-grid-badge oc-grid-badge--happening" aria-label="Happening now" title="Happening now">Now</div>`
            : "";
          const trendingBadge = trendingScore >= TRENDING_THRESHOLD
            ? `<div class="oc-grid-badge oc-grid-badge--trending" aria-label="Trending event" title="Trending event">${trendingIcon}</div>`
            : "";

          return `
            <a
              href="${href}"
              class="oc-card-link"
              aria-label="${safeTitle}"
              data-oc-eid="${escAttr(String(e.id || ""))}"
              data-oc-slug="${escAttr(String(e.slug || ""))}"
            >
              <article class="oc-card" role="listitem">
                <div class="oc-media">
                  <div class="oc-grid-badges">
                    ${featuredBadge}
                    ${happeningBadge}
                    ${trendingBadge}
                  </div>
                  <img class="oc-thumb" src="${escAttr(e.imageUrl)}" alt="${safeTitle}" loading="lazy" />
                  <div class="oc-badge">
                    <div class="oc-badge-day">${day}</div>
                    <div class="oc-badge-mon">${mon}</div>
                  </div>
                </div>
                <div class="oc-body">
                  <h3 class="oc-title">${safeTitle}</h3>
                  <div class="oc-meta">${icoCal}<span>${escAttr(e.dateLabel || "")}</span></div>
                  <div class="oc-meta">${icoClock}<span>${escAttr(e.timeLabel || "")}</span></div>
                  <div class="oc-meta">${icoPin}<span>${escAttr(e.location || "")}</span></div>
                </div>
              </article>
            </a>
          `;
        })
        .join("");
    }

    async function load(resetOffset, options = {}) {
      const preserveExisting = !!options.preserveExisting;

      if (resetOffset) {
        state.page = 1;
        state.offset = 0;
        setUrlPage(1);
      }

      syncFilterUrl();

      if (!preserveExisting) {
        grid.innerHTML = `<div style="padding:12px;color:#777;">Loading…</div>`;
      }

      const url = buildUrl();
      const dateMode = url.searchParams.get("_dateMode") || "any";
      url.searchParams.delete("_dateMode");

      try {
        let json;
        if (hasOrganizerFilter || selSort.value === "trending_week" || selSort.value === "recent" || selSort.value === "featured") {
          json = await fetchAllOrganizerItems(url);
        } else {
          const resp = await fetch(url.toString(), { headers: { Accept: "application/json" } });
          json = await resp.json();
        }

        const arr = Array.isArray(json.data) ? json.data : [];
        const meta = json.meta || {};

        state.total = Number(meta.total || 0);
        state.hasMore = !!meta.hasMore;
        state.totalPages = Math.max(1, Math.ceil(state.total / state.limit));

        const items = arr.map((e) => {
          const startISO = String(e.startDateTime || "");
          const ts = Date.parse(startISO);
          const startTS = Number.isFinite(ts) ? Math.floor(ts / 1000) : 0;
          const endISO = String(e.endDateTime || "");
          const endParsed = Date.parse(endISO);
          const endTS = Number.isFinite(endParsed) ? Math.floor(endParsed / 1000) : 0;

          const slug = String(e.slug || "").trim();
          const id = Number(e.id || 0);
          const key = slug ? slug : String(id);

          const dateLabel =
            e.dateLabel ||
            (startTS
              ? new Date(startTS * 1000).toLocaleDateString(undefined, {
                  month: "long",
                  day: "numeric",
                  year: "numeric"
                })
              : "");

          const timeLabel =
            e.timeLabel ||
            (startTS
              ? new Date(startTS * 1000)
                  .toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
                  .toLowerCase()
              : "");

          const img = normalizeImage(e.imageUrl || e.image || e.imageURL);

          const featured = Number(e.featured || 0) === 1 || !!e.isFeatured;

          return {
            id,
            slug,
            key,
            title: String(e.title || ""),
            startISO,
            startTS,
            endTS,
            dateLabel,
            timeLabel,
            location: String(e.location || ""),
            organizer: String(e.organizer || ""),
            imageUrl: img,
            featured,
            categories: normalizeCats(e.categories),
            url: e.url ? String(e.url) : EVENT_BASE + encodeURIComponent(key) + "/",
            raw: e
          };
        });

        selDate.value = dateMode;

        const selectedCat = normalizeCategory(selCat && selCat.value ? selCat.value : "");
        const selectedQ = (input.value || "").trim().toLowerCase();
        const selectedOrganizer = normalizeOrganizer(urlOrganizer);
        const selectedVenue = normalizeVenue(urlVenue);

        const itemsFiltered = items.filter((e) => {
          const catOk = !selectedCat || (e.categories || []).includes(selectedCat);
          const qOk = !selectedQ || (e.title || "").toLowerCase().includes(selectedQ);
          const organizerOk = organizerMatches(selectedOrganizer, e.organizer);
          const venueOk = venueMatches(selectedVenue, e.location);
          const modeOk = matchesMode(e);
          return catOk && qOk && organizerOk && venueOk && modeOk;
        });
        const activeSortMode = selSort.value || "soonest";
        let sortedItems = sortItems(itemsFiltered, activeSortMode);
        if (!["soonest", "latest"].includes(activeSortMode)) {
          sortedItems = sortItems(dedupeTrendingWeekItems(sortedItems), activeSortMode);
        }

        if (MODE === "past" || hasOrganizerFilter || hasVenueFilter || selSort.value === "trending_week" || selSort.value === "recent" || selSort.value === "featured") {
          state.total = sortedItems.length;
          state.hasMore = state.total > state.page * state.limit;
          state.totalPages = Math.max(1, Math.ceil(state.total / state.limit));

          if (state.page > state.totalPages) {
            state.page = 1;
            state.offset = 0;
            setUrlPage(1);
          }
        }

        const pageStart = (state.page - 1) * state.limit;
        const pageEnd = pageStart + state.limit;
        const pagedItems = (MODE === "past" || hasOrganizerFilter || hasVenueFilter || selSort.value === "trending_week" || selSort.value === "recent" || selSort.value === "featured")
          ? sortedItems.slice(pageStart, pageEnd)
          : sortedItems;

        render(pagedItems);
        syncPagers();
      } catch (err) {
        console.error(err);
        if (!preserveExisting) {
          grid.innerHTML = `<div style="padding:12px;color:#b00020;">Could not load events.</div>`;
        }
        state.total = 0;
        state.hasMore = false;
        state.totalPages = 1;
        syncPagers();
      }
    }

    // Listeners
    btnSearch.addEventListener("click", () => load(true));
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        load(true);
      }
    });

    selSort.addEventListener("change", () => load(true));
    selDate.addEventListener("change", () => load(false));

    selCat &&
      selCat.addEventListener("change", () => {
        state.userTouchedCat = true;
        load(false);
      });

    window.addEventListener("popstate", () => {
      applyUrlFilters();
      state.page = getUrlPage();
      state.offset = (state.page - 1) * state.limit;
      load(false);
    });

    // View toggles
    if (btnGrid && btnList) {
      btnGrid.addEventListener("click", () => {
        btnGrid.classList.add("is-active");
        btnList.classList.remove("is-active");
        grid.classList.remove("is-list");
      });

      btnList.addEventListener("click", () => {
        btnList.classList.add("is-active");
        btnGrid.classList.remove("is-active");
        grid.classList.add("is-list");
      });
    }

    // ✅ Bind pager controls (both top and bottom)
    bindPagerControls();
    syncPagers();

    // Initial load
    const hasInitialQuery =
      state.page > 1 ||
      !!urlQ ||
      !!state.urlCat ||
      !!urlOrganizer ||
      !!urlVenue ||
      (urlSort && urlSort !== "soonest") ||
      (urlDate && urlDate !== "any");

    if (hasInitialQuery) {
      load(false, { preserveExisting: hasInitialCards });
    } else {
      syncPagers();
    }
  }

  function boot() {
    document.querySelectorAll(".oc-events-wrap").forEach(initWrap);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
