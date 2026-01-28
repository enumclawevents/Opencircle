// routes/events.js
"use strict";

const express = require("express");
const router = express.Router();
const { all, get } = require("../db");

/**
 * Helpers
 */
function safeParseJson(val, fallback) {
  if (val === null || val === undefined || val === "") return fallback;

  // ✅ If it's already an object/array, return as-is
  if (typeof val === "object") return val;

  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}


function pad2(n) {
  return String(n).padStart(2, "0");
}

function toYmd(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function parseIsoParts(iso) {
  // expects: YYYY-MM-DDTHH:mm(:ss)?(+/-)HH:mm
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
    offset: m[7]
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
    offset
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
 * Custom recurrence:
 * - recurrenceDates stored as JSON array of "YYYY-MM-DD"
 * - occurrences start time uses base event's wall-clock time + offset
 */
function generateCustomOccurrences(eventRow, windowStartUtcMs, windowEndUtcMs) {
  const startParts = parseIsoParts(eventRow.startDateTime);
  if (!startParts) return [];

  const startUtc = Date.parse(eventRow.startDateTime);
  const endUtc = Date.parse(eventRow.endDateTime);
  if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc)) return [];

  const durationMs = Math.max(0, endUtc - startUtc);
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
      offset
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
      label: formatLabelLocal(occLocalParts)
    });
  }

  out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
  return out;
}

/**
 * Generate occurrences for next N days
 * Supports:
 *  - weekly: {type:"weekly", interval, byDay:["WE","FR"]}
 *  - monthly:
 *     mode:"monthday" {byMonthday:15}
 *     mode:"nthweekday" {setPos:1, byDay:"TH"} // first Thursday
 *  - custom: selected dates in recurrenceDates
 */
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

  // anchor is original start date (local)
  const anchorLocal = {
    year: startParts.year,
    month: startParts.month,
    day: startParts.day,
    hour: startParts.hour,
    minute: startParts.minute,
    second: startParts.second,
    offset
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
        offset
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
        label: formatLabelLocal(occLocalParts)
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
        offset
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
        label: formatLabelLocal(occLocalParts)
      });
    }

    out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
    return out;
  }

  return [];
}

/**
 * Feed expansion:
 * - id stays same
 * - instanceId unique for UI rendering
 */
function expandEventIntoFeedItems(row, windowStartUtcMs, windowEndUtcMs) {
  const cats = safeParseJson(row.categories, []);
  const recurRuleObj = safeParseJson(row.recurrenceRule, null);
  const recurDatesArr = safeParseJson(row.recurrenceDates, []);

  const base = {
    ...row,
    categories: Array.isArray(cats) ? cats : [],
    hasRecurrence: Number(row.hasRecurrence || 0),
    recurrenceRule: recurRuleObj,
    recurrenceDates: Array.isArray(recurDatesArr) ? recurDatesArr : []
  };

  const baseStartUtc = Date.parse(base.startDateTime);

  // Non-recurring: include once (only if within next 90 days)
  if (!base.hasRecurrence || !base.recurrenceRule) {
    if (Number.isFinite(baseStartUtc) && baseStartUtc >= windowStartUtcMs && baseStartUtc <= windowEndUtcMs) {
      return [{
        ...base,
        instanceId: `e${base.id}_${base.startDateTime}`,
        baseStartDateTime: base.startDateTime,
        isOccurrence: false,
        occurrenceDate: toYmd(parseIsoParts(base.startDateTime) || { year: 0, month: 0, day: 0 })
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
    occurrenceLabel: o.label
  }));
}

/**
 * GET /events?city=Enumclaw&expand=1
 * Returns occurrences for next 90 days
 */
router.get("/", async (req, res) => {
  try {
    const city = (req.query.city || "Enumclaw").trim();
    const expand = String(req.query.expand ?? "1") !== "0";

    const nowUtc = Date.now();
    const windowDays = 90; // ~3 months
    const windowStartUtc = nowUtc - 5 * 60 * 1000;
    const windowEndUtc = nowUtc + windowDays * 86400 * 1000;

    const rows = await all(
      "SELECT * FROM events WHERE LOWER(city) = LOWER(?) ORDER BY startDateTime ASC",
      [city]
    );

    if (!expand) {
      const normalized = rows.map((r) => ({
        ...r,
        categories: safeParseJson(r.categories, []),
        hasRecurrence: Number(r.hasRecurrence || 0),
        recurrenceRule: safeParseJson(r.recurrenceRule, null),
        recurrenceDates: safeParseJson(r.recurrenceDates, [])
      }));
      return res.json({ data: normalized });
    }

    const expanded = [];
    for (const r of rows) {
      expanded.push(...expandEventIntoFeedItems(r, windowStartUtc, windowEndUtc));
    }

    expanded.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));

    res.json({ data: expanded });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /events/slug/:slug
router.get("/slug/:slug", async (req, res) => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    if (!slug) return res.status(400).json({ error: "Invalid slug" });

    const row = await get("SELECT * FROM events WHERE LOWER(slug) = LOWER(?) LIMIT 1", [slug]);
    if (!row) return res.status(404).json({ error: "Event not found" });

    // normalize like /:id does
    const cats = safeParseJson(row.categories, []);
    const recurRuleObj = safeParseJson(row.recurrenceRule, null);

    const base = {
      ...row,
      categories: Array.isArray(cats) ? cats : [],
      hasRecurrence: Number(row.hasRecurrence || 0),
      recurrenceRule: recurRuleObj,
      recurrenceDates: safeParseJson(row.recurrenceDates, [])
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
      .map((o) => ({
        startDateTime: o.startDateTime,
        endDateTime: o.endDateTime,
        label: o.label
      }));

    res.json({ data: { ...base, occurrencesUpcoming } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});


/**
 * GET /events/:id
 * Returns base event + occurrencesUpcoming[] (next 90 days)
 */
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const row = await get("SELECT * FROM events WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Event not found" });

    const base = {
      ...row,
      categories: Array.isArray(safeParseJson(row.categories, [])) ? safeParseJson(row.categories, []) : [],
      hasRecurrence: Number(row.hasRecurrence || 0),
      recurrenceRule: safeParseJson(row.recurrenceRule, null),
      recurrenceDates: safeParseJson(row.recurrenceDates, [])
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
      .map((o) => ({
        occurrenceDate: o.occurrenceDate,
        startDateTime: o.startDateTime,
        endDateTime: o.endDateTime,
        label: o.label
      }));

    res.json({
      data: {
        ...base,
        occurrencesUpcoming
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
