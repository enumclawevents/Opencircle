"use strict";

const express = require("express");
const router = express.Router();
const { all, get, run } = require("../db");

let _schemaEnsured = false;
let _colsCache = null;
let _eventColsCache = null;

function safeParseJson(v, fallback) {
  try {
    const out = typeof v === "string" ? JSON.parse(v) : v;
    return out == null ? fallback : out;
  } catch (_) {
    return fallback;
  }
}

function normalizeVenueCategories(input) {
  const out = [];
  const seen = {};
  const arr = Array.isArray(input) ? input : [];
  for (const item of arr) {
    const v = String(item || "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen[k]) continue;
    seen[k] = true;
    out.push(v);
  }
  return out;
}

function normalizeGalleryImages(input, max = 3) {
  const out = [];
  const seen = new Set();
  const arr = Array.isArray(input) ? input : [input];
  for (const item of arr) {
    const u = normalizeHttpUrl(item);
    if (!u) continue;
    const k = u.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeHttpUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^(none|null|undefined)$/i.test(raw)) return "";

  let out = raw;
  if (out.startsWith("//")) out = "https:" + out;
  else if (!/^https?:\/\//i.test(out) && /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[\/:?#].*)?$/i.test(out)) out = "https://" + out;

  out = out.replace(/^http:\/\//i, "https://");

  try {
    const u = new URL(out);
    if (!/^https?:$/i.test(u.protocol)) return "";
    return u.toString();
  } catch (_) {
    return "";
  }
}

async function getVenueColumns() {
  if (_colsCache) return _colsCache;
  try {
    const rows = await all("PRAGMA table_info(venues)");
    _colsCache = new Set((rows || []).map((r) => String(r.name)));
    return _colsCache;
  } catch (_) {
    _colsCache = new Set();
    return _colsCache;
  }
}

async function getEventColumns() {
  if (_eventColsCache) return _eventColsCache;
  try {
    const rows = await all("PRAGMA table_info(events)");
    _eventColsCache = new Set((rows || []).map((r) => String(r.name)));
    return _eventColsCache;
  } catch (_) {
    _eventColsCache = new Set();
    return _eventColsCache;
  }
}

async function ensureVenueSchema() {
  if (_schemaEnsured) return;

  await run(`
    CREATE TABLE IF NOT EXISTS venues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL DEFAULT 'Enumclaw',
      slug TEXT,
      name TEXT NOT NULL,
      address TEXT,
      website TEXT,
      phone TEXT,
      description TEXT,
      galleryJson TEXT,
      viewCount INTEGER NOT NULL DEFAULT 0,
      phoneClickCount INTEGER NOT NULL DEFAULT 0,
      websiteClickCount INTEGER NOT NULL DEFAULT 0,
      socialClickCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);

  const cols = await getVenueColumns();
  const migrations = [
    ["hoursJson", "ALTER TABLE venues ADD COLUMN hoursJson TEXT"],
    ["categoriesJson", "ALTER TABLE venues ADD COLUMN categoriesJson TEXT"],
    ["socialJson", "ALTER TABLE venues ADD COLUMN socialJson TEXT"],
    ["imageUrl", "ALTER TABLE venues ADD COLUMN imageUrl TEXT"],
    ["seoTitle", "ALTER TABLE venues ADD COLUMN seoTitle TEXT"],
    ["metaDescription", "ALTER TABLE venues ADD COLUMN metaDescription TEXT"],
    ["focusKeyphrase", "ALTER TABLE venues ADD COLUMN focusKeyphrase TEXT"],
    ["imageAlt", "ALTER TABLE venues ADD COLUMN imageAlt TEXT"],
    ["galleryJson", "ALTER TABLE venues ADD COLUMN galleryJson TEXT"],
    ["viewCount", "ALTER TABLE venues ADD COLUMN viewCount INTEGER NOT NULL DEFAULT 0"],
    ["phoneClickCount", "ALTER TABLE venues ADD COLUMN phoneClickCount INTEGER NOT NULL DEFAULT 0"],
    ["websiteClickCount", "ALTER TABLE venues ADD COLUMN websiteClickCount INTEGER NOT NULL DEFAULT 0"],
    ["socialClickCount", "ALTER TABLE venues ADD COLUMN socialClickCount INTEGER NOT NULL DEFAULT 0"],
  ];

  for (const [name, sql] of migrations) {
    if (!cols.has(name)) {
      await run(sql);
    }
  }

  _colsCache = null;
  _schemaEnsured = true;
}

function mapVenueRow(r) {
  const cats = normalizeVenueCategories(safeParseJson(r.categoriesJson, []));
  const social = safeParseJson(r.socialJson, {});
  const hours = safeParseJson(r.hoursJson, {});
  const galleryImages = normalizeGalleryImages(safeParseJson(r.galleryJson, []), 3);
  return {
    id: Number(r.id || 0),
    city: String(r.city || ""),
    slug: String(r.slug || ""),
    name: String(r.name || ""),
    address: String(r.address || ""),
    website: normalizeHttpUrl(r.website || ""),
    phone: String(r.phone || ""),
    description: String(r.description || ""),
    imageUrl: String(r.imageUrl || ""),
    galleryImages,
    categories: cats,
    social,
    hours,
    seoTitle: String(r.seoTitle || ""),
    metaDescription: String(r.metaDescription || ""),
    focusKeyphrase: String(r.focusKeyphrase || ""),
    imageAlt: String(r.imageAlt || ""),
    viewCount: Number(r.viewCount || 0),
    phoneClickCount: Number(r.phoneClickCount || 0),
    websiteClickCount: Number(r.websiteClickCount || 0),
    socialClickCount: Number(r.socialClickCount || 0),
    createdAt: r.createdAt || null,
    updatedAt: r.updatedAt || null,
  };
}

async function incrementVenueCounter(venueId, field) {
  const id = Number(venueId || 0);
  if (!Number.isInteger(id) || id <= 0) return;

  const allowed = new Set(["viewCount", "phoneClickCount", "websiteClickCount", "socialClickCount"]);
  if (!allowed.has(String(field || ""))) return;

  try {
    await run(
      `UPDATE venues
          SET ${field} = COALESCE(${field}, 0) + 1,
              updatedAt = datetime('now')
        WHERE id = ?`,
      [id]
    );
  } catch (_) {}
}

async function incrementVenueView(venueId) {
  await incrementVenueCounter(venueId, "viewCount");
}

async function getVenueRowByIdOrSlug(idOrSlug) {
  const raw = String(idOrSlug || "").trim();
  if (!raw) return null;

  const asId = Number(raw);
  const isId = Number.isInteger(asId) && asId > 0;

  return isId
    ? await get("SELECT * FROM venues WHERE id = ? LIMIT 1", [asId])
    : await get("SELECT * FROM venues WHERE LOWER(slug) = LOWER(?) LIMIT 1", [raw]);
}

function normalizeSocialPlatform(input) {
  const k = String(input || "").trim().toLowerCase();
  if (k === "twitter") return "x";
  return k;
}

function dedupeByKey(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const key = String(r.slug || r.id || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function parseOccurrenceTs(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  if (!Number.isFinite(ts)) return null;
  return { raw, ts };
}

function parseIsoParts(iso) {
  const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?(Z|[+-]\d{2}:?\d{2})$/);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4]);
  const minute = Number(m[5]);
  const second = Number(m[6] || "0");

  let offset = 0;
  const z = m[7];
  if (z !== "Z") {
    const sign = z[0] === "-" ? -1 : 1;
    const hh = Number(z.slice(1, 3));
    const mm = Number(z.slice(-2));
    offset = sign * (hh * 60 + mm);
  }

  return { year, month, day, hour, minute, second, offset };
}

function partsToUtcMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - parts.offset * 60000;
}

function utcMsToLocalParts(utcMs, offset) {
  const d = new Date(utcMs + offset * 60000);
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
  const y = String(parts.year).padStart(4, "0");
  const m = String(parts.month).padStart(2, "0");
  const d = String(parts.day).padStart(2, "0");
  const hh = String(parts.hour).padStart(2, "0");
  const mm = String(parts.minute).padStart(2, "0");
  const ss = String(parts.second).padStart(2, "0");

  const off = parts.offset || 0;
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  const oh = String(Math.floor(abs / 60)).padStart(2, "0");
  const om = String(abs % 60).padStart(2, "0");

  return y + '-' + m + '-' + d + 'T' + hh + ':' + mm + ':' + ss + sign + oh + ':' + om;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0, 12, 0, 0)).getUTCDate();
}

function weekdayKeyFromLocalParts(parts) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][d.getUTCDay()];
}

function startOfWeekLocalDate(parts) {
  const d = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0));
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - dow);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function monthsDiff(y1, m1, y2, m2) {
  return (y2 - y1) * 12 + (m2 - m1);
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

function buildDateOnlyStartIso(ymd, baseStartIso) {
  const m = String(ymd || "").trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const sp = parseIsoParts(baseStartIso);
  if (!sp) return m[1] + '-' + m[2] + '-' + m[3] + 'T00:00:00+00:00';
  return partsToIso({
    year: Number(m[1]),
    month: Number(m[2]),
    day: Number(m[3]),
    hour: sp.hour,
    minute: sp.minute,
    second: sp.second,
    offset: sp.offset,
  });
}

function pushParsedCandidate(candidates, rawStart, rawEnd, nowTs, baseStartRaw, baseEndRaw) {
  let startRaw = String(rawStart || "").trim();
  if (!startRaw) return;

  if (/^\d{4}-\d{2}-\d{2}$/.test(startRaw)) {
    startRaw = buildDateOnlyStartIso(startRaw, baseStartRaw);
  }

  const parsed = parseOccurrenceTs(startRaw);
  if (!parsed || parsed.ts < nowTs) return;

  let endRaw = String(rawEnd || "").trim();
  if (endRaw && /^\d{4}-\d{2}-\d{2}$/.test(endRaw)) {
    endRaw = buildDateOnlyStartIso(endRaw, baseEndRaw || baseStartRaw);
  }

  candidates.push({ startRaw: parsed.raw, startTs: parsed.ts, endRaw });
}

function nextOccurrenceFromPatternRule(r, rule, nowTs) {
  if (!rule || typeof rule !== "object") return null;

  const startISO = String(r.startDateTime || "").trim();
  const endISO = String(r.endDateTime || "").trim();
  const startParts = parseIsoParts(startISO);
  const endParts = parseIsoParts(endISO);
  if (!startParts || !endParts) return null;

  const baseStartUtc = Date.parse(startISO);
  const baseEndUtc = Date.parse(endISO);
  if (!Number.isFinite(baseStartUtc)) return null;
  const durationMs = Number.isFinite(baseEndUtc) ? Math.max(0, baseEndUtc - baseStartUtc) : 0;

  const ruleType = String(rule.type || "").toLowerCase();
  const interval = Math.max(1, Number(rule.interval || 1));
  const untilRaw = String(r.recurrenceUntilDate || "").trim();
  const untilTs = Date.parse(untilRaw);
  const windowStartUtcMs = nowTs;
  const windowEndUtcMs = Number.isFinite(untilTs)
    ? Math.max(windowStartUtcMs, untilTs + 24 * 60 * 60 * 1000)
    : (windowStartUtcMs + 366 * 24 * 60 * 60 * 1000);

  if (ruleType === "weekly") {
    const byDay = Array.isArray(rule.byDay) ? rule.byDay : [];
    const byDaySet = new Set(byDay.map((d) => String(d || "").toUpperCase()).filter(Boolean));
    const defaultDay = weekdayKeyFromLocalParts(startParts);
    if (!byDaySet.size) byDaySet.add(defaultDay);

    const dayMs = 24 * 60 * 60 * 1000;
    const anchorWeekStart = startOfWeekLocalDate(startParts);
    const anchorWsUtc = Date.UTC(anchorWeekStart.year, anchorWeekStart.month - 1, anchorWeekStart.day, 0, 0, 0);

    for (let t = windowStartUtcMs; t <= windowEndUtcMs; t += dayMs) {
      const lp = utcMsToLocalParts(t, startParts.offset);
      const wk = weekdayKeyFromLocalParts(lp);
      if (!byDaySet.has(wk)) continue;

      const candWeekStart = startOfWeekLocalDate(lp);
      const candWsUtc = Date.UTC(candWeekStart.year, candWeekStart.month - 1, candWeekStart.day, 0, 0, 0);
      const weekIndex = Math.floor((candWsUtc - anchorWsUtc) / (7 * dayMs));
      if (weekIndex < 0 || weekIndex % interval !== 0) continue;

      const occ = {
        year: lp.year,
        month: lp.month,
        day: lp.day,
        hour: startParts.hour,
        minute: startParts.minute,
        second: startParts.second,
        offset: startParts.offset,
      };
      const occStartTs = partsToUtcMs(occ);
      if (occStartTs < nowTs || occStartTs < baseStartUtc) continue;
      const occEndParts = utcMsToLocalParts(occStartTs + durationMs, startParts.offset);
      return {
        startRaw: partsToIso(occ),
        startTs: occStartTs,
        endRaw: durationMs > 0 ? partsToIso(occEndParts) : "",
      };
    }
  }

  if (ruleType === "monthly") {
    const mode = rule.mode === "nthweekday" ? "nthweekday" : "monthday";
    const nowLocal = utcMsToLocalParts(nowTs, startParts.offset);
    const anchorY = startParts.year;
    const anchorM = startParts.month;
    const startMi = Math.max(0, monthsDiff(anchorY, anchorM, nowLocal.year, nowLocal.month));

    for (let mi = startMi; mi < startMi + 36; mi++) {
      if (mi % interval !== 0) continue;

      const base = new Date(Date.UTC(anchorY, anchorM - 1, 1, 12, 0, 0));
      base.setUTCMonth(base.getUTCMonth() + mi);
      const y = base.getUTCFullYear();
      const m = base.getUTCMonth() + 1;

      let days = [];
      if (mode === "monthday") {
        const md = Number(rule.byMonthday || startParts.day || 1);
        days = [Math.min(Math.max(1, md), daysInMonth(y, m))];
      } else {
        const setPos = Number(rule.setPos || 1);
        const byDayRaw = Array.isArray(rule.byDay) ? rule.byDay : [rule.byDay];
        const allowed = new Set(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
        const byDays = byDayRaw
          .map((d) => String(d || "").trim().toUpperCase())
          .filter((d) => allowed.has(d));
        const fallbackDay = weekdayKeyFromLocalParts(startParts);
        if (!byDays.length) byDays.push(fallbackDay);

        const uniq = [];
        for (const wd of byDays) {
          const day = nthWeekdayOfMonth(y, m, wd, setPos);
          if (!day) continue;
          if (!uniq.includes(day)) uniq.push(day);
        }
        days = uniq.sort((a,b) => a-b);
      }

      for (const day of days) {
        const occ = {
          year: y,
          month: m,
          day,
          hour: startParts.hour,
          minute: startParts.minute,
          second: startParts.second,
          offset: startParts.offset,
        };
        const occStartTs = partsToUtcMs(occ);
        if (occStartTs < nowTs || occStartTs < baseStartUtc) continue;
        if (Number.isFinite(untilTs) && occStartTs > untilTs + 24 * 60 * 60 * 1000) continue;
        const occEndParts = utcMsToLocalParts(occStartTs + durationMs, startParts.offset);
        return {
          startRaw: partsToIso(occ),
          startTs: occStartTs,
          endRaw: durationMs > 0 ? partsToIso(occEndParts) : "",
        };
      }
    }
  }

  return null;
}

function nextOccurrenceFromEventRow(r, nowTs) {
  const candidates = [];

  const recurrenceRule = safeParseJson(r.recurrenceRule, null);

  const recurrenceDates = safeParseJson(r.recurrenceDates, []);
  if (Array.isArray(recurrenceDates)) {
    for (const d of recurrenceDates) {
      pushParsedCandidate(candidates, d, "", nowTs, r.startDateTime, r.endDateTime);
    }
  }

  if (recurrenceRule && Array.isArray(recurrenceRule.items)) {
    for (const item of recurrenceRule.items) {
      if (typeof item === "string") {
        pushParsedCandidate(candidates, item, "", nowTs, r.startDateTime, r.endDateTime);
        continue;
      }
      if (item && typeof item === "object") {
        const start = item.startDateTime || item.date || item.start || item.datetime || "";
        const end = item.endDateTime || item.end || "";
        pushParsedCandidate(candidates, start, end, nowTs, r.startDateTime, r.endDateTime);
      }
    }
  }

  const patternCandidate = nextOccurrenceFromPatternRule(r, recurrenceRule, nowTs);
  if (patternCandidate) candidates.push(patternCandidate);

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.startTs - b.startTs);
  return candidates[0];
}

async function getUpcomingEventsForVenue(venue, limit) {
  const lim = Math.max(1, Math.min(50, parseInt(String(limit || 12), 10) || 12));
  const city = String(venue.city || "").trim();
  const name = String(venue.name || "").trim();
  const address = String(venue.address || "").trim();
  const needles = [name, address].map((s) => s.toLowerCase()).filter(Boolean);
  if (!city || !needles.length) return [];

  const eventCols = await getEventColumns();
  const hasCol = (name) => eventCols.has(name);

  const rows = await all(
    `SELECT id, slug, title, startDateTime, endDateTime, location, imageUrl, categories,
            ${hasCol("archived") ? "archived" : "0 AS archived"},
            ${hasCol("hasRecurrence") ? "hasRecurrence" : "0 AS hasRecurrence"},
            ${hasCol("recurrenceDates") ? "recurrenceDates" : "NULL AS recurrenceDates"},
            ${hasCol("recurrenceRule") ? "recurrenceRule" : "NULL AS recurrenceRule"},
            ${hasCol("recurrenceStartDate") ? "recurrenceStartDate" : "NULL AS recurrenceStartDate"},
            ${hasCol("recurrenceUntilDate") ? "recurrenceUntilDate" : "NULL AS recurrenceUntilDate"}
       FROM events
      WHERE LOWER(city) = LOWER(?)
        AND COALESCE(${hasCol("archived") ? "archived" : "0"}, 0) = 0
      ORDER BY datetime(startDateTime) ASC`,
    [city]
  );

  const nowTs = Date.now() - 5 * 60 * 1000;
  const out = [];
  for (const r of rows || []) {
    const loc = String(r.location || "").trim().toLowerCase();
    if (!loc) continue;
    const match = needles.some((n) => loc === n || loc.includes(n) || n.includes(loc));
    if (!match) continue;

    const st = Date.parse(String(r.startDateTime || ""));
    const en = Date.parse(String(r.endDateTime || ""));
    const effectiveEnd = Number.isFinite(en) ? en : st;

    const recurrenceRuleRaw = String(r.recurrenceRule || "").trim();
    const recurrenceDatesRaw = String(r.recurrenceDates || "").trim();
    const hasRecurrence =
      Number(r.hasRecurrence || 0) === 1 ||
      recurrenceRuleRaw !== "" ||
      recurrenceDatesRaw !== "" ||
      String(r.recurrenceStartDate || "").trim() !== "";

    const nextOccurrence = hasRecurrence ? nextOccurrenceFromEventRow(r, nowTs) : null;

    let hasFutureRecurrence = false;
    if (hasRecurrence) {
      hasFutureRecurrence = !!nextOccurrence;
      if (!hasFutureRecurrence) {
        const untilTs = Date.parse(String(r.recurrenceUntilDate || ""));
        if (Number.isFinite(untilTs)) {
          hasFutureRecurrence = untilTs >= nowTs;
        } else {
          // No explicit end date for recurrence: treat as ongoing until archived.
          hasFutureRecurrence = true;
        }
      }
    }

    const isCurrentByStartEnd = Number.isFinite(effectiveEnd) && effectiveEnd >= nowTs;
    if (!isCurrentByStartEnd && !hasFutureRecurrence) continue;

    let displayStart = String(r.startDateTime || "");
    let displayEnd = String(r.endDateTime || "");
    if (nextOccurrence) {
      displayStart = nextOccurrence.startRaw;
      if (nextOccurrence.endRaw) {
        displayEnd = nextOccurrence.endRaw;
      } else {
        const durMs = (Number.isFinite(st) && Number.isFinite(en) && en > st) ? (en - st) : 0;
        if (durMs > 0) {
          displayEnd = new Date(nextOccurrence.startTs + durMs).toISOString();
        }
      }
    }

    out.push({
      id: Number(r.id || 0),
      slug: String(r.slug || ""),
      title: String(r.title || ""),
      startDateTime: displayStart,
      endDateTime: displayEnd,
      location: String(r.location || ""),
      imageUrl: String(r.imageUrl || ""),
      categories: Array.isArray(safeParseJson(r.categories, [])) ? safeParseJson(r.categories, []) : [],
    });
  }

  out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
  return dedupeByKey(out).slice(0, lim);
}

router.get("/", async (req, res) => {
  try {
    await ensureVenueSchema();

    const city = String(req.query.city || "").trim();
    const q = String(req.query.q || "").trim();
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || "50"), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset || "0"), 10) || 0);
    const includeUpcoming = String(req.query.includeUpcoming || "0") === "1";
    const upcomingLimit = Math.max(1, Math.min(24, parseInt(String(req.query.upcomingLimit || "6"), 10) || 6));

    const where = [];
    const params = [];

    if (city) {
      where.push("LOWER(city) = LOWER(?)");
      params.push(city);
    }
    if (q) {
      where.push("(name LIKE ? OR slug LIKE ? OR address LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const totalRow = await get(`SELECT COUNT(*) AS n FROM venues ${whereSql}`, params);
    const rows = await all(
      `SELECT * FROM venues ${whereSql} ORDER BY name ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const mapped = [];
    for (const r of rows || []) {
      const v = mapVenueRow(r);
      if (includeUpcoming) {
        v.upcomingEvents = await getUpcomingEventsForVenue(v, upcomingLimit);
      }
      mapped.push(v);
    }

    return res.json({
      data: mapped,
      meta: {
        total: Number(totalRow && totalRow.n ? totalRow.n : 0),
        limit,
        offset,
        hasMore: offset + mapped.length < Number(totalRow && totalRow.n ? totalRow.n : 0),
        nextOffset: offset + mapped.length < Number(totalRow && totalRow.n ? totalRow.n : 0) ? offset + mapped.length : null,
      },
    });
  } catch (err) {
    console.error("[/venues] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/resolve", async (req, res) => {
  try {
    await ensureVenueSchema();

    const q = String(req.query.q || "").trim();
    const city = String(req.query.city || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const qLower = q.toLowerCase();
    const whereCity = city ? "AND LOWER(city) = LOWER(?)" : "";
    const cityParams = city ? [city] : [];

    const exact = await get(
      `SELECT * FROM venues
        WHERE (LOWER(name) = LOWER(?) OR LOWER(address) = LOWER(?) OR LOWER(slug) = LOWER(?))
        ${whereCity}
        LIMIT 1`,
      [q, q, q, ...cityParams]
    );
    if (exact) return res.json({ data: mapVenueRow(exact) });

    const like = `%${q}%`;
    const rows = await all(
      `SELECT * FROM venues
        WHERE (name LIKE ? OR address LIKE ? OR slug LIKE ?)
        ${whereCity}
        ORDER BY
          CASE
            WHEN LOWER(name) LIKE LOWER(?) THEN 0
            WHEN LOWER(address) LIKE LOWER(?) THEN 1
            ELSE 2
          END,
          name ASC
        LIMIT 20`,
      [like, like, like, `${qLower}%`, `${qLower}%`, ...cityParams]
    );

    const best = (rows || [])[0] || null;
    if (!best) return res.status(404).json({ error: "Venue not found" });

    return res.json({ data: mapVenueRow(best) });
  } catch (err) {
    console.error("[/venues/resolve] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/slug/:slug", async (req, res) => {
  try {
    await ensureVenueSchema();

    const slug = String(req.params.slug || "").trim().toLowerCase();
    if (!slug) return res.status(400).json({ error: "Invalid slug" });

    const row = await get("SELECT * FROM venues WHERE LOWER(slug) = LOWER(?) LIMIT 1", [slug]);
    if (!row) return res.status(404).json({ error: "Venue not found" });

    const shouldTrack = String(req.query.track || "1") !== "0";
    if (shouldTrack) {
      await incrementVenueView(row.id);
      row.viewCount = Number(row.viewCount || 0) + 1;
    }

    const venue = mapVenueRow(row);
    const upcomingLimit = Math.max(1, Math.min(24, parseInt(String(req.query.upcomingLimit || "12"), 10) || 12));
    venue.upcomingEvents = await getUpcomingEventsForVenue(venue, upcomingLimit);

    return res.json({ data: venue });
  } catch (err) {
    console.error("[/venues/slug/:slug] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/:idOrSlug/out/phone", async (req, res) => {
  try {
    await ensureVenueSchema();

    const row = await getVenueRowByIdOrSlug(req.params.idOrSlug);
    if (!row) return res.status(404).send("Venue not found");

    const phoneRaw = String(row.phone || "").trim();
    if (!phoneRaw) return res.status(404).send("Phone not available");

    const digits = phoneRaw.replace(/\D+/g, "");
    const tel = digits ? `tel:${digits}` : `tel:${phoneRaw}`;

    await incrementVenueCounter(row.id, "phoneClickCount");
    return res.redirect(302, tel);
  } catch (err) {
    console.error("[/venues/:idOrSlug/out/phone] error:", err && err.stack ? err.stack : err);
    return res.status(500).send("Server error");
  }
});

router.get("/:idOrSlug/out/website", async (req, res) => {
  try {
    await ensureVenueSchema();

    const row = await getVenueRowByIdOrSlug(req.params.idOrSlug);
    if (!row) return res.status(404).send("Venue not found");

    const website = normalizeHttpUrl(row.website || "");
    if (!website) return res.status(404).send("Website not available");

    await incrementVenueCounter(row.id, "websiteClickCount");
    return res.redirect(302, website);
  } catch (err) {
    console.error("[/venues/:idOrSlug/out/website] error:", err && err.stack ? err.stack : err);
    return res.status(500).send("Server error");
  }
});

router.get("/:idOrSlug/out/social/:platform", async (req, res) => {
  try {
    await ensureVenueSchema();

    const row = await getVenueRowByIdOrSlug(req.params.idOrSlug);
    if (!row) return res.status(404).send("Venue not found");

    const social = safeParseJson(row.socialJson, {});
    const platform = normalizeSocialPlatform(req.params.platform);
    const allowed = new Set(["facebook", "instagram", "x", "tiktok", "youtube", "linkedin"]);
    if (!allowed.has(platform)) return res.status(404).send("Social platform not supported");

    const socialUrl = normalizeHttpUrl((social && typeof social === "object") ? social[platform] : "");
    if (!socialUrl) return res.status(404).send("Social link not available");

    await incrementVenueCounter(row.id, "socialClickCount");
    return res.redirect(302, socialUrl);
  } catch (err) {
    console.error("[/venues/:idOrSlug/out/social/:platform] error:", err && err.stack ? err.stack : err);
    return res.status(500).send("Server error");
  }
});

router.get("/:idOrSlug", async (req, res) => {
  try {
    await ensureVenueSchema();

    const raw = String(req.params.idOrSlug || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing id/slug" });

    const row = await getVenueRowByIdOrSlug(raw);

    if (!row) return res.status(404).json({ error: "Venue not found" });

    const shouldTrack = String(req.query.track || "1") !== "0";
    if (shouldTrack) {
      await incrementVenueView(row.id);
      row.viewCount = Number(row.viewCount || 0) + 1;
    }

    const venue = mapVenueRow(row);
    const upcomingLimit = Math.max(1, Math.min(24, parseInt(String(req.query.upcomingLimit || "12"), 10) || 12));
    venue.upcomingEvents = await getUpcomingEventsForVenue(venue, upcomingLimit);

    return res.json({ data: venue });
  } catch (err) {
    console.error("[/venues/:idOrSlug] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
