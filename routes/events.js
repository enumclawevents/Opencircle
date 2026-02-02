"use strict";

const express = require("express");
const router = express.Router();
const { all, get, run } = require("../db");

/**
 * Helpers
 */

// --- helpers: parse rule + build occurrencesUpcoming correctly ---

function safeJsonParse(v, fallback = null) {
  if (!v) return fallback;
  if (typeof v === "object") return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

function toIsoIfValid(s) {
  const v = String(s || "").trim();
  if (!v) return "";
  const t = Date.parse(v);
  return Number.isNaN(t) ? "" : v;
}

function labelFromIso(iso) {
  // Use the date portion of the ISO; keep it simple and stable.
  // Example: "Feb 7, 2026"
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  } catch {
    return "";
  }
}

function buildOccurrencesUpcomingFromRule(event) {
  const rr = safeJsonParse(event.recurrenceRule, null);
  if (!rr || !rr.type) return [];

  // ✅ CUSTOM: items already contain true per-date start/end
  if (rr.type === "custom" && Array.isArray(rr.items)) {
    const out = rr.items
      .map((it) => {
        const start = toIsoIfValid(it?.start);
        const end   = toIsoIfValid(it?.end);

        if (!start) return null;

        return {
          startDateTime: start,
          endDateTime: end || "",
          label: String(it?.label || "").trim() || labelFromIso(start),
        };
      })
      .filter(Boolean);

    // sort soonest first
    out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
    return out;
  }

  // If you later support weekly/monthly RRULE generation server-side,
  // you'd add it here. For now, fall back to any precomputed occurrencesUpcoming on the row if you store it.
  return [];
}

function safeParseJson(val, fallback) {
  if (val === null || val === undefined || val === "") return fallback;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

function readFeatured(row) {
  // supports legacy "Featured" column name too, and common checkbox strings
  const v = (row && (row.featured ?? row.Featured)) ?? 0;
  const s = String(v).trim().toLowerCase();
  return (s === "1" || s === "true" || s === "yes" || s === "on") ? 1 : 0;
}

function getCreatedTs(item) {
  const candidates = [
    "updatedAt", "updated_at",
    "createdAt", "created_at",
    "insertedAt", "inserted_at",
    "addedAt", "added_at",
    "publishedAt", "published_at",
  ];

  for (const k of candidates) {
    const v = item && item[k];
    if (!v) continue;
    const t = Date.parse(String(v));
    if (Number.isFinite(t)) return t;
  }

  // fallback: increasing id works as a rough "recent"
  const id = Number(item && item.id) || 0;
  return id > 0 ? id : 0;
}

function getTrendingScore(item) {
  const candidates = [
    "trendingScore", "trending_score",
    "views", "viewCount", "view_count",
    "clicks", "clickCount", "click_count",
    "likes", "likeCount", "like_count",
    "rsvps", "rsvpCount", "rsvp_count",
    "popularity", "popularityScore",
  ];

  for (const k of candidates) {
    if (item && item[k] !== undefined && item[k] !== null && item[k] !== "") {
      const n = Number(item[k]);
      if (Number.isFinite(n)) return n;
    }
  }
  return 0;
}

const { DateTime } = require("luxon");

const DEFAULT_TZ = "America/Los_Angeles";

/**
 * If an ISO has +00:00 but represents local time, convert it to Pacific
 * while keeping the same clock time (keepLocalTime: true).
 * This also automatically chooses -08:00 vs -07:00 depending on date (DST).
 */
function normalizeIsoToTzKeepClock(iso, tz = DEFAULT_TZ) {
  const s = String(iso || "").trim();
  if (!s) return s;

  // If it already has a non-UTC offset, leave it.
  // (Example: -08:00 or -07:00)
  if (/[+-]\d{2}:\d{2}$/.test(s) && !s.endsWith("+00:00")) return s;

  // Only rewrite if it ends in +00:00 (your current problematic case)
  if (!s.endsWith("+00:00")) return s;

  const dt = DateTime.fromISO(s, { setZone: true });
  if (!dt.isValid) return s;

  // keepLocalTime means "20:00 stays 20:00", but we change the zone/offset.
  const fixed = dt.setZone(tz, { keepLocalTime: true });

  // Force full ISO with offset, no millis
  return fixed.toISO({ suppressMilliseconds: true, includeOffset: true });
}

function normalizeRowTimes(row, tz = DEFAULT_TZ) {
  if (!row) return row;
  return {
    ...row,
    startDateTime: normalizeIsoToTzKeepClock(row.startDateTime, tz),
    endDateTime: normalizeIsoToTzKeepClock(row.endDateTime, tz),
  };
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toYmd(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function parseIsoParts(iso) {
  const s = String(iso || "").trim();
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?([+-]\d{2}:\d{2})$/
  );
  if (!m) return null;
  return {
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: Number(m[4]),
    minute: Number(m[5]),
    second: Number(m[6] || "00"),
    offset: m[7],
  };
}

function offsetToMinutes(offset) {
  const m = String(offset || "").match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function partsToUtcMs(parts) {
  const offMin = offsetToMinutes(parts.offset);
  const localAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second || 0
  );
  return localAsUtc - offMin * 60 * 1000;
}

function utcMsToLocalParts(utcMs, offset) {
  const offMin = offsetToMinutes(offset);
  const localMs = utcMs + offMin * 60 * 1000;
  const d = new Date(localMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    offset,
  };
}

function partsToIso(parts) {
  return (
    `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` +
    `T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second || 0)}` +
    `${parts.offset}`
  );
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayKeyFromLocalParts(parts) {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  const d = new Date(localAsUtc);
  const map = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
  return map[d.getUTCDay()];
}

function startOfWeekLocalDate(parts) {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const d = new Date(localAsUtc);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - dow);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function monthsDiff(y1, m1, y2, m2) {
  return (y2 - y1) * 12 + (m2 - m1);
}

function formatLabelLocal(parts) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function nthWeekdayOfMonth(year, month, weekdayKey, setPos) {
  const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const target = map[weekdayKey];
  if (target === undefined) return null;

  const dim = daysInMonth(year, month);

  if (setPos === -1) {
    for (let day = dim; day >= 1; day--) {
      const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      if (d.getUTCDay() === target) return day;
    }
    return null;
  }

  let count = 0;
  for (let day = 1; day <= dim; day++) {
    const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    if (d.getUTCDay() === target) {
      count++;
      if (count === setPos) return day;
    }
  }
  return null;
}

/**
 * ✅ FIX A:
 * For recurrenceRule.type === "custom", prefer recurrenceRule.items[] (per-day start/end)
 * so each date can have different hours.
 *
 * Falls back to old recurrenceDates[] behavior if items are missing.
 */
function generateCustomOccurrences(eventRow, windowStartUtcMs, windowEndUtcMs) {
  // Base start/end (for duration fallback)
  const baseStartUtc = Date.parse(eventRow.startDateTime);
  const baseEndUtc = Date.parse(eventRow.endDateTime);
  const durationMs = (Number.isFinite(baseStartUtc) && Number.isFinite(baseEndUtc))
    ? Math.max(0, baseEndUtc - baseStartUtc)
    : 0;

  // 1) ✅ Preferred: recurrenceRule.items (true per-occurrence start/end)
  const rule = safeParseJson(eventRow.recurrenceRule, null);
  if (rule && String(rule.type || "").toLowerCase() === "custom" && Array.isArray(rule.items) && rule.items.length) {
    const out = [];

    for (const it of rule.items) {
      const startIso = toIsoIfValid(it && it.start);
      if (!startIso) continue;

      const occStartUtc = Date.parse(startIso);
      if (!Number.isFinite(occStartUtc)) continue;

      if (occStartUtc < windowStartUtcMs || occStartUtc > windowEndUtcMs) continue;
      if (Number.isFinite(baseStartUtc) && occStartUtc < baseStartUtc) continue;

      let endIso = toIsoIfValid(it && it.end);
      if (!endIso && durationMs > 0) {
        // If item.end missing, compute end using base duration while keeping the item's offset
        const sp = parseIsoParts(startIso);
        if (sp) {
          const occEndUtc = occStartUtc + durationMs;
          const ep = utcMsToLocalParts(occEndUtc, sp.offset);
          endIso = partsToIso(ep);
        }
      }

      const sp = parseIsoParts(startIso);
      const occurrenceDate =
        (startIso.length >= 10 && /^\d{4}-\d{2}-\d{2}$/.test(startIso.slice(0, 10)))
          ? startIso.slice(0, 10)
          : (sp ? toYmd(sp) : "");

      const label = String((it && it.label) || "").trim() || (sp ? formatLabelLocal(sp) : labelFromIso(startIso));

      out.push({
        occurrenceDate,
        startDateTime: startIso,
        endDateTime: endIso || "",
        label,
      });
    }

    out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
    return out;
  }

  // 2) Fallback: your old recurrenceDates[] list (date-only) using base start time
  const startParts = parseIsoParts(eventRow.startDateTime);
  if (!startParts) return [];

  const startUtc = Date.parse(eventRow.startDateTime);
  const endUtc = Date.parse(eventRow.endDateTime);
  if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc)) return [];

  const durationMs2 = Math.max(0, endUtc - startUtc);
  const offset = startParts.offset;

  const dates = safeParseJson(eventRow.recurrenceDates, []);
  if (!Array.isArray(dates) || dates.length === 0) return [];

  const out = [];
  for (const d of dates) {
    const s = String(d || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;

    const [yy, mm, dd] = s.split("-").map(Number);

    const occLocalParts = {
      year: yy,
      month: mm,
      day: dd,
      hour: startParts.hour,
      minute: startParts.minute,
      second: startParts.second,
      offset,
    };

    const occStartUtc = partsToUtcMs(occLocalParts);
    const occEndUtc = occStartUtc + durationMs2;

    if (occStartUtc < windowStartUtcMs || occStartUtc > windowEndUtcMs) continue;
    if (occStartUtc < startUtc) continue;

    const occEndParts = utcMsToLocalParts(occEndUtc, offset);

    out.push({
      occurrenceDate: toYmd(occLocalParts),
      startDateTime: partsToIso(occLocalParts),
      endDateTime: partsToIso(occEndParts),
      label: formatLabelLocal(occLocalParts),
    });
  }

  out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
  return out;
}

function generateOccurrences(eventRow, windowStartUtcMs, windowEndUtcMs) {
  const startISO = eventRow.startDateTime;
  const endISO = eventRow.endDateTime;

  const startParts = parseIsoParts(startISO);
  const endParts = parseIsoParts(endISO);
  if (!startParts || !endParts) return [];

  const startUtc = Date.parse(startISO);
  const endUtc = Date.parse(endISO);
  if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc)) return [];

  const durationMs = Math.max(0, endUtc - startUtc);
  const offset = startParts.offset;

  const rule = safeParseJson(eventRow.recurrenceRule, null);
  if (!rule || Number(eventRow.hasRecurrence || 0) !== 1) return [];

  const type = String(rule.type || "").toLowerCase();
  const interval = Math.max(1, Number(rule.interval || 1));
  const out = [];

  if (type === "custom") {
    return generateCustomOccurrences(eventRow, windowStartUtcMs, windowEndUtcMs);
  }

  const anchorLocal = {
    year: startParts.year,
    month: startParts.month,
    day: startParts.day,
    hour: startParts.hour,
    minute: startParts.minute,
    second: startParts.second,
    offset,
  };
  const anchorWeekStart = startOfWeekLocalDate(anchorLocal);

  if (type === "weekly") {
    const byDay = Array.isArray(rule.byDay) ? rule.byDay : [];
    const byDaySet = new Set(byDay);

    const dayMs = 86400 * 1000;
    for (let t = windowStartUtcMs; t <= windowEndUtcMs; t += dayMs) {
      const lp = utcMsToLocalParts(t, offset);
      const wk = weekdayKeyFromLocalParts(lp);
      if (!byDaySet.has(wk)) continue;

      const candWeekStart = startOfWeekLocalDate(lp);
      const anchorWsUtc = Date.UTC(anchorWeekStart.year, anchorWeekStart.month - 1, anchorWeekStart.day, 0, 0, 0);
      const candWsUtc = Date.UTC(candWeekStart.year, candWeekStart.month - 1, candWeekStart.day, 0, 0, 0);
      const weekIndex = Math.floor((candWsUtc - anchorWsUtc) / (7 * dayMs));
      if (weekIndex < 0) continue;
      if (weekIndex % interval !== 0) continue;

      const occLocalParts = {
        year: lp.year,
        month: lp.month,
        day: lp.day,
        hour: startParts.hour,
        minute: startParts.minute,
        second: startParts.second,
        offset,
      };

      const occStartUtc = partsToUtcMs(occLocalParts);
      const occEndUtc = occStartUtc + durationMs;

      if (occStartUtc < windowStartUtcMs || occStartUtc > windowEndUtcMs) continue;
      if (occStartUtc < startUtc) continue;

      const occEndParts = utcMsToLocalParts(occEndUtc, offset);

      out.push({
        occurrenceDate: toYmd(occLocalParts),
        startDateTime: partsToIso(occLocalParts),
        endDateTime: partsToIso(occEndParts),
        label: formatLabelLocal(occLocalParts),
      });
    }

    out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
    return out;
  }

  if (type === "monthly") {
    const mode = rule.mode === "nthweekday" ? "nthweekday" : "monthday";

    const windowStartLocal = utcMsToLocalParts(windowStartUtcMs, offset);
    const windowEndLocal = utcMsToLocalParts(windowEndUtcMs, offset);

    const anchorY = anchorLocal.year;
    const anchorM = anchorLocal.month;

    const startMonthIndex = Math.max(0, monthsDiff(anchorY, anchorM, windowStartLocal.year, windowStartLocal.month));
    const endMonthIndex = Math.max(0, monthsDiff(anchorY, anchorM, windowEndLocal.year, windowEndLocal.month));

    for (let mi = startMonthIndex; mi <= endMonthIndex; mi++) {
      if (mi % interval !== 0) continue;

      const base = new Date(Date.UTC(anchorY, anchorM - 1, 1, 12, 0, 0));
      base.setUTCMonth(base.getUTCMonth() + mi);
      const y = base.getUTCFullYear();
      const m = base.getUTCMonth() + 1;

      let day = null;

      if (mode === "monthday") {
        const md = Number(rule.byMonthday || 0);
        if (!md) continue;
        day = Math.min(md, daysInMonth(y, m));
      } else {
        const setPos = Number(rule.setPos || 1);
        const wd = String(rule.byDay || "").trim();
        day = nthWeekdayOfMonth(y, m, wd, setPos);
        if (!day) continue;
      }

      const occLocalParts = {
        year: y,
        month: m,
        day,
        hour: startParts.hour,
        minute: startParts.minute,
        second: startParts.second,
        offset,
      };

      const occStartUtc = partsToUtcMs(occLocalParts);
      const occEndUtc = occStartUtc + durationMs;

      if (occStartUtc < windowStartUtcMs || occStartUtc > windowEndUtcMs) continue;
      if (occStartUtc < startUtc) continue;

      const occEndParts = utcMsToLocalParts(occEndUtc, offset);

      out.push({
        occurrenceDate: toYmd(occLocalParts),
        startDateTime: partsToIso(occLocalParts),
        endDateTime: partsToIso(occEndParts),
        label: formatLabelLocal(occLocalParts),
      });
    }

    out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
    return out;
  }

  return [];
}

function expandEventIntoFeedItems(row, windowStartUtcMs, windowEndUtcMs) {
  const rowFixed = row;
  const cats = safeParseJson(row.categories, []);
  const recurRuleObj = safeParseJson(row.recurrenceRule, null);
  const recurDatesArr = safeParseJson(row.recurrenceDates, []);

  const base = {
    ...row,
    categories: Array.isArray(cats) ? cats : [],
    hasRecurrence: Number(row.hasRecurrence || 0),
    recurrenceRule: recurRuleObj,
    goingCount: Number(rowFixed.goingCount || 0),
    interestedCount: Number(rowFixed.interestedCount || 0),
    recurrenceDates: Array.isArray(recurDatesArr) ? recurDatesArr : [],
    featured: readFeatured(row),
  };

  const baseStartUtc = Date.parse(base.startDateTime);

  if (!base.hasRecurrence || !base.recurrenceRule) {
    if (Number.isFinite(baseStartUtc) && baseStartUtc >= windowStartUtcMs && baseStartUtc <= windowEndUtcMs) {
      const p = parseIsoParts(base.startDateTime);
      return [{
        ...base,
        instanceId: `e${base.id}_${base.startDateTime}`,
        baseStartDateTime: base.startDateTime,
        isOccurrence: false,
        occurrenceDate: p ? toYmd(p) : "",
      }];
    }
    return [];
  }

  const occ = generateOccurrences(base, windowStartUtcMs, windowEndUtcMs);

  return occ.map((o) => ({
    ...base,
    startDateTime: o.startDateTime,
    endDateTime: o.endDateTime,
    instanceId: `e${base.id}_${o.startDateTime}`,
    baseStartDateTime: row.startDateTime,
    isOccurrence: true,
    occurrenceDate: o.occurrenceDate,
    occurrenceLabel: o.label,
  }));
}

/**
 * Feed filtering helpers
 */
function normalizeCats(row) {
  const cats = safeParseJson(row.categories, []);
  return Array.isArray(cats) ? cats : [];
}

function matchesCategory(item, category) {
  if (!category) return true;
  const target = String(category).trim().toLowerCase();
  if (!target) return true;
  const cats = Array.isArray(item.categories) ? item.categories : [];
  return cats.some((c) => String(c || "").trim().toLowerCase() === target);
}

function matchesQuery(item, q) {
  if (!q) return true;
  const qq = String(q).trim().toLowerCase();
  if (!qq) return true;
  const t = String(item.title || "").toLowerCase();
  const l = String(item.location || "").toLowerCase();
  return t.includes(qq) || l.includes(qq);
}

function inIsoRange(item, fromISO, toISO) {
  if (!fromISO && !toISO) return true;
  const t = Date.parse(item.startDateTime);
  if (!Number.isFinite(t)) return false;

  const fromT = fromISO ? Date.parse(fromISO) : NaN;
  const toT = toISO ? Date.parse(toISO) : NaN;

  if (Number.isFinite(fromT) && t < fromT) return false;
  if (Number.isFinite(toT) && t > toT) return false;
  return true;
}

function paginate(items, limit, offset) {
  const total = items.length;
  const start = Math.max(0, offset);
  const end = Math.min(total, start + limit);
  const slice = items.slice(start, end);
  const hasMore = end < total;
  return {
    data: slice,
    meta: {
      total,
      limit,
      offset: start,
      hasMore,
      nextOffset: hasMore ? end : null,
    },
  };
}

/**
 * GET /events
 * Supports:
 *  city=Enumclaw
 *  expand=1 (default) or expand=0
 *  limit=40 offset=0
 *  sort=soonest|latest
 *  q=search text
 *  category=music
 *  featured=1
 *  from=ISO to=ISO
 */
router.get("/", async (req, res) => {
  try {
    const city = String(req.query.city ?? "Enumclaw").trim();
    const expand = String(req.query.expand ?? "1") !== "0";

    const sortRaw = String(req.query.sort ?? "soonest").toLowerCase().trim();

    const sort =
      (sortRaw === "latest" ||
       sortRaw === "soonest" ||
       sortRaw === "recent" ||
       sortRaw === "trending" ||
       sortRaw === "id_desc")
        ? sortRaw
        : "soonest";

    const q = String(req.query.q ?? "").trim();
    const category = String(req.query.category ?? "").trim();
    const featuredOnly = String(req.query.featured ?? "0") === "1";

    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit ?? "40"), 10)));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? "0"), 10));

    const fromISO = String(req.query.from ?? "").trim();
    const toISO = String(req.query.to ?? "").trim();

    const nowUtc = Date.now();
    const windowDays = sort === "recent" ? 365 : 90;

    const windowStartUtc = nowUtc - 5 * 60 * 1000;
    const windowEndUtc = nowUtc + windowDays * 86400 * 1000;

    let rows = await all(
      "SELECT * FROM events WHERE LOWER(city) = LOWER(?) ORDER BY startDateTime ASC",
      [city]
    );

    // normalize base times first so recurrence generation uses correct offset
    rows = rows.map(r => normalizeRowTimes(r));

    // Normalize base rows
    const normalizedRows = rows.map((r) => ({
      ...r,
      categories: normalizeCats(r),
      hasRecurrence: Number(r.hasRecurrence || 0),
      recurrenceRule: safeParseJson(r.recurrenceRule, null),
      recurrenceDates: safeParseJson(r.recurrenceDates, []),
      featured: readFeatured(r),
    }));

    // If no expand, treat each base row as one feed item (but still window filter)
    if (!expand) {
      let items = normalizedRows
        .filter((it) => {
          const t = Date.parse(it.startDateTime);
          if (!Number.isFinite(t)) return false;
          if (t < windowStartUtc || t > windowEndUtc) return false;
          if (featuredOnly && Number(it.featured || 0) !== 1) return false;
          if (!matchesQuery(it, q)) return false;
          if (!matchesCategory(it, category)) return false;
          if (!inIsoRange(it, fromISO, toISO)) return false;
          return true;
        });

      items.sort((a, b) => {
        if (sort === "recent") {
          const ca = getCreatedTs(a);
          const cb = getCreatedTs(b);
          if (cb !== ca) return cb - ca; // newest added first

          // tie-break: upcoming sooner first
          const at = Date.parse(a.startDateTime);
          const bt = Date.parse(b.startDateTime);
          return (at - bt);
        }

        if (sort === "trending") {
          const sa = getTrendingScore(a);
          const sb = getTrendingScore(b);
          if (sb !== sa) return sb - sa;

          // tie-break: upcoming sooner first
          const at = Date.parse(a.startDateTime);
          const bt = Date.parse(b.startDateTime);
          return (at - bt);
        }

        if (sort === "id_desc") {
          const ia = Number(a && a.id) || 0;
          const ib = Number(b && b.id) || 0;
          if (ib !== ia) return ib - ia;

          // tie-break: newer startDateTime first
          const at = Date.parse(a.startDateTime);
          const bt = Date.parse(b.startDateTime);
          return bt - at;
        }

        // soonest/latest (existing behavior)
        const at = Date.parse(a.startDateTime);
        const bt = Date.parse(b.startDateTime);
        return sort === "latest" ? (bt - at) : (at - bt);
      });

      return res.json(paginate(items, limit, offset));
    }

    // Expand into occurrences
    let expanded = [];
for (const r of normalizedRows) {
  const rowFixed = r;
  expanded.push(...expandEventIntoFeedItems(rowFixed, windowStartUtc, windowEndUtc));
}


    // Apply filters
    expanded = expanded.filter((it) => {
      if (featuredOnly && Number(it.featured || 0) !== 1) return false;
      if (!matchesQuery(it, q)) return false;
      if (!matchesCategory(it, category)) return false;
      if (!inIsoRange(it, fromISO, toISO)) return false;
      return true;
    });

    // Sort
    expanded.sort((a, b) => {
      if (sort === "recent") {
        const ca = getCreatedTs(a);
        const cb = getCreatedTs(b);
        if (cb !== ca) return cb - ca; // newest added first

        // tie-break: upcoming sooner first
        const at = Date.parse(a.startDateTime);
        const bt = Date.parse(b.startDateTime);
        return (at - bt);
      }

      if (sort === "trending") {
        const sa = getTrendingScore(a);
        const sb = getTrendingScore(b);
        if (sb !== sa) return sb - sa;

        // tie-break: upcoming sooner first
        const at = Date.parse(a.startDateTime);
        const bt = Date.parse(b.startDateTime);
        return (at - bt);
      }

      if (sort === "id_desc") {
        const ia = Number(a && a.id) || 0;
        const ib = Number(b && b.id) || 0;
        if (ib !== ia) return ib - ia;

        const at = Date.parse(a.startDateTime);
        const bt = Date.parse(b.startDateTime);
        return bt - at;
      }

      // soonest/latest (existing behavior)
      const at = Date.parse(a.startDateTime);
      const bt = Date.parse(b.startDateTime);
      return sort === "latest" ? (bt - at) : (at - bt);
    });

    // Paginate
    return res.json(paginate(expanded, limit, offset));
  } catch (err) {
    console.error("[/events] error:", err && err.stack ? err.stack : err);
    console.error("[/events] query:", req.query);
    res.status(500).json({
      data: [],
      meta: { total: 0, limit: 40, offset: 0, hasMore: false, nextOffset: null },
      error: "Server error",
    });
  }
});

// GET /events/slug/:slug
router.get("/slug/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    if (!slug) return res.status(400).json({ error: "Invalid slug" });

    const row = await get("SELECT * FROM events WHERE LOWER(slug) = LOWER(?) LIMIT 1", [slug]);
    if (!row) return res.status(404).json({ error: "Event not found" });

    // ✅ IMPORTANT: use normalized row for the response + recurrence generation
    const rowFixed = normalizeRowTimes(row);

    const cats = safeParseJson(rowFixed.categories, []);
    const recurRuleObj = safeParseJson(rowFixed.recurrenceRule, null);

    const base = {
      ...rowFixed,
      categories: Array.isArray(cats) ? cats : [],
      hasRecurrence: Number(rowFixed.hasRecurrence || 0),
      recurrenceRule: recurRuleObj,
      recurrenceDates: safeParseJson(rowFixed.recurrenceDates, []),
      featured: readFeatured(rowFixed),

      // pass through (these columns exist in DB)
      recurrenceStartDate: rowFixed.recurrenceStartDate || null,
      recurrenceUntilDate: rowFixed.recurrenceUntilDate || null,
    };

    const nowUtc = Date.now();
    const windowDays = 90;
    const windowStartUtc = nowUtc - 5 * 60 * 1000;
    const windowEndUtc = nowUtc + windowDays * 86400 * 1000;

    const occurrences = base.hasRecurrence && base.recurrenceRule
      ? generateOccurrences(base, windowStartUtc, windowEndUtc)
      : [];

    const occurrencesUpcoming = occurrences
      .filter((o) => Date.parse(o.startDateTime) >= windowStartUtc)
      .slice(0, 200)
      .map((o) => ({ startDateTime: o.startDateTime, endDateTime: o.endDateTime, label: o.label }));

    res.json({ data: { ...base, occurrencesUpcoming } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /events/:idOrSlug
router.get("/:idOrSlug", async (req, res) => {
  try {
    const raw = String(req.params.idOrSlug || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing id/slug" });

    const asId = Number(raw);
    const isId = Number.isInteger(asId) && asId > 0;

    const row = isId
      ? await get("SELECT * FROM events WHERE id = ?", [asId])
      : await get("SELECT * FROM events WHERE slug = ?", [raw]);

    if (!row) return res.status(404).json({ error: "Event not found" });

    // ✅ normalize here too
    const rowFixed = normalizeRowTimes(row);

    const cats = safeParseJson(rowFixed.categories, []);
    const recurRuleObj = safeParseJson(rowFixed.recurrenceRule, null);

    const base = {
      ...rowFixed,
      categories: Array.isArray(cats) ? cats : [],
      hasRecurrence: Number(rowFixed.hasRecurrence || 0),
      recurrenceRule: recurRuleObj,
      recurrenceDates: safeParseJson(rowFixed.recurrenceDates, []),
      featured: readFeatured(rowFixed),
      recurrenceStartDate: rowFixed.recurrenceStartDate || null,
      recurrenceUntilDate: rowFixed.recurrenceUntilDate || null,
    };

    const nowUtc = Date.now();
    const windowDays = 90;
    const windowStartUtc = nowUtc - 5 * 60 * 1000;
    const windowEndUtc = nowUtc + windowDays * 86400 * 1000;

    const occurrences = base.hasRecurrence && base.recurrenceRule
      ? generateOccurrences(base, windowStartUtc, windowEndUtc)
      : [];

    const occurrencesUpcoming = occurrences
      .filter((o) => Date.parse(o.startDateTime) >= windowStartUtc)
      .slice(0, 200)
      .map((o) => ({ startDateTime: o.startDateTime, endDateTime: o.endDateTime, label: o.label }));

    res.json({ data: { ...base, occurrencesUpcoming } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});
// POST /events/:idOrSlug/engagement
// Body supports either:
//   { goingDelta: 1 } or { goingDelta: -1 }
//   { interestedDelta: 1 } or { interestedDelta: -1 }
//   OR absolute set: { going: 12, interested: 5 }
router.post("/:idOrSlug/engagement", async (req, res) => {
  try {
    const raw = String(req.params.idOrSlug || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing id/slug" });

    // allow id or slug
    const asId = Number(raw);
    const isId = Number.isInteger(asId) && asId > 0;

    const row = isId
      ? await get("SELECT id FROM events WHERE id = ? LIMIT 1", [asId])
      : await get("SELECT id FROM events WHERE slug = ? LIMIT 1", [raw]);

    if (!row) return res.status(404).json({ error: "Event not found" });

    const id = Number(row.id);

    const body = req.body || {};
    const hasAbsolute =
      typeof body.going !== "undefined" || typeof body.interested !== "undefined";

    if (hasAbsolute) {
      const going = Math.max(0, parseInt(body.going ?? 0, 10) || 0);
      const interested = Math.max(0, parseInt(body.interested ?? 0, 10) || 0);

      await run(
        `UPDATE events
         SET goingCount = ?, interestedCount = ?, updatedAt = datetime('now')
         WHERE id = ?`,
        [going, interested, id]
      );
    } else {
      const goingDelta = parseInt(body.goingDelta ?? 0, 10) || 0;
      const interestedDelta = parseInt(body.interestedDelta ?? 0, 10) || 0;

      await run(
        `UPDATE events
         SET
           goingCount = MAX(0, COALESCE(goingCount, 0) + ?),
           interestedCount = MAX(0, COALESCE(interestedCount, 0) + ?),
           updatedAt = datetime('now')
         WHERE id = ?`,
        [goingDelta, interestedDelta, id]
      );
    }

    const updated = await get(
      `SELECT goingCount, interestedCount FROM events WHERE id = ?`,
      [id]
    );

    res.json({
      ok: true,
      id,
      goingCount: Number(updated?.goingCount || 0),
      interestedCount: Number(updated?.interestedCount || 0),
    });
  } catch (err) {
    console.error("[engagement] error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
