"use strict";

const express = require("express");
const router = express.Router();
const { all, get, run } = require("../db");
const crypto = require("crypto");

/**
 * Helpers
 */

function toLocalISOWithOffset(dtLocal) {
  if (!dtLocal) return null;
  const d = new Date(dtLocal);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = "00";
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offH = pad(Math.floor(abs / 60));
  const offM = pad(abs % 60);
  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offH}:${offM}`;
}

function normalizeCategoriesInput(val) {
  if (Array.isArray(val)) {
    return val.map((x) => String(x || "").trim()).filter(Boolean);
  }
  if (!val) return [];
  return String(val)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function addHoursIso(iso, hours) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    d.setHours(d.getHours() + hours);
    return d.toISOString();
  } catch {
    return iso;
  }
}

// Public submission endpoint (frontend form -> pending approvals)
router.post("/submit", async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === "string" && body.trim()) {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body && typeof body === "object" ? body : {};

    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    const location = String(body.location || "").trim();
    const organizer = String(body.organizer || "").trim();
    const city = String(body.city || "Enumclaw").trim() || "Enumclaw";

    let startDateTime = String(body.startDateTime || "").trim();
    let endDateTime = String(body.endDateTime || "").trim();

    if (!title || !description || !location || !startDateTime) {
      return res.status(400).json({ ok: false, error: "Missing required fields." });
    }

    // Accept datetime-local and convert to ISO with offset
    if (/^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$/.test(startDateTime)) {
      const iso = toLocalISOWithOffset(startDateTime);
      if (iso) startDateTime = iso;
    }
    if (endDateTime && /^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}$/.test(endDateTime)) {
      const iso = toLocalISOWithOffset(endDateTime);
      if (iso) endDateTime = iso;
    }

    // If no end time, default to +1 hour (can be edited in approvals)
    if (!endDateTime) {
      endDateTime = addHoursIso(startDateTime, 1);
    }

    const cats = normalizeCategoriesInput(body.categories);
    const categories = JSON.stringify(cats);

    const imageUrl = String(body.imageUrl || "").trim() || null;
    const eventLink = String(body.eventLink || "").trim() || null;
    const ticketUrl = String(body.ticketUrl || "").trim() || null;
    const ticketLabel = String(body.ticketLabel || "").trim() || "Tickets";
    const eventDetails = String(body.eventDetails || "").trim() || "";
    const goodToKnow = String(body.goodToKnow || "").trim() || "";
    const submitterEmail = String(body.submitterEmail || "").trim() || "";
    const approvalNotes = String(body.approvalNotes || "").trim() || "";
    const source = String(body.source || "").trim() || "wp_frontend";

    const inserted = await run(
      `INSERT INTO pending_events
        (city, title, description, eventDetails, goodToKnow, ticketUrl, ticketLabel,
         startDateTime, endDateTime, location, organizer, imageUrl, eventLink, categories,
         submitterEmail, approvalNotes, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        city, title, description, eventDetails, goodToKnow, ticketUrl, ticketLabel,
        startDateTime, endDateTime, location, organizer, imageUrl, eventLink, categories,
        submitterEmail, approvalNotes, source
      ]
    );

    return res.json({ ok: true, id: inserted.lastID });
  } catch (err) {
    console.error("[POST /events/submit] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

router.post("/:idOrSlug/view", async (req, res) => {
  try {
    const idOrSlug = String(req.params.idOrSlug || "").trim();
    if (!idOrSlug) return res.status(400).json({ ok: false, error: "Missing id/slug" });

    // Resolve event id (by numeric id OR slug)
    let row = null;
    const asNum = Number(idOrSlug);
    if (Number.isFinite(asNum) && String(asNum) === idOrSlug) {
      row = await get("SELECT id FROM events WHERE id = ? LIMIT 1", [asNum]);
    } else {
      row = await get("SELECT id FROM events WHERE slug = ? LIMIT 1", [idOrSlug]);
    }
    if (!row) return res.status(404).json({ ok: false, error: "Event not found" });

    const eventId = Number(row.id);

    // Parse body (supports JSON or text/plain containing JSON)
    let body = req.body;
    if (typeof body === "string" && body.trim()) {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body && typeof body === "object" ? body : {};

    const sid = String(body.sid || "").trim();
    const ref = String(req.get("referer") || "").slice(0, 500);
    const ua  = String(req.get("user-agent") || "").slice(0, 300);

    // Optional: hash IP (simple + non-reversible enough for basic analytics)
    const ipRaw = String(req.ip || "").trim();
    const ipHash = ipRaw ? require("crypto").createHash("sha256").update(ipRaw).digest("hex") : null;

    // Always record a row (for analytics)
    await run(
      `INSERT INTO event_views (eventId, occurrenceDate, ipHash, ua, ref, sid)
       VALUES (?, NULL, ?, ?, ?, ?)`,
      [eventId, ipHash, ua, ref, sid || null]
    );

    // Always increment total views + lastViewedAt
    await run(
      `UPDATE events
       SET viewCount = COALESCE(viewCount,0) + 1,
           lastViewedAt = datetime('now'),
           updatedAt = datetime('now')
       WHERE id = ?`,
      [eventId]
    );

    // Unique logic: only if sid provided and not seen before
    let unique = false;
if (sid) {
  await run(
    `INSERT OR IGNORE INTO event_view_uniques (eventId, sid) VALUES (?, ?)`,
    [eventId, sid]
  );
  const ch = await get("SELECT changes() AS ch");
  if (Number(ch?.ch || 0) > 0) {
    unique = true;
    await run(
      `UPDATE events
       SET uniqueViewCount = COALESCE(uniqueViewCount,0) + 1
       WHERE id = ?`,
      [eventId]
    );
  }
}


    return res.json({ ok: true, eventId, unique });
  } catch (e) {
    console.error("[POST /events/:idOrSlug/view] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }

router.post("/:idOrSlug/engagement", async (req, res) => {
  try {
    const idOrSlug = String(req.params.idOrSlug || "").trim();
    if (!idOrSlug) return res.status(400).json({ ok: false, error: "Missing id/slug" });

    // Resolve event id (by numeric id OR slug)
    let row = null;
    const asNum = Number(idOrSlug);
    if (Number.isFinite(asNum) && String(asNum) === idOrSlug) {
      row = await get("SELECT id FROM events WHERE id = ? LIMIT 1", [asNum]);
    } else {
      row = await get("SELECT id FROM events WHERE slug = ? LIMIT 1", [idOrSlug]);
    }
    if (!row) return res.status(404).json({ ok: false, error: "Event not found" });

    const eventId = Number(row.id);

    // Parse body (supports JSON or text/plain containing JSON)
    let body = req.body;
    if (typeof body === "string" && body.trim()) {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body && typeof body === "object" ? body : {};

    const going = Number(body.going);
    const interested = Number(body.interested);

    if (!Number.isFinite(going) || !Number.isFinite(interested) || going < 0 || interested < 0) {
      return res.status(400).json({ ok: false, error: "Invalid counts" });
    }

    await run(
      `UPDATE events
       SET goingCount = ?,
           interestedCount = ?,
           updatedAt = datetime('now')
       WHERE id = ?`,
      [Math.floor(going), Math.floor(interested), eventId]
    );

    return res.json({ ok: true, eventId, going: Math.floor(going), interested: Math.floor(interested) });
  } catch (e) {
    console.error("[POST /events/:idOrSlug/engagement] error:", e);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});


});



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

function readEddiesPick(row) {
  const v = (row && (row.eddiesPick ?? row.eddies_pick ?? row.EddiesPick)) ?? 0;
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
    eddiesPick: readEddiesPick(row),
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
      eddiesPick: readEddiesPick(r),
      eddiesPick: readEddiesPick(r),
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
      eddiesPick: readEddiesPick(rowFixed),
      eddiesPick: readEddiesPick(rowFixed),

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

// GET /events/rss (upcoming events)
router.get("/rss", async (req, res) => {
  try {
    const limit = Math.max(1, Math.min(200, parseInt(req.query.limit || "50", 10)));

    const cityRaw = String(req.query.city || "").trim();
    const hasCity = cityRaw !== "";

    const weekendOnly =
      String(req.query.weekend || "").trim() === "1" ||
      String(req.query.window || "").trim().toLowerCase() === "next_weekend";

    const layoutMode = String(req.query.layout || "").trim().toLowerCase();

    const featuredMode = String(req.query.featured || "").trim().toLowerCase();
    const prependFeatured = featuredMode === "prepend";

    const pickMode = String(req.query.pick || "").trim().toLowerCase();
    const includePick =
      pickMode === "1" ||
      pickMode === "true" ||
      pickMode === "prepend" ||
      layoutMode === "mailchimp";

    let windowStartIso = null;
    let windowEndIso = null;
    if (weekendOnly) {
      const now = new Date();
      const dow = now.getDay(); // 0 Sun .. 6 Sat
      const daysToFri = (5 - dow + 7) % 7; // Fri = 5
      const fri = new Date(now);
      fri.setHours(0, 0, 0, 0);
      fri.setDate(fri.getDate() + daysToFri);

      const mon = new Date(fri);
      mon.setDate(mon.getDate() + 3); // Mon 00:00 after Fri/Sat/Sun

      windowStartIso = fri.toISOString();
      windowEndIso = mon.toISOString();
    }

    const whereParts = [
      "datetime(startDateTime) >= datetime('now')",
    ];
    const params = [];

    if (hasCity) {
      whereParts.push("LOWER(city) = LOWER(?)");
      params.push(cityRaw);
    }
    if (windowStartIso && windowEndIso) {
      whereParts.push("datetime(startDateTime) >= datetime(?)");
      whereParts.push("datetime(startDateTime) < datetime(?)");
      params.push(windowStartIso, windowEndIso);
    }

    const rows = await all(
      `SELECT id, slug, title, description, startDateTime, imageUrl, eddiesPick
       FROM events
       WHERE ${whereParts.join(" AND ")}
       ORDER BY datetime(startDateTime) ASC
       LIMIT ?`,
      [...params, limit]
    );

    let finalRows = rows || [];

    if (featuredMode === "1" || featuredMode === "true") {
      const fWhere = [...whereParts, "featured = 1"];
      const fParams = [...params];
      const featuredRows = await all(
        `SELECT id, slug, title, description, startDateTime, imageUrl, eddiesPick
         FROM events
         WHERE ${fWhere.join(" AND ")}
         ORDER BY datetime(startDateTime) ASC
         LIMIT ?`,
        [...fParams, limit]
      );
      finalRows = featuredRows || [];
    } else if (prependFeatured) {
      const fWhere = [...whereParts, "featured = 1"];
      const fParams = [...params];
      const featuredRows = await all(
        `SELECT id, slug, title, description, startDateTime, imageUrl, eddiesPick
         FROM events
         WHERE ${fWhere.join(" AND ")}
         ORDER BY datetime(startDateTime) ASC
         LIMIT 1`,
        fParams
      );
      if (featuredRows && featuredRows.length) {
        const f = featuredRows[0];
        const filtered = (finalRows || []).filter(
          (e) => String(e.id) !== String(f.id)
        );
        finalRows = [f, ...filtered];
      }
    }

    let pickRows = [];
    if (includePick) {
      const pWhere = [...whereParts, "eddiesPick = 1"];
      const pParams = [...params];
      pickRows = await all(
        `SELECT id, slug, title, description, startDateTime, imageUrl, eddiesPick
         FROM events
         WHERE ${pWhere.join(" AND ")}
         ORDER BY datetime(startDateTime) ASC
         LIMIT 1`,
        pParams
      );

      if (pickMode === "1" || pickMode === "true") {
        finalRows = pickRows || [];
      } else if (pickRows && pickRows.length) {
        const p = pickRows[0];
        finalRows = (finalRows || []).filter((e) => String(e.id) !== String(p.id));
      }
    }

    const siteBase =
      (process.env.PUBLIC_SITE_URL || process.env.EVENTS_SITE_URL || "").trim() ||
      `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.get("host")}`;

    const escXml = (s) =>
      String(s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&apos;");

    const channelTitle = "OpenCircle Events";
    const channelLink = `${siteBase}/events`;
    const channelDesc = "Upcoming events";

    const rssTz = "America/Los_Angeles";
    const formatDate = (iso) => {
      if (!iso) return "";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleDateString("en-US", { timeZone: rssTz, month: "short", day: "numeric", year: "numeric" });
    };

    const formatTime = (iso) => {
      if (!iso) return "";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleTimeString("en-US", { timeZone: rssTz, hour: "numeric", minute: "2-digit" }).toLowerCase();
    };

    const stripHtml = (html) =>
      String(html || "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

    const excerpt = (html, max = 220) => {
      const txt = stripHtml(html);
      if (txt.length <= max) return txt;
      return txt.slice(0, max).replace(/\s+\S*$/, "") + "...";
    };

    const buildCardHtml = (e, variant) => {
      const key = e.slug ? String(e.slug) : String(e.id);
      const link = `${siteBase}/events/${encodeURIComponent(key)}/`;
      const title = String(e.title || "Event");
      const img = String(e.imageUrl || "").trim();
      const date = formatDate(e.startDateTime);
      const time = formatTime(e.startDateTime);
      const blurb = excerpt(e.description || "", 240);

      const imgHtml = img
        ? `<div style="width:100%;overflow:hidden;border-radius:${variant === "featured" ? "14px" : "8px"};background:#f3f4f6;">
             <img src="${img}" alt="" style="width:100%;height:auto;display:block;max-width:${variant === "featured" ? "600px" : "280px"};" />
           </div>`
        : "";

      const bodyFont = "font-family:'Open Sans', Arial, sans-serif;";
      if (variant === "featured") {
        return `
          <div style="text-align:center;padding:40px 44px 24px;${bodyFont}">
            <a href="${link}" style="text-decoration:none;color:inherit;display:block;">
              <div style="position:relative;">
                ${imgHtml}
                <div style="position:absolute;top:16px;left:16px;background:#00add4;color:#fff;font-size:11px;font-weight:700;padding:6px 10px;border-radius:999px;letter-spacing:.08em;text-transform:uppercase;">
                  Featured
                </div>
              </div>
              <div style="font-size:28px;font-weight:700;${bodyFont}color:#111;line-height:1.2;margin:24px 0 12px;">
                ${escXml(title)}
              </div>
              <div style="font-size:13px;${bodyFont}letter-spacing:.08em;color:#6b7280;margin:0 0 20px;text-transform:uppercase;">
                ${escXml(date)}${time ? " • " + escXml(time) : ""}
              </div>
            </a>
            ${blurb ? `<div style="font-size:15px;${bodyFont}color:#4b5563;line-height:1.6;margin:0 0 32px;">${escXml(blurb)}</div>` : ""}
            <a href="${link}" style="display:inline-block;padding:12px 24px;border-radius:999px;background:#48a7c7;color:#fff;text-decoration:none;font-weight:600;font-size:14px;${bodyFont}">
              View Event
            </a>
          </div>
        `;
      }

      if (variant === "pick") {
        return `
          <div style="padding:18px 22px;background:#00add4;color:#fff;${bodyFont}">
            <a href="${link}" style="text-decoration:none;color:inherit;display:block;">
              <div style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;opacity:.75;margin-bottom:10px;">Eddie's Pick</div>
              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="border-collapse:collapse;">
                <tr>
                  <td width="34%" valign="top" style="padding:0;">
                    ${img ? `<img src="${img}" alt="" style="width:100%;height:auto;display:block;border-radius:8px;">` : ""}
                  </td>
                  <td width="66%" valign="top" style="padding:0 0 0 16px;">
                    <div style="font-size:20px;font-weight:700;${bodyFont}line-height:1.25;margin:0 0 8px;">
                      ${escXml(title)}
                    </div>
                    <div style="font-size:13px;${bodyFont}opacity:.85;margin:0;text-transform:uppercase;letter-spacing:.06em;">
                      ${escXml(date)}${time ? " • " + escXml(time) : ""}
                    </div>
                  </td>
                </tr>
              </table>
            </a>
          </div>
        `;
      }

      return `
        <a href="${link}" style="text-decoration:none;color:inherit;display:block;${bodyFont}">
          ${imgHtml}
          <div style="font-size:18px;font-weight:700;${bodyFont}color:#111;line-height:1.2;margin:10px 0 6px;">${escXml(title)}</div>
          <div style="font-size:13px;${bodyFont}color:#6b7280;margin:0 0 6px;text-transform:uppercase;letter-spacing:.06em;">${escXml(date)}${time ? " • " + escXml(time) : ""}</div>
        </a>
      `;
    };

    let itemsXml = "";

    if (layoutMode === "mailchimp") {
      const list = finalRows || [];
      const useFeatured = (featuredMode === "prepend" || featuredMode === "1" || featuredMode === "true");
      const featured = useFeatured && list.length ? list[0] : null;
      const pick = (pickRows && pickRows.length) ? pickRows[0] : null;
      const pickIsFeatured = pick && featured && String(pick.id) === String(featured.id);
      const safePick = pickIsFeatured ? null : pick;

      const rest = useFeatured ? (list.length > 1 ? list.slice(1) : []) : list;

      const featuredHtml = featured
        ? `<div style="margin:48px 0 64px;">${buildCardHtml(featured, "featured")}</div>`
        : "";

      const pickHtml = safePick
        ? `<div style="margin:0 0 32px;">${buildCardHtml(safePick, "pick")}</div>`
        : "";

      const picksHeader = safePick
        ? ``
        : "";

      const moreHeader = rest.length
        ? `<div style="text-align:center;margin:0 0 24px;font-family:'Open Sans', Arial, sans-serif;color:#111;">
             <div style="font-size:20px;font-weight:700;margin-top:6px;">More Events</div>
           </div>`
        : "";

      const gridHtml = rest.length
        ? `${moreHeader}
           <div style="font-size:0;padding:0 20px;">
            ${rest
              .map(
                (e) => `
                <div style="display:inline-block;width:48%;vertical-align:top;margin:0 1% 32px;font-size:16px;">
                  ${buildCardHtml(e, "grid")}
                </div>`
              )
              .join("")}
           </div>`
        : "";

      const descriptionHtml = `${featuredHtml}${picksHeader}${pickHtml}${gridHtml}`;
      const link = channelLink;
      const pubDate = new Date().toUTCString();

      itemsXml = `
  <item>
    <title>${escXml(channelTitle)}</title>
    <link>${escXml(link)}</link>
    <guid isPermaLink="true">${escXml(link)}</guid>
    <description><![CDATA[${descriptionHtml}]]></description>
    <pubDate>${escXml(pubDate)}</pubDate>
  </item>`;
    } else {
      itemsXml = (finalRows || [])
        .map((e) => {
          const key = e.slug ? String(e.slug) : String(e.id);
          const link = `${siteBase}/events/${encodeURIComponent(key)}/`;
          const title = escXml(e.title || "Event");
          const descRaw = String(e.description || "");
          const img = String(e.imageUrl || "").trim();
          const imgTag = img ? `<img src="${escXml(img)}" alt="" style="max-width:100%;height:auto;" />` : "";
          const desc = escXml(imgTag + descRaw);
          const pubDate = e.startDateTime ? new Date(e.startDateTime).toUTCString() : new Date().toUTCString();

          return `
  <item>
    <title>${title}</title>
    <link>${escXml(link)}</link>
    <guid isPermaLink="true">${escXml(link)}</guid>
    <description>${desc}</description>
    ${img ? `<media:content url="${escXml(img)}" medium="image" />` : ""}
    <pubDate>${escXml(pubDate)}</pubDate>
  </item>`;
        })
        .join("");
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/">
<channel>
  <title>${escXml(channelTitle)}</title>
  <link>${escXml(channelLink)}</link>
  <description>${escXml(channelDesc)}</description>
  ${itemsXml}
</channel>
</rss>`;

    res.setHeader("Content-Type", "application/rss+xml; charset=utf-8");
    return res.send(xml);
  } catch (err) {
    console.error("[/events/rss] error:", err && err.stack ? err.stack : err);
    return res.status(500).send("Server error");
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

function sha256(s) {
  return crypto.createHash("sha256").update(String(s || "")).digest("hex");
}

// POST /events/:idOrSlug/view
router.post("/:idOrSlug/view", async (req, res) => {
  try {
    const raw = String(req.params.idOrSlug || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing id/slug" });

    const asId = Number(raw);
    const isId = Number.isInteger(asId) && asId > 0;

    const row = isId
      ? await get("SELECT id FROM events WHERE id = ? LIMIT 1", [asId])
      : await get("SELECT id FROM events WHERE LOWER(slug) = LOWER(?) LIMIT 1", [raw.toLowerCase()]);

    if (!row) return res.status(404).json({ error: "Event not found" });

    const eventId = Number(row.id);

    const occurrenceDate = String(req.body?.occurrenceDate || "").trim() || null;

    // Privacy-friendly dedupe key:
    const sid = String(req.body?.sid || "").trim() || null;

    const ip =
      (req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.socket.remoteAddress || "").trim();
    const ua = (req.headers["user-agent"] || "").toString().slice(0, 255);
    const ref = (req.headers["referer"] || req.headers["referrer"] || "").toString().slice(0, 500);

    const ipHash = sid ? sha256(`sid:${sid}`) : sha256(`ip:${ip}|ua:${ua}`);

    const UNIQUE_WINDOW_HOURS = 12;

    const existing = await get(
      `
      SELECT id
      FROM event_views
      WHERE eventId = ?
        AND ipHash = ?
        AND viewedAt >= datetime('now', ?)
      LIMIT 1
      `,
      [eventId, ipHash, `-${UNIQUE_WINDOW_HOURS} hours`]
    );

    // log hit
    await run(
      `
      INSERT INTO event_views (eventId, occurrenceDate, ipHash, ua, ref, sid)
      VALUES (?, ?, ?, ?, ?, ?)
      `,
      [eventId, occurrenceDate, ipHash, ua, ref, sid]
    );

    // update aggregates
    if (!existing) {
      await run(
        `
        UPDATE events
        SET viewCount = COALESCE(viewCount,0) + 1,
            uniqueViewCount = COALESCE(uniqueViewCount,0) + 1,
            lastViewedAt = datetime('now')
        WHERE id = ?
        `,
        [eventId]
      );
    } else {
      await run(
        `
        UPDATE events
        SET viewCount = COALESCE(viewCount,0) + 1,
            lastViewedAt = datetime('now')
        WHERE id = ?
        `,
        [eventId]
      );
    }

    return res.json({ ok: true, unique: !existing });
  } catch (err) {
    console.error("[view] error:", err);
    return res.status(500).json({ error: "Server error" });
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
