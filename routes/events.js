"use strict";

const express = require("express");
const router = express.Router();
const { all, get, run } = require("../db");
const crypto = require("crypto");
const { safeParseJson } = require("../lib/json");
const { toPublicEventListItem } = require("../lib/public-event-list");
const { matchesVenueLocation, normalizeVenueIdentifier } = require("../lib/venue-matching");
const { normalizeEventReportChanges } = require("../lib/event-report-changes");
const { notifyAreaApprovers } = require("../lib/admin-notification-email");
const { esc } = require("../lib/html");
const { findEventCategory } = require("../lib/admin-constants");
const {
  hasValidEventDateRange,
  normalizeCategoryInput,
  normalizeEventDateTimes,
  normalizeMultiDaySchedule,
  requiredEventFields,
} = require("../lib/event-input");
const { clientIp, createRateLimiter } = require("../lib/public-rate-limit");
const { publicLifecycle, updateEventWithChange } = require("../lib/event-lifecycle");
const {
  buildEventStructuredData,
  buildSeoDescriptor,
  deriveEventSeoFields,
} = require("../lib/public-seo");
const PAST_EVENTS_LIMIT = 24;
const PAST_EVENTS_CACHE_MS = 5 * 60 * 1000;
const pastEventsCache = new Map();
const EVENT_LIST_CACHE_MS = 30 * 1000;
const EVENT_LIST_CACHE_MAX_ENTRIES = 100;
const eventListCache = new Map();
const EVENT_REPORT_TYPES = new Set(["changed_details", "cancelled", "other"]);
const EVENT_REPORT_SOURCES = new Set(["event_page"]);
const EVENT_REPORT_RATE_WINDOW_MS = 15 * 60 * 1000;
const EVENT_REPORT_MAX_PER_IP = 12;
const EVENT_REPORT_MAX_PER_IP_EVENT = 3;
const eventReportRateLimiter = createRateLimiter({
  windowMs: EVENT_REPORT_RATE_WINDOW_MS,
  max: EVENT_REPORT_MAX_PER_IP,
});
const eventReportPerEventRateLimiter = createRateLimiter({
  windowMs: EVENT_REPORT_RATE_WINDOW_MS,
  max: EVENT_REPORT_MAX_PER_IP_EVENT,
});
const eventSubmissionRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 8 });
const eventViewRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 240 });
const eventTicketClickRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
const eventEngagementRateLimiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 60 });
const ADMIN_APP_URL = String(process.env.ADMIN_APP_URL || "https://api.opencircleapi.com").replace(/\/$/, "");

function readCachedPayload(cache, key, nowTs) {
  const cached = cache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= nowTs) {
    cache.delete(key);
    return null;
  }
  return cached.payload;
}

function cachePayload(cache, key, payload, ttlMs, maxEntries) {
  if (cache.size >= maxEntries) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { expiresAt: Date.now() + ttlMs, payload });
}

// Public event responses are safe to cache only briefly. Every event mutation
// clears both caches through the server middleware below, so this is a speed-up
// rather than a source of stale event content.
function clearPublicEventCaches() {
  eventListCache.clear();
  pastEventsCache.clear();
}

router.clearPublicEventCaches = clearPublicEventCaches;

/**
 * Helpers
 */

function escapeXml(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function eventReportError(res, status, error, message) {
  return res.status(status).json({ ok: false, error, message });
}

function normalizeReportedEventUrl(value) {
  if (value === undefined || value === null || value === "") return { value: null };
  if (typeof value !== "string") return { error: "Event URL must be a string." };
  const trimmed = value.trim();
  if (trimmed.length > 2048) return { error: "Event URL must be 2048 characters or fewer." };
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { error: "Event URL must use HTTP or HTTPS." };
    return { value: parsed.toString() };
  } catch (_) {
    return { error: "Event URL must be a valid HTTP or HTTPS URL." };
  }
}

function toDateValue(iso) {
  const s = String(iso || "").trim();
  const match = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : "";
}

function normalizeYmd(value) {
  const s = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

function normalizeWeekdayList(input) {
  const values = Array.isArray(input) ? input : (String(input || "").trim() ? [input] : []);
  const allowed = new Set(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
  const uniq = [];
  values
    .map((value) => String(value || "").trim().toUpperCase())
    .filter(Boolean)
    .forEach((value) => {
      if (!allowed.has(value) || uniq.includes(value)) return;
      uniq.push(value);
    });
  return uniq;
}

function normalizeRecurringItems(raw, fallbackStartIso, fallbackEndIso) {
  let parsed = safeParseJson(raw, []);
  if (!Array.isArray(parsed)) parsed = [];
  const uniqDates = [];
  const items = [];
  for (const item of parsed) {
    if (typeof item === "string") {
      const date = normalizeYmd(item);
      if (!date) continue;
      if (!uniqDates.includes(date)) uniqDates.push(date);
      if (fallbackStartIso && fallbackEndIso) {
        items.push({
          date,
          start: date + String(fallbackStartIso).slice(10),
          end: date + String(fallbackEndIso).slice(10),
        });
      }
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const start = String(item.start || "").trim();
    const end = String(item.end || "").trim();
    const date = normalizeYmd(item.date || (start ? start.slice(0, 10) : ""));
    if (!date) continue;
    if (!uniqDates.includes(date)) uniqDates.push(date);
    if (start && end) items.push({ date, start, end });
  }
  uniqDates.sort();
  items.sort((a, b) => String(a.start || "").localeCompare(String(b.start || "")));
  return { uniqDates, items };
}

// Public submission endpoint (frontend form -> pending approvals)
router.post("/submit", async (req, res) => {
  try {
    const submitIp = clientIp(req);
    if (!eventSubmissionRateLimiter.consume(`submit:${submitIp}`)) {
      res.set("Retry-After", String(eventSubmissionRateLimiter.retryAfterSeconds));
      return res.status(429).json({ ok: false, error: "Too many event submissions. Please try again later." });
    }
    let body = req.body;
    if (typeof body === "string" && body.trim()) {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body && typeof body === "object" ? body : {};

    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    const location = String(body.location || "").trim();
    const organizer = String(body.organizer || "").trim();
    const requestedCity = String(body.city || "Enumclaw").trim() || "Enumclaw";
    const city = ["plateau", "plateau area", "plateau regional"].includes(requestedCity.toLowerCase())
      ? "Plateau Area"
      : requestedCity;

    let startDateTime = String(body.startDateTime || "").trim();
    let endDateTime = String(body.endDateTime || "").trim();

    const missingSubmissionFields = requiredEventFields(
      { title, description, location, startDateTime },
      ["title", "description", "location", "startDateTime"]
    );
    if (missingSubmissionFields.length) {
      return res.status(400).json({ ok: false, error: "Missing required fields." });
    }

    // Shared normalization keeps anonymous submissions aligned with editor
    // saves while retaining this route's existing one-hour default.
    ({ startDateTime, endDateTime } = normalizeEventDateTimes({ startDateTime, endDateTime, defaultEndHours: 1 }));
    if (!hasValidEventDateRange(startDateTime, endDateTime)) {
      return res.status(400).json({ ok: false, error: "Invalid date/time." });
    }

    const ticketUrl = String(body.ticketUrl || "").trim() || null;
    const eventLink = String(body.eventLink || "").trim() || null;
    const cats = normalizeCategoryInput(body.categories);
    const categories = JSON.stringify(cats);

    const imageUrl = String(body.imageUrl || "").trim() || null;
    const ticketLabel = String(body.ticketLabel || "").trim() || "Tickets";
    const eventDetails = String(body.eventDetails || "").trim() || "";
    const goodToKnow = String(body.goodToKnow || "").trim() || "";
    const eventTypeChoice = String(body.eventTypeChoice || "").trim().toLowerCase();
    const hasRecurrenceFlag = String(body.hasRecurrence || "").trim() === "1" || eventTypeChoice === "recurring";
    const recurrenceType = String(body.recurrenceType || "none").trim().toLowerCase();
    const recurrenceInterval = Math.max(1, parseInt(String(body.recurrenceInterval || "1"), 10) || 1);
    let hasRecurrence = hasRecurrenceFlag && recurrenceType !== "none" ? 1 : 0;
    let recurrenceRule = null;
    let recurrenceDatesJson = null;
    let recurrenceStartDate = null;
    let recurrenceUntilDate = null;
    const multiDaySchedule = eventTypeChoice === "multi-day"
      ? normalizeMultiDaySchedule(body.multiDayScheduleJson || body.multiDaySchedule)
      : [];
    const multiDayScheduleJson = multiDaySchedule.length ? JSON.stringify(multiDaySchedule) : null;

    if (hasRecurrence) {
      recurrenceStartDate = normalizeYmd(body.recurrenceStartDate) || normalizeYmd(toDateValue(startDateTime));
      // A recurrence cutoff is distinct from a single occurrence's end. Only
      // persist an explicitly supplied recurrenceUntilDate; otherwise the
      // schedule remains open-ended according to its recurrence rule.
      recurrenceUntilDate = normalizeYmd(body.recurrenceUntilDate);

      if (recurrenceType === "custom") {
        const normalized = normalizeRecurringItems(
          body.recurrenceDatesJson || body.recurrenceDates,
          startDateTime,
          endDateTime
        );
        recurrenceRule = normalized.items.length ? { type: "custom", items: normalized.items } : { type: "custom" };
        recurrenceDatesJson = JSON.stringify(normalized.uniqDates);
      } else if (recurrenceType === "weekly") {
        recurrenceRule = {
          type: "weekly",
          interval: recurrenceInterval,
          byDay: normalizeWeekdayList(body.weeklyByDay),
        };
      } else if (recurrenceType === "monthly") {
        const monthlyMode = String(body.monthlyMode || "monthday").trim().toLowerCase();
        if (monthlyMode === "nthweekday") {
          recurrenceRule = {
            type: "monthly",
            interval: recurrenceInterval,
            mode: "nthweekday",
            setPos: parseInt(String(body.setPos || "1"), 10) || 1,
            byDay: normalizeWeekdayList(body.monthlyByDay),
          };
        } else {
          recurrenceRule = {
            type: "monthly",
            interval: recurrenceInterval,
            mode: "monthday",
            byMonthday: Math.max(1, Math.min(31, parseInt(String(body.byMonthday || "0"), 10) || 0)),
          };
        }
      } else if (recurrenceType === "annual" || recurrenceType === "yearly") {
        const startParts = parseIsoParts(startDateTime);
        recurrenceRule = {
          type: "annual",
          interval: recurrenceInterval,
          byMonth: Math.max(1, Math.min(12, parseInt(String(body.annualMonth || startParts?.month || "0"), 10) || startParts?.month || 1)),
          byMonthday: Math.max(1, Math.min(31, parseInt(String(body.annualMonthday || startParts?.day || "0"), 10) || startParts?.day || 1)),
        };
      } else {
        hasRecurrence = 0;
      }
    }

    const submitterEmail = String(body.submitterEmail || "").trim() || "";
    const approvalNotes = String(body.approvalNotes || "").trim() || "";
    const source = String(body.source || "").trim() || "wp_frontend";
    let submissionId = String(body.submissionId || "").trim();
    if (!submissionId) {
      submissionId = (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"));
    }

    const inserted = await run(
      `INSERT INTO pending_events
        (city, title, description, eventDetails, goodToKnow, ticketUrl, ticketLabel,
         startDateTime, endDateTime, location, organizer, imageUrl, eventLink, categories,
         submitterEmail, approvalNotes, source, submissionId, hasRecurrence, recurrenceRule,
         recurrenceDates, recurrenceStartDate, recurrenceUntilDate, multiDaySchedule)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        city, title, description, eventDetails, goodToKnow, ticketUrl, ticketLabel,
        startDateTime, endDateTime, location, organizer, imageUrl, eventLink, categories,
        submitterEmail, approvalNotes, source, submissionId, hasRecurrence,
        recurrenceRule ? JSON.stringify(recurrenceRule) : null,
        recurrenceDatesJson, recurrenceStartDate, recurrenceUntilDate, multiDayScheduleJson
      ]
    );

    void notifyAreaApprovers({
      category: "eventSubmissions",
      city,
      subject: `New event submission: ${title}`,
      text: `A new event submission needs review in ${city}.\n\n${title}\n${startDateTime}\n${location || ""}\n\nReview it in OpenCircle: ${ADMIN_APP_URL}/admin/approve-events`,
      html: `<p>A new event submission needs review in <strong>${esc(city)}</strong>.</p><p><strong>${esc(title)}</strong><br>${esc(startDateTime)}<br>${esc(location || "")}</p><p><a href="${esc(`${ADMIN_APP_URL}/admin/approve-events`)}">Review submission</a></p>`,
    }).catch((error) => console.error("[event submission notification]", error));

    return res.json({ ok: true, id: inserted.lastID, submissionId });
  } catch (err) {
    console.error("[POST /events/submit] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

// Feature purchase hook (WooCommerce -> submissionId)
router.post("/feature", async (req, res) => {
  try {
    let body = req.body;
    if (typeof body === "string" && body.trim()) {
      try { body = JSON.parse(body); } catch { body = {}; }
    }
    body = body && typeof body === "object" ? body : {};

    const submissionId = String(body.submissionId || "").trim();
    const orderId = String(body.orderId || "").trim();
    if (!submissionId || !orderId) {
      return res.status(400).json({ ok: false, error: "Missing submissionId or orderId" });
    }

    // Pending first
    const pending = await get(
      "SELECT id, startDateTime, endDateTime FROM pending_events WHERE submissionId = ? LIMIT 1",
      [submissionId]
    );
    if (pending) {
      const featuredUntil = String(pending.endDateTime || pending.startDateTime || "").trim();
      await run(
        `UPDATE pending_events
         SET featuredOrderId = ?, featuredPurchasedAt = datetime('now'), featuredUntil = ?
         WHERE id = ?`,
        [orderId, featuredUntil, pending.id]
      );
      return res.json({ ok: true, target: "pending", pendingId: pending.id, featuredUntil });
    }

    // Else events
    const evt = await get(
      "SELECT id, startDateTime, endDateTime FROM events WHERE submissionId = ? LIMIT 1",
      [submissionId]
    );
    if (evt) {
      const featuredUntil = String(evt.endDateTime || evt.startDateTime || "").trim();
      await updateEventWithChange({
        eventId: evt.id,
        fields: [
          ["featured", 1],
          ["featuredOrderId", orderId],
          ["featuredPurchasedAt", new Date().toISOString()],
          ["featuredUntil", featuredUntil],
        ],
        changeType: "updated",
      });
      return res.json({ ok: true, target: "event", eventId: evt.id, featuredUntil });
    }

    return res.status(404).json({ ok: false, error: "Not found" });
  } catch (err) {
    console.error("[POST /events/feature] error:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
});

async function buildEventSitemapXml(mode = "upcoming") {
  const base = String(process.env.PUBLIC_BASE_URL || process.env.PUBLIC_SITE_URL || "https://enumclawevents.org").replace(/\/$/, "");
  const info = await all("PRAGMA table_info(events)");
  const colSet = new Set((info || []).map((r) => String(r.name)));
  const cols = ["id", "slug", "archived", "multiDaySchedule"];
  if (colSet.has("updatedAt")) cols.push("updatedAt");
  if (colSet.has("createdAt")) cols.push("createdAt");
  if (colSet.has("expireDate")) cols.push("expireDate");
  if (colSet.has("startDateTime")) cols.push("startDateTime");
  if (colSet.has("endDateTime")) cols.push("endDateTime");
  if (colSet.has("hasRecurrence")) cols.push("hasRecurrence");
  if (colSet.has("recurrenceRule")) cols.push("recurrenceRule");
  if (colSet.has("recurrenceDates")) cols.push("recurrenceDates");
  if (colSet.has("recurrenceStartDate")) cols.push("recurrenceStartDate");
  if (colSet.has("recurrenceUntilDate")) cols.push("recurrenceUntilDate");

  const rows = await all(
    `SELECT ${cols.join(", ")}
     FROM events
     WHERE archived = 0
       AND slug IS NOT NULL
       AND trim(slug) <> ''`
  );

  const nowDate = new Date().toISOString().slice(0, 10);
  const nowTs = Date.now();
  const windowStartUtc = mode === "past"
    ? nowTs - 3650 * 86400 * 1000
    : nowTs - 5 * 60 * 1000;
  const windowEndUtc = mode === "past"
    ? nowTs + 5 * 60 * 1000
    : nowTs + 365 * 86400 * 1000;

  const urls = (rows || []).map((r) => {
    const row = normalizeRowTimes(r);
    const slug = String(r.slug || "").trim();
    if (!slug) return null;

    if (colSet.has("expireDate") && mode !== "past") {
      const expireDate = String(r.expireDate || "").trim();
      if (expireDate && expireDate < nowDate) return null;
    }

    const normalized = {
      ...row,
      categories: normalizeCats(row),
      multiDaySchedule: normalizeMultiDaySchedule(row.multiDaySchedule),
      hasRecurrence: Number(row.hasRecurrence || 0),
      recurrenceRule: safeParseJson(row.recurrenceRule, null),
      recurrenceDates: safeParseJson(row.recurrenceDates, []),
      featured: readFeaturedActive(row),
      eddiesPick: readEddiesPick(row),
    };

    let include = false;
    if (normalized.hasRecurrence && normalized.recurrenceRule) {
      const occurrences = generateOccurrences(normalized, windowStartUtc, windowEndUtc);
      include = (occurrences || []).some((occurrence) => {
        const endTs = Date.parse(String(occurrence.endDateTime || occurrence.startDateTime || ""));
        if (!Number.isFinite(endTs)) return false;
        return mode === "past" ? endTs < nowTs : endTs >= nowTs - 5 * 60 * 1000;
      });
    } else {
      const endTs = effectiveEndTs(normalized);
      if (Number.isFinite(endTs)) {
        include = mode === "past" ? endTs < nowTs : endTs >= nowTs - 5 * 60 * 1000;
      }
    }
    if (!include) return null;

    const lastmod = String(r.updatedAt || r.createdAt || "").trim();
    const loc = `${base}/events/${encodeURIComponent(slug)}`;
    return `
  <url>
    <loc>${escapeXml(loc)}</loc>
    ${lastmod ? `<lastmod>${escapeXml(lastmod)}</lastmod>` : ""}
  </url>`;
  }).filter(Boolean);

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.join("\n")}
</urlset>`;
}

// Public sitemap for upcoming/current events
router.get("/sitemap.xml", async (_req, res) => {
  try {
    const xml = await buildEventSitemapXml("upcoming");
    res.setHeader("Content-Type", "application/xml");
    return res.status(200).send(xml);
  } catch (err) {
    console.error("[GET /events/sitemap.xml] error:", err);
    return res.status(500).send("Server error");
  }
});

router.get("/sitemap-past.xml", async (_req, res) => {
  try {
    const xml = await buildEventSitemapXml("past");
    res.setHeader("Content-Type", "application/xml");
    return res.status(200).send(xml);
  } catch (err) {
    console.error("[GET /events/sitemap-past.xml] error:", err);
    return res.status(500).send("Server error");
  }
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

function readFeatured(row) {
  // supports legacy "Featured" column name too, and common checkbox strings
  const v = (row && (row.featured ?? row.Featured)) ?? 0;
  const s = String(v).trim().toLowerCase();
  return (s === "1" || s === "true" || s === "yes" || s === "on") ? 1 : 0;
}

function readFeaturedActive(row) {
  const isFeatured = readFeatured(row);
  if (!isFeatured) return 0;
  const until = String((row && (row.featuredUntil ?? row.featured_until)) || "").trim();
  if (!until) return 1;
  const ts = Date.parse(until);
  if (!Number.isFinite(ts)) return 1;
  return ts > Date.now() ? 1 : 0;
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

// Recurring events are authored in OpenCircle's configured local timezone.
// Recalculate the offset for each generated local date so a weekly, monthly,
// or annual event keeps its wall-clock time when DST changes.
function zonedLocalParts(year, month, day, hour, minute, second, fallbackOffset) {
  const dt = DateTime.fromObject({ year, month, day, hour, minute, second: second || 0 }, { zone: DEFAULT_TZ });
  if (!dt.isValid) return { year, month, day, hour, minute, second: second || 0, offset: fallbackOffset };
  return {
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
    second: dt.second,
    offset: dt.toFormat("ZZ"),
  };
}

function zonedPartsFromUtc(utcMs, fallbackOffset) {
  const dt = DateTime.fromMillis(utcMs, { zone: DEFAULT_TZ });
  if (!dt.isValid) return utcMsToLocalParts(utcMs, fallbackOffset);
  return {
    year: dt.year,
    month: dt.month,
    day: dt.day,
    hour: dt.hour,
    minute: dt.minute,
    second: dt.second,
    offset: dt.toFormat("ZZ"),
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

function buildRecurrenceBounds(row, offset, windowStartUtcMs, windowEndUtcMs) {
  let startMs = windowStartUtcMs;
  let endMs = windowEndUtcMs;
  const startDate = String(row?.recurrenceStartDate || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    const [year, month, day] = startDate.split("-").map(Number);
    startMs = Math.max(startMs, partsToUtcMs(zonedLocalParts(year, month, day, 0, 0, 0, offset)));
  }
  const untilDate = String(row?.recurrenceUntilDate || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(untilDate)) {
    const [year, month, day] = untilDate.split("-").map(Number);
    endMs = Math.min(endMs, partsToUtcMs(zonedLocalParts(year, month, day, 23, 59, 59, offset)));
  }
  return { startMs, endMs };
}

// A recurring row stores one event template, not a materialized occurrence.
// Long or malformed template end dates are insufficient evidence of a schedule
// cutoff: only recurrenceUntilDate can stop an otherwise valid recurrence.
// Avoid emitting a fabricated months-long end time when duration is unknown.
const MAX_RECURRING_OCCURRENCE_DURATION_MS = 14 * 86400 * 1000;

function recurrenceTiming(eventRow) {
  const startParts = parseIsoParts(eventRow?.startDateTime);
  const endParts = parseIsoParts(eventRow?.endDateTime);
  const startUtc = Date.parse(String(eventRow?.startDateTime || ""));
  const endUtc = Date.parse(String(eventRow?.endDateTime || ""));
  const hasValidRange = Number.isFinite(startUtc) && Number.isFinite(endUtc) && endUtc >= startUtc;
  const rawDurationMs = hasValidRange ? endUtc - startUtc : NaN;
  if (!startParts || !endParts || !hasValidRange || rawDurationMs > MAX_RECURRING_OCCURRENCE_DURATION_MS) {
    return { durationMs: null, hasKnownDuration: false };
  }
  return { durationMs: rawDurationMs, hasKnownDuration: true };
}

function generatedOccurrenceEnd(occStartUtc, durationMs, hasKnownDuration, offset) {
  if (!hasKnownDuration) return { endUtc: occStartUtc, endDateTime: "" };
  const endUtc = occStartUtc + durationMs;
  return { endUtc, endDateTime: partsToIso(zonedPartsFromUtc(endUtc, offset)) };
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
  const timing = recurrenceTiming(eventRow);
  const durationMs = timing.durationMs;
  const startParts = parseIsoParts(eventRow.startDateTime);
  if (!startParts) return [];
  const bounds = buildRecurrenceBounds(eventRow, startParts.offset, windowStartUtcMs, windowEndUtcMs);
  const boundedStart = bounds.startMs;
  const boundedEnd = bounds.endMs;
  if (boundedStart > boundedEnd) return [];

  // 1) ✅ Preferred: recurrenceRule.items (true per-occurrence start/end)
  const rule = safeParseJson(eventRow.recurrenceRule, null);
  if (rule && String(rule.type || "").toLowerCase() === "custom" && Array.isArray(rule.items) && rule.items.length) {
    const out = [];

    for (const it of rule.items) {
      const startIso = toIsoIfValid(it && it.start);
      if (!startIso) continue;

      const occStartUtc = Date.parse(startIso);
      if (!Number.isFinite(occStartUtc)) continue;

      let endIso = toIsoIfValid(it && it.end);
      if (!endIso && durationMs > 0) {
        // If item.end missing, compute end using base duration while keeping the item's offset
        const sp = parseIsoParts(startIso);
        if (sp) {
          const occEndUtc = occStartUtc + durationMs;
          const ep = zonedPartsFromUtc(occEndUtc, sp.offset);
          endIso = partsToIso(ep);
        }
      }
      const occEndUtc = endIso ? Date.parse(endIso) : (timing.hasKnownDuration ? occStartUtc + durationMs : occStartUtc);
      if (!Number.isFinite(occEndUtc)) continue;
      if (occEndUtc < boundedStart || occStartUtc > boundedEnd) continue;
      if (Number.isFinite(baseStartUtc) && occStartUtc < baseStartUtc) continue;

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
  const startUtc = Date.parse(eventRow.startDateTime);
  if (!Number.isFinite(startUtc)) return [];
  const offset = startParts.offset;

  const dates = safeParseJson(eventRow.recurrenceDates, []);
  if (!Array.isArray(dates) || dates.length === 0) return [];

  const out = [];
  for (const d of dates) {
    const s = String(d || "").trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;

    const [yy, mm, dd] = s.split("-").map(Number);

    const occLocalParts = zonedLocalParts(yy, mm, dd, startParts.hour, startParts.minute, startParts.second, offset);

    const occStartUtc = partsToUtcMs(occLocalParts);
    const occurrenceEnd = generatedOccurrenceEnd(occStartUtc, durationMs, timing.hasKnownDuration, offset);

    if (occurrenceEnd.endUtc < boundedStart || occStartUtc > boundedEnd) continue;
    if (occStartUtc < startUtc) continue;

    out.push({
      occurrenceDate: toYmd(occLocalParts),
      startDateTime: partsToIso(occLocalParts),
      endDateTime: occurrenceEnd.endDateTime,
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
  if (!startParts) return [];

  const startUtc = Date.parse(startISO);
  if (!Number.isFinite(startUtc)) return [];

  const timing = recurrenceTiming(eventRow);
  const durationMs = timing.durationMs;
  const offset = startParts.offset;
  const bounds = buildRecurrenceBounds(eventRow, offset, windowStartUtcMs, windowEndUtcMs);
  const boundedStart = bounds.startMs;
  const boundedEnd = bounds.endMs;

  const rule = safeParseJson(eventRow.recurrenceRule, null);
  if (!rule || Number(eventRow.hasRecurrence || 0) !== 1) return [];
  if (boundedStart > boundedEnd) return [];

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
    // Iterating UTC days crosses the fall DST transition twice for one local
    // calendar date.  A weekly rule must emit at most one occurrence per
    // local date, while retaining that date's correct wall-clock offset.
    const seenOccurrenceDates = new Set();

    const dayMs = 86400 * 1000;
    for (let t = boundedStart; t <= boundedEnd; t += dayMs) {
      const lp = zonedPartsFromUtc(t, offset);
      const wk = weekdayKeyFromLocalParts(lp);
      if (!byDaySet.has(wk)) continue;

      const candWeekStart = startOfWeekLocalDate(lp);
      const anchorWsUtc = Date.UTC(anchorWeekStart.year, anchorWeekStart.month - 1, anchorWeekStart.day, 0, 0, 0);
      const candWsUtc = Date.UTC(candWeekStart.year, candWeekStart.month - 1, candWeekStart.day, 0, 0, 0);
      const weekIndex = Math.floor((candWsUtc - anchorWsUtc) / (7 * dayMs));
      if (weekIndex < 0) continue;
      if (weekIndex % interval !== 0) continue;

      const occLocalParts = zonedLocalParts(lp.year, lp.month, lp.day, startParts.hour, startParts.minute, startParts.second, offset);

      const occStartUtc = partsToUtcMs(occLocalParts);
      const occurrenceEnd = generatedOccurrenceEnd(occStartUtc, durationMs, timing.hasKnownDuration, offset);

      if (occurrenceEnd.endUtc < boundedStart || occStartUtc > boundedEnd) continue;
      if (occStartUtc < startUtc) continue;
      const occurrenceDate = toYmd(occLocalParts);
      if (seenOccurrenceDates.has(occurrenceDate)) continue;
      seenOccurrenceDates.add(occurrenceDate);

      out.push({
        occurrenceDate,
        startDateTime: partsToIso(occLocalParts),
        endDateTime: occurrenceEnd.endDateTime,
        label: formatLabelLocal(occLocalParts),
      });
    }

    out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
    return out;
  }

  if (type === "monthly") {
    const mode = rule.mode === "nthweekday" ? "nthweekday" : "monthday";

    const windowStartLocal = zonedPartsFromUtc(boundedStart, offset);
    const windowEndLocal = zonedPartsFromUtc(boundedEnd, offset);

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

      let days = [];

      if (mode === "monthday") {
        const md = Number(rule.byMonthday || 0);
        if (!md) continue;
        days = [Math.min(md, daysInMonth(y, m))];
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
        days = uniq;
      }

      for (const day of days) {
        const occLocalParts = zonedLocalParts(y, m, day, startParts.hour, startParts.minute, startParts.second, offset);

        const occStartUtc = partsToUtcMs(occLocalParts);
        const occurrenceEnd = generatedOccurrenceEnd(occStartUtc, durationMs, timing.hasKnownDuration, offset);

        if (occurrenceEnd.endUtc < boundedStart || occStartUtc > boundedEnd) continue;
        if (occStartUtc < startUtc) continue;

        out.push({
          occurrenceDate: toYmd(occLocalParts),
          startDateTime: partsToIso(occLocalParts),
          endDateTime: occurrenceEnd.endDateTime,
          label: formatLabelLocal(occLocalParts),
        });
      }
    }

    out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
    return out;
  }

  if (type === "annual" || type === "yearly") {
    const windowStartLocal = zonedPartsFromUtc(boundedStart, offset);
    const windowEndLocal = zonedPartsFromUtc(boundedEnd, offset);
    const month = Math.max(1, Math.min(12, Number(rule.byMonth || startParts.month)));
    const day = Math.max(1, Math.min(31, Number(rule.byMonthday || startParts.day)));
    const yearsFromAnchor = Math.max(0, windowStartLocal.year - anchorLocal.year);
    const firstYear = anchorLocal.year + Math.ceil(yearsFromAnchor / interval) * interval;

    for (let year = firstYear; year <= windowEndLocal.year; year += interval) {
      const occLocalParts = zonedLocalParts(year, month, Math.min(day, daysInMonth(year, month)), startParts.hour, startParts.minute, startParts.second, offset);
      const occStartUtc = partsToUtcMs(occLocalParts);
      const occurrenceEnd = generatedOccurrenceEnd(occStartUtc, durationMs, timing.hasKnownDuration, offset);
      if (occurrenceEnd.endUtc < boundedStart || occStartUtc > boundedEnd || occStartUtc < startUtc) continue;
      out.push({
        occurrenceDate: toYmd(occLocalParts),
        startDateTime: partsToIso(occLocalParts),
        endDateTime: occurrenceEnd.endDateTime,
        label: formatLabelLocal(occLocalParts),
      });
    }
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
    featured: readFeaturedActive(row),
    eddiesPick: readEddiesPick(row),
  };

  const baseStartUtc = Date.parse(base.startDateTime);
  const baseEndUtc = Date.parse(base.endDateTime);

  if (!base.hasRecurrence || !base.recurrenceRule) {
    if (
      Number.isFinite(baseStartUtc) &&
      Number.isFinite(baseEndUtc) &&
      baseEndUtc >= windowStartUtcMs &&
      baseStartUtc <= windowEndUtcMs
    ) {
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

function readOptionalQueryString(query, keys, { maxLength = 256 } = {}) {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(query, key)) continue;
    const value = query[key];
    if (Array.isArray(value) || typeof value === "object") {
      return { error: `Invalid query parameter: ${key}` };
    }
    const text = String(value ?? "").trim();
    if (text.length > maxLength) return { error: `Query parameter too long: ${key}` };
    return { value: text };
  }
  return { value: "" };
}

function readBoundedQueryInt(query, key, { defaultValue, min, max }) {
  if (!Object.prototype.hasOwnProperty.call(query, key) || query[key] === "") {
    return { value: defaultValue };
  }
  const raw = query[key];
  if (Array.isArray(raw) || typeof raw === "object") return { error: `Invalid query parameter: ${key}` };
  if (!/^[-+]?\d+$/.test(String(raw).trim())) return { error: `Invalid query parameter: ${key}` };
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    return { error: `Invalid query parameter: ${key}` };
  }
  return { value };
}

function readEnumQueryValue(query, key, { defaultValue, allowed }) {
  if (!Object.prototype.hasOwnProperty.call(query, key) || query[key] === "") return { value: defaultValue };
  const raw = query[key];
  if (Array.isArray(raw) || typeof raw === "object") return { error: `Invalid query parameter: ${key}` };
  const value = String(raw).trim().toLowerCase();
  if (!allowed.includes(value)) return { error: `Invalid query parameter: ${key}` };
  return { value };
}

function resolveCategoryFilter(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  return findEventCategory(raw);
}

function compareEventIds(a, b) {
  return (Number(a?.id) || 0) - (Number(b?.id) || 0);
}

function matchesCategory(item, category) {
  if (!category) return true;
  const cats = Array.isArray(item.categories) ? item.categories : [];
  return cats.some((value) => {
    const candidate = findEventCategory(value);
    return candidate && candidate.slug === category.slug;
  });
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
  const startTs = Date.parse(item.startDateTime);
  if (!Number.isFinite(startTs)) return false;
  const endTs = effectiveEndTs(item);

  const fromT = fromISO ? Date.parse(fromISO) : NaN;
  const toT = toISO ? Date.parse(toISO) : NaN;

  // A date range represents events occurring during that interval. For a
  // missing/invalid end time effectiveEndTs safely falls back to the start.
  if (Number.isFinite(fromT) && endTs < fromT) return false;
  if (Number.isFinite(toT) && startTs > toT) return false;
  return true;
}


function isArchivedRow(item) {
  const v = item && (item.archived ?? item.Archived);
  const s = String(v ?? "0").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function setNoIndexHeader(res) {
  res.set("X-Robots-Tag", "noindex, nofollow");
}

function effectiveEndTs(item) {
  const endTs = Date.parse(String((item && item.endDateTime) || ""));
  const startTs = Date.parse(String((item && item.startDateTime) || ""));
  // Invalid legacy ranges (end before start) are treated as a point-in-time
  // event at their start, rather than incorrectly becoming past early.
  if (Number.isFinite(endTs) && (!Number.isFinite(startTs) || endTs >= startTs)) return endTs;
  return Number.isFinite(startTs) ? startTs : NaN;
}

function lifecycleStatus(item, nowTs) {
  if (isArchivedRow(item)) return "archived";
  const endTs = effectiveEndTs(item);
  if (!Number.isFinite(endTs)) return "unknown";
  return endTs < nowTs ? "past" : "upcoming";
}

function matchesLifecycleStatus(item, status, nowTs) {
  const archived = isArchivedRow(item);

  if (status === "archived") return archived;
  if (status === "all") return true;

  if (archived) return false;

  const endTs = effectiveEndTs(item);
  if (!Number.isFinite(endTs)) return false;

  if (status === "past") return endTs < nowTs;

  // default upcoming
  return endTs >= nowTs;
}

function getEventDetailPath(item) {
  const key = String(item?.slug || item?.id || "").trim();
  return `/events/${encodeURIComponent(key)}`;
}

function getApiBaseUrl(req) {
  return (
    (process.env.API_BASE_URL || process.env.PUBLIC_API_BASE_URL || "").trim() ||
    `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.get("host")}`
  ).replace(/\/$/, "");
}

function getEventTicketTrackedUrl(req, item) {
  const ticketUrl = String(item?.ticketUrl || "").trim();
  if (!ticketUrl) return "";
  const key = String(item?.slug || item?.id || "").trim();
  if (!key) return "";
  return `${getApiBaseUrl(req)}/events/${encodeURIComponent(key)}/tickets`;
}

function enrichEventDetailForSeo(req, detailData) {
  const seoDefaults = deriveEventSeoFields(detailData);
  const seo = buildSeoDescriptor({
    req,
    pathname: getEventDetailPath(detailData),
    seoTitle: detailData.seoTitle,
    fallbackTitle: seoDefaults.seoTitle,
    metaDescription: detailData.metaDescription,
    fallbackDescription: seoDefaults.metaDescription,
    imageAlt: detailData.imageAlt,
    fallbackImageAlt: seoDefaults.imageAlt,
    updatedAt: detailData.updatedAt,
    createdAt: detailData.createdAt,
    indexable: detailData.status !== "archived",
    robots: detailData.status === "archived" ? "noindex,nofollow" : "index,follow",
  });

  return {
    ...detailData,
    ticketTrackedUrl: getEventTicketTrackedUrl(req, detailData),
    ...seo,
    structuredData: buildEventStructuredData({
      url: seo.publicUrl,
      name: detailData.title,
      description: detailData.description,
      startDateTime: detailData.startDateTime,
      endDateTime: detailData.endDateTime,
      imageUrl: detailData.imageUrl,
      locationName: detailData.location,
      organizerName: detailData.organizer,
      eventStatus: detailData.lifecycle?.state === "cancelled"
        ? "https://schema.org/EventCancelled"
        : detailData.lifecycle?.state === "postponed"
          ? "https://schema.org/EventPostponed"
          : detailData.status === "upcoming" ? "https://schema.org/EventScheduled" : "",
    }),
  };
}

function pickRecurringDisplayOccurrence(occurrences, nowTs) {
  const list = Array.isArray(occurrences) ? occurrences : [];
  let active = null;
  let next = null;

  for (const occ of list) {
    const startTs = Date.parse(String(occ?.startDateTime || ""));
    const endTs = Date.parse(String(occ?.endDateTime || occ?.startDateTime || ""));
    if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) continue;

    if (startTs <= nowTs && endTs >= nowTs) {
      if (!active || startTs < Date.parse(String(active.startDateTime || ""))) active = occ;
      continue;
    }

    if (startTs > nowTs) {
      if (!next || startTs < Date.parse(String(next.startDateTime || ""))) next = occ;
    }
  }

  return active || next || null;
}

function occurrenceSummary(occurrence) {
  if (!occurrence) return null;
  return {
    occurrenceDate: String(occurrence.occurrenceDate || "") || null,
    startDateTime: String(occurrence.startDateTime || "") || null,
    endDateTime: String(occurrence.endDateTime || "") || null,
    label: String(occurrence.label || occurrence.occurrenceLabel || "") || null,
  };
}

function buildLifecycleSummary(base, occurrences, nowTs) {
  const isRecurring = Boolean(base.hasRecurrence && base.recurrenceRule);
  const list = (isRecurring ? (Array.isArray(occurrences) ? occurrences : []) : [{
    occurrenceDate: parseIsoParts(base.startDateTime) ? toYmd(parseIsoParts(base.startDateTime)) : "",
    startDateTime: base.startDateTime,
    endDateTime: base.endDateTime,
  }])
    .filter((occurrence) => Number.isFinite(Date.parse(String(occurrence?.startDateTime || ""))))
    .sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
  const nextUpcomingOccurrence = list.find((occurrence) => Date.parse(String(occurrence.startDateTime)) > nowTs) || null;
  const completed = list.filter((occurrence) => effectiveEndTs(occurrence) < nowTs);
  const lastCompletedOccurrence = completed.length ? completed[completed.length - 1] : null;
  const state = isArchivedRow(base)
    ? "archived"
    : (nextUpcomingOccurrence || (isRecurring && pickRecurringDisplayOccurrence(list, nowTs)) ? "upcoming" : lifecycleStatus(base, nowTs));

  const explicitLifecycle = publicLifecycle(base);
  const lifecycleNotice = {
    cancelled: "This event has been cancelled.",
    postponed: "This event has been postponed. A new date will be shared when available.",
    rescheduled: "This event has been rescheduled. Please review the updated date and time.",
    archived: "This event is archived.",
  }[explicitLifecycle.state] || null;
  return {
    stableId: Number(base.id) || null,
    slug: String(base.slug || "") || null,
    status: state,
    state: explicitLifecycle.state,
    revision: explicitLifecycle.revision,
    updatedAt: explicitLifecycle.updatedAt,
    reason: explicitLifecycle.reason,
    replacementEventId: explicitLifecycle.replacementEventId,
    label: explicitLifecycle.state.charAt(0).toUpperCase() + explicitLifecycle.state.slice(1),
    notice: lifecycleNotice || explicitLifecycle.reason || null,
    isRecurring,
    recurrenceType: isRecurring ? String(base.recurrenceRule?.type || "") || null : null,
    originalStartDateTime: String(base.startDateTime || "") || null,
    originalEndDateTime: String(base.endDateTime || "") || null,
    nextUpcomingOccurrence: occurrenceSummary(nextUpcomingOccurrence),
    lastCompletedOccurrence: occurrenceSummary(lastCompletedOccurrence),
    recurrenceStartDate: base.recurrenceStartDate || null,
    recurrenceUntilDate: base.recurrenceUntilDate || null,
    community: { city: String(base.city || "") },
    venue: base.location ? { name: String(base.location) } : null,
    organizer: base.organizer ? { name: String(base.organizer) } : null,
  };
}

// A recurrence rule can begin on a different weekday than the first stored
// occurrence (for example, a Friday-night event recorded at midnight on the
// following Saturday). Preserve that first real occurrence in detail feeds
// instead of replacing it with the first generated rule occurrence.
function includeStoredFirstOccurrence(event, occurrences, windowStartUtc) {
  const list = Array.isArray(occurrences) ? occurrences.slice() : [];
  const startDateTime = String(event && event.startDateTime || "").trim();
  const endDateTime = String(event && event.endDateTime || startDateTime).trim();
  const startTs = Date.parse(startDateTime);
  const endTs = Date.parse(endDateTime);

  if (!Number.isFinite(startTs) || !Number.isFinite(endTs) || endTs < windowStartUtc) {
    return list;
  }

  if (!list.some((item) => String(item && item.startDateTime || "") === startDateTime)) {
    list.push({
      startDateTime,
      endDateTime,
      label: labelFromIso(startDateTime),
    });
  }

  list.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
  return list;
}

function paginate(items, limit, offset, context = null, projectItem = null) {
  const total = items.length;
  const start = Math.max(0, offset);
  const end = Math.min(total, start + limit);
  const slice = items.slice(start, end);
  const hasMore = end < total;
  return {
    data: typeof projectItem === "function" ? slice.map(projectItem) : slice,
    meta: {
      total,
      limit,
      offset: start,
      hasMore,
      nextOffset: hasMore ? end : null,
      ...(context?.category ? { eventCount: total } : {}),
      ...(context || {}),
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
 *  category=music (category name or normalized slug)
 *  organizer=Adventure Van Expo
 *  venue=Enumclaw Expo Center (or location=)
 *  featured=1
 *  from=ISO to=ISO
 *  status=upcoming|past|archived|all
 *  windowDays=90 (optional)
 */
async function listEventsHandler(req, res) {
  try {
    const cityParam = readOptionalQueryString(req.query, ["city"]);
    if (cityParam.error) {
      return res.status(400).json({ data: [], meta: { total: 0, limit: 0, offset: 0, hasMore: false, nextOffset: null }, error: cityParam.error });
    }
    const city = cityParam.value || "Enumclaw";
    const expandParam = readEnumQueryValue(req.query, "expand", { defaultValue: "1", allowed: ["0", "1"] });
    const statusParam = readEnumQueryValue(req.query, "status", { defaultValue: "upcoming", allowed: ["upcoming", "past", "archived", "all"] });
    if (expandParam.error || statusParam.error) {
      const invalid = expandParam.error || statusParam.error;
      return res.status(400).json({ data: [], meta: { total: 0, limit: 0, offset: 0, hasMore: false, nextOffset: null }, error: invalid });
    }
    const expand = expandParam.value !== "0";
    const status = statusParam.value;
    const userRole = String(req.user?.role || "").trim().toLowerCase();
    if (status === "archived" && !["admin", "developer"].includes(userRole)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    if (status === "archived") setNoIndexHeader(res);

    const sortDefault = (status === "past" || status === "archived") ? "latest" : "soonest";
    const sortParam = readEnumQueryValue(req.query, "sort", {
      defaultValue: sortDefault,
      allowed: ["latest", "soonest", "recent", "trending", "id_desc"],
    });
    if (sortParam.error) {
      return res.status(400).json({ data: [], meta: { total: 0, limit: 0, offset: 0, hasMore: false, nextOffset: null }, error: sortParam.error });
    }
    const sort = sortParam.value;

    const qParam = readOptionalQueryString(req.query, ["q"], { maxLength: 512 });
    const categoryParam = readOptionalQueryString(req.query, ["category", "cat"]);
    const organizerParam = readOptionalQueryString(req.query, ["organizer", "org"]);
    const venueParam = readOptionalQueryString(req.query, ["venue", "location"]);
    const invalidParam = [qParam, categoryParam, organizerParam, venueParam].find((param) => param.error);
    if (invalidParam) {
      return res.status(400).json({
        data: [],
        meta: { total: 0, limit: 0, offset: 0, hasMore: false, nextOffset: null },
        error: invalidParam.error,
      });
    }
    const q = qParam.value;
    const category = resolveCategoryFilter(categoryParam.value);
    if (categoryParam.value && !category) {
      return res.status(400).json({
        data: [],
        meta: { total: 0, limit: 0, offset: 0, hasMore: false, nextOffset: null },
        error: "Invalid category identifier",
      });
    }
    const organizer = organizerParam.value;
    const venue = venueParam.value;
    const publicEventProjection = req.publicEventProjection === true ? toPublicEventListItem : null;
    // Internal venue pages may supply a small, exact set of the venue's known
    // location labels (currently name and address). Keep public `venue=`
    // behavior unchanged for compatibility.
    const venueLocationIdentifiers = Array.isArray(req.venueLocationIdentifiers)
      ? [...new Set(req.venueLocationIdentifiers.map(normalizeVenueIdentifier).filter(Boolean))]
      : [];
    const venueLocationLabels = Array.isArray(req.venueLocationLabels)
      ? [...new Set(req.venueLocationLabels.map((value) => String(value || "").trim()).filter(Boolean))]
      : [];
    const hasInternalVenueFilter = venueLocationIdentifiers.length > 0 && venueLocationLabels.length > 0;
    const matchesVenue = (item) => hasInternalVenueFilter
      ? matchesVenueLocation(item?.location, venueLocationIdentifiers)
      : (!venue || String(item?.location || "").toLowerCase().includes(venue.toLowerCase()));
    const featuredParam = readEnumQueryValue(req.query, "featured", { defaultValue: "0", allowed: ["0", "1"] });
    if (featuredParam.error) {
      return res.status(400).json({ data: [], meta: { total: 0, limit: 0, offset: 0, hasMore: false, nextOffset: null }, error: featuredParam.error });
    }
    const featuredOnly = featuredParam.value === "1";

    const limitParam = readBoundedQueryInt(req.query, "limit", { defaultValue: 40, min: 1, max: 100 });
    const offsetParam = readBoundedQueryInt(req.query, "offset", { defaultValue: 0, min: 0, max: Number.MAX_SAFE_INTEGER });
    const fromParam = readOptionalQueryString(req.query, ["from"], { maxLength: 64 });
    const toParam = readOptionalQueryString(req.query, ["to"], { maxLength: 64 });
    const invalidPagingOrDate = [limitParam, offsetParam, fromParam, toParam].find((param) => param.error);
    if (invalidPagingOrDate) {
      return res.status(400).json({ data: [], meta: { total: 0, limit: 0, offset: 0, hasMore: false, nextOffset: null }, error: invalidPagingOrDate.error });
    }
    const limit = limitParam.value;
    const offset = offsetParam.value;
    const fromISO = fromParam.value;
    const toISO = toParam.value;
    const fromTs = fromISO ? Date.parse(fromISO) : NaN;
    const toTs = toISO ? Date.parse(toISO) : NaN;
    if ((fromISO && !Number.isFinite(fromTs)) || (toISO && !Number.isFinite(toTs)) || (Number.isFinite(fromTs) && Number.isFinite(toTs) && fromTs > toTs)) {
      return res.status(400).json({ data: [], meta: { total: 0, limit, offset, hasMore: false, nextOffset: null }, error: "Invalid date range" });
    }

    const nowUtc = Date.now();
    const defaultWindowDays =
      sort === "recent"
        ? 365
        : ((status === "past" || status === "archived" || status === "all") ? 365 : 90);

    const windowDaysParam = readBoundedQueryInt(req.query, "windowDays", { defaultValue: defaultWindowDays, min: 1, max: 3650 });
    if (windowDaysParam.error) {
      return res.status(400).json({ data: [], meta: { total: 0, limit, offset, hasMore: false, nextOffset: null }, error: windowDaysParam.error });
    }
    const windowDays = windowDaysParam.value;

    let windowStartUtc;
    let windowEndUtc;

    if (status === "past" || status === "archived") {
      windowStartUtc = nowUtc - windowDays * 86400 * 1000;
      windowEndUtc = nowUtc + 5 * 60 * 1000;
    } else if (status === "all") {
      windowStartUtc = nowUtc - windowDays * 86400 * 1000;
      windowEndUtc = nowUtc + windowDays * 86400 * 1000;
    } else {
      windowStartUtc = nowUtc - 5 * 60 * 1000;
      windowEndUtc = nowUtc + windowDays * 86400 * 1000;
    }

    // Archived results are permission-sensitive and therefore never cached.
    // All other variants are public and can be reused for a very short window.
    const eventListCacheKey = status === "archived" ? "" : JSON.stringify([
      city.toLowerCase(), expand, status, sort, q.toLowerCase(), category ? category.slug : "",
      organizer.toLowerCase(), venue.toLowerCase(), venueLocationIdentifiers, featuredOnly, limit, offset,
      fromISO, toISO, windowDays,
    ]);
    if (eventListCacheKey) {
      const cachedPayload = readCachedPayload(eventListCache, eventListCacheKey, nowUtc);
      if (cachedPayload) return res.json(cachedPayload);
    }

    const rowWhere = ["city = ? COLLATE NOCASE"];
    const rowParams = [city];
    if (category) {
      rowWhere.push(`EXISTS (
        SELECT 1
        FROM json_each(CASE WHEN json_valid(categories) THEN categories ELSE '[]' END)
        WHERE LOWER(TRIM(value)) = LOWER(TRIM(?))
      )`);
      rowParams.push(category.name);
    }
    if (organizer) {
      rowWhere.push("LOWER(TRIM(COALESCE(organizer, ''))) = LOWER(TRIM(?))");
      rowParams.push(organizer);
    }
    if (hasInternalVenueFilter) {
      rowWhere.push(`(${venueLocationLabels.map(() => "LOWER(TRIM(COALESCE(location, ''))) = LOWER(TRIM(?))").join(" OR ")})`);
      rowParams.push(...venueLocationLabels);
    } else if (venue) {
      rowWhere.push("LOWER(TRIM(COALESCE(location, ''))) = LOWER(TRIM(?))");
      rowParams.push(venue);
    }

    let rows = await all(
      `SELECT * FROM events WHERE ${rowWhere.join(" AND ")} ORDER BY startDateTime ASC`,
      rowParams
    );

    // normalize base times first so recurrence generation uses correct offset
    rows = rows.map((r) => normalizeRowTimes(r));

    // Normalize base rows
    const normalizedRows = rows.map((r) => ({
      ...r,
      categories: normalizeCats(r),
      multiDaySchedule: normalizeMultiDaySchedule(r.multiDaySchedule),
      hasRecurrence: Number(r.hasRecurrence || 0),
      recurrenceRule: safeParseJson(r.recurrenceRule, null),
      recurrenceDates: safeParseJson(r.recurrenceDates, []),
      featured: readFeaturedActive(r),
      eddiesPick: readEddiesPick(r),
    }));

    // If no expand, treat each base row as one feed item (but still window/status filter)
    if (!expand) {
      let items = normalizedRows
        .filter((it) => {
          const startTs = Date.parse(it.startDateTime);
          const endTs = effectiveEndTs(it);
          if (!Number.isFinite(startTs) || !Number.isFinite(endTs)) return false;
          if (endTs < windowStartUtc || startTs > windowEndUtc) return false;

          if (!matchesLifecycleStatus(it, status, nowUtc)) return false;
          if (featuredOnly && readFeaturedActive(it) !== 1) return false;
          if (!matchesQuery(it, q)) return false;
          if (!matchesCategory(it, category)) return false;
          if (organizer && !String(it.organizer || "").toLowerCase().includes(organizer.toLowerCase())) return false;
          if (!matchesVenue(it)) return false;
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
          if (at !== bt) return at - bt;
          return compareEventIds(a, b);
        }

        if (sort === "trending") {
          const sa = getTrendingScore(a);
          const sb = getTrendingScore(b);
          if (sb !== sa) return sb - sa;

          // tie-break: upcoming sooner first
          const at = Date.parse(a.startDateTime);
          const bt = Date.parse(b.startDateTime);
          if (at !== bt) return at - bt;
          return compareEventIds(a, b);
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

        // soonest/latest
        const at = Date.parse(a.startDateTime);
        const bt = Date.parse(b.startDateTime);
        if (at !== bt) return sort === "latest" ? (bt - at) : (at - bt);
        return compareEventIds(a, b);
      });

      const payload = paginate(items, limit, offset, category ? {
        category: { name: category.name, slug: category.slug },
        community: { city },
      } : null, publicEventProjection);
      if (eventListCacheKey) cachePayload(eventListCache, eventListCacheKey, payload, EVENT_LIST_CACHE_MS, EVENT_LIST_CACHE_MAX_ENTRIES);
      return res.json(payload);
    }

    // Expand into occurrences
    let expanded = [];
    // These base-row predicates cannot change per recurrence occurrence, so
    // apply them before the potentially expensive recurrence expansion.
    const rowsForExpansion = normalizedRows.filter((row) => (
      (!featuredOnly || readFeaturedActive(row) === 1) && matchesQuery(row, q)
    ));
    for (const r of rowsForExpansion) {
      const rowFixed = r;
      expanded.push(...expandEventIntoFeedItems(rowFixed, windowStartUtc, windowEndUtc));
    }

    // Apply filters
    expanded = expanded.filter((it) => {
      if (!matchesLifecycleStatus(it, status, nowUtc)) return false;
      if (featuredOnly && readFeaturedActive(it) !== 1) return false;
      if (!matchesQuery(it, q)) return false;
      if (!matchesCategory(it, category)) return false;
      if (organizer && !String(it.organizer || "").toLowerCase().includes(organizer.toLowerCase())) return false;
      if (!matchesVenue(it)) return false;
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
        if (at !== bt) return at - bt;
        return compareEventIds(a, b);
      }

      if (sort === "trending") {
        const sa = getTrendingScore(a);
        const sb = getTrendingScore(b);
        if (sb !== sa) return sb - sa;

        // tie-break: upcoming sooner first
        const at = Date.parse(a.startDateTime);
        const bt = Date.parse(b.startDateTime);
        if (at !== bt) return at - bt;
        return compareEventIds(a, b);
      }

      if (sort === "id_desc") {
        const ia = Number(a && a.id) || 0;
        const ib = Number(b && b.id) || 0;
        if (ib !== ia) return ib - ia;

        const at = Date.parse(a.startDateTime);
        const bt = Date.parse(b.startDateTime);
        return bt - at;
      }

      // soonest/latest
      const at = Date.parse(a.startDateTime);
      const bt = Date.parse(b.startDateTime);
      if (at !== bt) return sort === "latest" ? (bt - at) : (at - bt);
      return compareEventIds(a, b);
    });

    // Paginate
    const payload = paginate(expanded, limit, offset, category ? {
      category: { name: category.name, slug: category.slug },
      community: { city },
    } : null, publicEventProjection);
    if (eventListCacheKey) cachePayload(eventListCache, eventListCacheKey, payload, EVENT_LIST_CACHE_MS, EVENT_LIST_CACHE_MAX_ENTRIES);
    return res.json(payload);
  } catch (err) {
    console.error("[/events] error:", err && err.stack ? err.stack : err);
    console.error("[/events] query:", req.query);
    res.status(500).json({
      data: [],
      meta: { total: 0, limit: 40, offset: 0, hasMore: false, nextOffset: null },
      error: "Server error",
    });
  }
}

router.get("/", listEventsHandler);

// GET /events/past
// Lightweight past listing for archive-style pages.
router.get("/past", async (req, res) => {
  try {
    const city = String(req.query.city ?? "Enumclaw").trim();
    const pageRaw = parseInt(String(req.query.page ?? "1"), 10);
    const page = Math.max(1, Number.isFinite(pageRaw) ? pageRaw : 1);
    const nowTs = Date.now();

    const cacheKey = `${city.toLowerCase()}::${page}`;
    const cachedPayload = readCachedPayload(pastEventsCache, cacheKey, nowTs);
    if (cachedPayload) {
      res.set("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=60");
      return res.json(cachedPayload);
    }

    let rows = await all(
      `SELECT *
       FROM events
       WHERE LOWER(city) = LOWER(?)
         AND COALESCE(archived, 0) = 0
      `,
      [city]
    );

    rows = (rows || []).map((r) => normalizeRowTimes(r));

    const windowStartUtc = nowTs - 3650 * 86400 * 1000;
    const windowEndUtc = nowTs + 5 * 60 * 1000;
    let expanded = [];
    for (const row of rows) {
      const normalized = {
        ...row,
        categories: normalizeCats(row),
        multiDaySchedule: normalizeMultiDaySchedule(row.multiDaySchedule),
        hasRecurrence: Number(row.hasRecurrence || 0),
        recurrenceRule: safeParseJson(row.recurrenceRule, null),
        recurrenceDates: safeParseJson(row.recurrenceDates, []),
        featured: readFeaturedActive(row),
        eddiesPick: readEddiesPick(row),
      };
      expanded.push(...expandEventIntoFeedItems(normalized, windowStartUtc, windowEndUtc));
    }

    expanded = expanded
      .filter((r) => String(r.slug || "").trim())
      .filter((r) => matchesLifecycleStatus(r, "past", nowTs))
      .sort((a, b) => effectiveEndTs(b) - effectiveEndTs(a));

    const total = expanded.length;
    const pages = Math.max(1, Math.ceil(total / PAST_EVENTS_LIMIT));
    const boundedPage = Math.min(page, pages);
    const offset = (boundedPage - 1) * PAST_EVENTS_LIMIT;
    const data = expanded.slice(offset, offset + PAST_EVENTS_LIMIT).map((r) => ({
      title: String(r.title || ""),
      slug: String(r.slug || ""),
      startDateTime: r.startDateTime || null,
      endDateTime: r.endDateTime || null,
      location: String(r.location || ""),
      imageUrl: r.imageUrl || null,
      isOccurrence: Boolean(r.isOccurrence),
    }));

    const payload = {
      data,
      meta: {
        page: boundedPage,
        limit: PAST_EVENTS_LIMIT,
        total,
        pages,
        hasPrev: boundedPage > 1,
        hasNext: boundedPage < pages,
      },
    };

    cachePayload(pastEventsCache, cacheKey, payload, PAST_EVENTS_CACHE_MS, 100);
    res.set("Cache-Control", "public, max-age=300, s-maxage=300, stale-while-revalidate=60");
    return res.json(payload);
  } catch (err) {
    console.error("[/events/past] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ data: [], meta: { page: 1, limit: PAST_EVENTS_LIMIT, total: 0, pages: 0 }, error: "Server error" });
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
      featured: readFeaturedActive(rowFixed),
      eddiesPick: readEddiesPick(rowFixed),
      ticketClickCount: Number(rowFixed.ticketClickCount || 0),

      // pass through (these columns exist in DB)
      recurrenceStartDate: rowFixed.recurrenceStartDate || null,
      recurrenceUntilDate: rowFixed.recurrenceUntilDate || null,
    };
    if (isArchivedRow(base)) setNoIndexHeader(res);

    const nowUtc = Date.now();
    const state = lifecycleStatus(base, nowUtc);
    const windowDays = 90;
    const windowStartUtc = nowUtc - 5 * 60 * 1000;
    const windowEndUtc = nowUtc + windowDays * 86400 * 1000;

    const occurrences = base.hasRecurrence && base.recurrenceRule
      ? generateOccurrences(base, windowStartUtc, windowEndUtc)
      : [];

    const lifecycleOccurrences = base.hasRecurrence && base.recurrenceRule
      ? includeStoredFirstOccurrence(base, generateOccurrences(base, nowUtc - 3650 * 86400 * 1000, nowUtc + 370 * 86400 * 1000), nowUtc - 3650 * 86400 * 1000)
      : [];

    let occurrencesUpcoming = occurrences
      .filter((o) => {
        const startTs = Date.parse(o.startDateTime);
        const endTs = Date.parse(o.endDateTime || o.startDateTime);
        return Number.isFinite(startTs) && Number.isFinite(endTs) && endTs >= windowStartUtc;
      })
      .slice(0, 200)
      .map((o) => ({ startDateTime: o.startDateTime, endDateTime: o.endDateTime, label: o.label }));
    occurrencesUpcoming = includeStoredFirstOccurrence(base, occurrencesUpcoming, windowStartUtc);

    const displayOccurrence = base.hasRecurrence && base.recurrenceRule
      ? pickRecurringDisplayOccurrence(occurrencesUpcoming, nowUtc)
      : null;

    const detailData = {
      ...base,
      occurrencesUpcoming,
      lifecycle: buildLifecycleSummary(base, lifecycleOccurrences, nowUtc),
      status: state,
      eventEnded: state === "past" || state === "archived",
      statusLabel: state === "past" || state === "archived" ? "Event ended." : "",
    };

    if (displayOccurrence) {
      detailData.baseStartDateTime = base.startDateTime;
      detailData.startDateTime = displayOccurrence.startDateTime;
      detailData.endDateTime = displayOccurrence.endDateTime;
      detailData.occurrenceLabel = displayOccurrence.label || "";
      detailData.isOccurrence = true;
      detailData.status = "upcoming";
      detailData.eventEnded = false;
      detailData.statusLabel = "";
    }

    res.json({
      data: enrichEventDetailForSeo(req, detailData),
    });
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
      const fWhere = [...whereParts, "featured = 1", "(featuredUntil IS NULL OR trim(featuredUntil) = '' OR datetime(featuredUntil) > datetime('now'))"];
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
      const fWhere = [...whereParts, "featured = 1", "(featuredUntil IS NULL OR trim(featuredUntil) = '' OR datetime(featuredUntil) > datetime('now'))"];
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

// POST /events/:eventId/reports
// Public event-page report intake. Event identity always comes from :eventId;
// eventUrl is stored as supporting context only and is never used for lookup.
router.post("/:eventId/reports", async (req, res) => {
  try {
    const rawEventId = String(req.params.eventId || "").trim();
    const eventId = Number(rawEventId);
    if (!/^\d+$/.test(rawEventId) || !Number.isSafeInteger(eventId) || eventId < 1) {
      return eventReportError(res, 400, "validation_error", "Event ID must be a positive integer.");
    }

    const event = await get("SELECT id FROM events WHERE id = ? LIMIT 1", [eventId]);
    if (!event) return eventReportError(res, 404, "not_found", "Event not found.");

    const reportType = String(req.body?.reportType || "").trim().toLowerCase();
    if (!EVENT_REPORT_TYPES.has(reportType)) {
      return eventReportError(res, 400, "validation_error", "Report type must be changed_details, cancelled, or other.");
    }

    if (typeof req.body?.message !== "string") {
      return eventReportError(res, 400, "validation_error", "Report description is required.");
    }
    const message = req.body.message.trim();
    if (!message || message.length > 3000) {
      return eventReportError(res, 400, "validation_error", "Report description must be between 1 and 3000 characters.");
    }

    let reporterEmail = null;
    if (req.body?.reporterEmail !== undefined && req.body?.reporterEmail !== null && String(req.body.reporterEmail).trim()) {
      if (typeof req.body.reporterEmail !== "string") {
        return eventReportError(res, 400, "validation_error", "Reporter email must be a string.");
      }
      reporterEmail = req.body.reporterEmail.trim().toLowerCase();
      if (reporterEmail.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail)) {
        return eventReportError(res, 400, "validation_error", "Reporter email must be a valid email address.");
      }
    }

    const source = String(req.body?.source || "event_page").trim().toLowerCase();
    if (!EVENT_REPORT_SOURCES.has(source) || source.length > 64) {
      return eventReportError(res, 400, "validation_error", "Report source is not supported.");
    }

    const eventUrlResult = normalizeReportedEventUrl(req.body?.eventUrl);
    if (eventUrlResult.error) return eventReportError(res, 400, "validation_error", eventUrlResult.error);

    const changesResult = normalizeEventReportChanges(req.body?.changes);
    if (changesResult.error) return eventReportError(res, 400, "validation_error", changesResult.error);

    const reportIp = clientIp(req);
    const ipKey = `ip:${reportIp}`;
    const eventKey = `event:${eventId}:ip:${reportIp}`;
    if (!eventReportRateLimiter.consume(ipKey) || !eventReportPerEventRateLimiter.consume(eventKey)) {
      res.set("Retry-After", String(eventReportRateLimiter.retryAfterSeconds));
      return eventReportError(res, 429, "rate_limited", "Too many reports were submitted. Please try again later.");
    }

    const result = await run(
      `INSERT INTO event_reports (eventId, reportType, message, reporterEmail, source, eventUrl, changesJson, status, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', datetime('now'))`,
      [eventId, reportType, message, reporterEmail, source, eventUrlResult.value, JSON.stringify(changesResult.value)]
    );
    void notifyAreaApprovers({
      category: "eventReports",
      city: String((await get("SELECT city FROM events WHERE id = ?", [eventId]))?.city || ""),
      subject: `New event report: ${reportType.replace(/_/g, " ")}`,
      text: `A public event report was submitted for event #${eventId}.\n\n${message}\n\nReview it in OpenCircle: ${ADMIN_APP_URL}/admin/event-reports`,
      html: `<p>A public event report was submitted for event #${eventId}.</p><p><strong>${esc(reportType.replace(/_/g, " "))}</strong></p><p>${esc(message)}</p><p><a href="${esc(`${ADMIN_APP_URL}/admin/event-reports`)}">Review event report</a></p>`,
    }).catch((error) => console.error("[event report notification]", error));
    const report = await get("SELECT id, eventId, status, createdAt FROM event_reports WHERE id = ?", [result.lastID]);

    return res.status(201).json({ ok: true, report });
  } catch (err) {
    console.error("[/events/:eventId/reports] error:", err);
    return eventReportError(res, 500, "server_error", "Unable to submit the event report.");
  }
});

// Incremental, public-safe synchronization feed. Consumers must bootstrap
// from the normal city-scoped event feed, then retain `nextCursor` and poll
// this endpoint for changed IDs. It intentionally contains no event content,
// ownership, moderation notes, or analytics.
router.get("/changes", async (req, res) => {
  try {
    const city = String(req.query?.city || "").trim();
    const afterRaw = String(req.query?.after || "0").trim();
    const limitRaw = String(req.query?.limit || "50").trim();
    const after = Number.parseInt(afterRaw, 10);
    const limit = Number.parseInt(limitRaw, 10);
    if (!city) return res.status(400).json({ data: [], meta: { cursor: 0, nextCursor: null, hasMore: false }, error: "Missing city" });
    if (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(after) || after < 0) {
      return res.status(400).json({ data: [], meta: { cursor: 0, nextCursor: null, hasMore: false }, error: "Invalid after cursor" });
    }
    if (!/^\d+$/.test(limitRaw) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      return res.status(400).json({ data: [], meta: { cursor: after, nextCursor: null, hasMore: false }, error: "Invalid limit" });
    }

    const rows = await all(
      `SELECT c.id, c.eventId, c.city, c.revision, c.changeType, c.occurredAt,
              e.slug, e.archived, e.lifecycleState
         FROM event_changes c
         LEFT JOIN events e ON e.id = c.eventId
        WHERE c.city COLLATE NOCASE = ? COLLATE NOCASE
          AND c.id > ?
        ORDER BY c.id ASC
        LIMIT ?`,
      [city, after, limit + 1]
    );
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const data = page.map((row) => {
      const deleted = row.changeType === "deleted" || !row.slug;
      const state = deleted ? "deleted" : (Number(row.archived || 0) === 1 ? "archived" : String(row.lifecycleState || "scheduled"));
      return {
        cursor: Number(row.id),
        eventId: Number(row.eventId),
        slug: deleted ? null : String(row.slug),
        revision: Number(row.revision),
        changeType: String(row.changeType),
        occurredAt: row.occurredAt,
        lifecycleState: state,
        availability: deleted ? "deleted" : (state === "archived" ? "archived" : "available"),
      };
    });
    const cursor = data.length ? data[data.length - 1].cursor : after;
    return res.json({ data, meta: { city, cursor, nextCursor: hasMore ? cursor : null, hasMore } });
  } catch (error) {
    console.error("[/events/changes] error:", error);
    return res.status(500).json({ error: "Server error" });
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
      multiDaySchedule: normalizeMultiDaySchedule(rowFixed.multiDaySchedule),
      hasRecurrence: Number(rowFixed.hasRecurrence || 0),
      recurrenceRule: recurRuleObj,
      recurrenceDates: safeParseJson(rowFixed.recurrenceDates, []),
      featured: readFeaturedActive(rowFixed),
      recurrenceStartDate: rowFixed.recurrenceStartDate || null,
      recurrenceUntilDate: rowFixed.recurrenceUntilDate || null,
    };
    if (isArchivedRow(base)) setNoIndexHeader(res);

    const nowUtc = Date.now();
    const state = lifecycleStatus(base, nowUtc);
    const windowDays = 90;
    const windowStartUtc = nowUtc - 5 * 60 * 1000;
    const windowEndUtc = nowUtc + windowDays * 86400 * 1000;

    const occurrences = base.hasRecurrence && base.recurrenceRule
      ? generateOccurrences(base, windowStartUtc, windowEndUtc)
      : [];

    const lifecycleOccurrences = base.hasRecurrence && base.recurrenceRule
      ? includeStoredFirstOccurrence(base, generateOccurrences(base, nowUtc - 3650 * 86400 * 1000, nowUtc + 370 * 86400 * 1000), nowUtc - 3650 * 86400 * 1000)
      : [];

    let occurrencesUpcoming = occurrences
      .filter((o) => {
        const startTs = Date.parse(o.startDateTime);
        const endTs = Date.parse(o.endDateTime || o.startDateTime);
        return Number.isFinite(startTs) && Number.isFinite(endTs) && endTs >= windowStartUtc;
      })
      .slice(0, 200)
      .map((o) => ({ startDateTime: o.startDateTime, endDateTime: o.endDateTime, label: o.label }));
    occurrencesUpcoming = includeStoredFirstOccurrence(base, occurrencesUpcoming, windowStartUtc);

    const displayOccurrence = base.hasRecurrence && base.recurrenceRule
      ? pickRecurringDisplayOccurrence(occurrencesUpcoming, nowUtc)
      : null;

    const detailData = {
      ...base,
      occurrencesUpcoming,
      lifecycle: buildLifecycleSummary(base, lifecycleOccurrences, nowUtc),
      status: state,
      eventEnded: state === "past" || state === "archived",
      statusLabel: state === "past" || state === "archived" ? "Event ended." : "",
    };

    if (displayOccurrence) {
      detailData.baseStartDateTime = base.startDateTime;
      detailData.startDateTime = displayOccurrence.startDateTime;
      detailData.endDateTime = displayOccurrence.endDateTime;
      detailData.occurrenceLabel = displayOccurrence.label || "";
      detailData.isOccurrence = true;
      detailData.status = "upcoming";
      detailData.eventEnded = false;
      detailData.statusLabel = "";
    }

    res.json({
      data: enrichEventDetailForSeo(req, detailData),
    });
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
    const viewIp = clientIp(req);
    const rateKey = `view:${req.params.idOrSlug}:${viewIp}`;
    if (!eventViewRateLimiter.consume(rateKey)) {
      res.set("Retry-After", String(eventViewRateLimiter.retryAfterSeconds));
      return res.status(429).json({ error: "Too many event views were recorded. Please try again later." });
    }
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
    const sourceType = String(req.body?.sourceType || req.body?.source || "").trim().toLowerCase();
    const sourceHost = String(req.body?.sourceHost || "").trim().toLowerCase();
    const utmSource = String(req.body?.utmSource || "").trim().toLowerCase();

    const ip =
      (req.headers["x-forwarded-for"]?.toString().split(",")[0] || req.socket.remoteAddress || "").trim();
    const ua = (req.headers["user-agent"] || "").toString().slice(0, 255);
    const bodyRef = String(req.body?.referrer || req.body?.ref || "").trim();
    const headerRef = (req.headers["referer"] || req.headers["referrer"] || "").toString().trim();

    let ref = bodyRef || headerRef;
    if (!ref && sourceType === "direct") ref = "__direct__";
    const srcTag = [sourceType, sourceHost, utmSource].filter(Boolean).join("|");
    if (srcTag) {
      ref = ref ? (`[src:${srcTag}] ${ref}`) : (`[src:${srcTag}]`);
    }
    ref = String(ref || "").slice(0, 500);

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

// POST /events/:idOrSlug/ticket-click
router.post("/:idOrSlug/ticket-click", async (req, res) => {
  try {
    const ticketIp = clientIp(req);
    const rateKey = `ticket-click:${req.params.idOrSlug}:${ticketIp}`;
    if (!eventTicketClickRateLimiter.consume(rateKey)) {
      res.set("Retry-After", String(eventTicketClickRateLimiter.retryAfterSeconds));
      return res.status(429).json({ error: "Too many ticket clicks were recorded. Please try again later." });
    }
    const raw = String(req.params.idOrSlug || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing id/slug" });

    const asId = Number(raw);
    const isId = Number.isInteger(asId) && asId > 0;

    const row = isId
      ? await get("SELECT id, ticketUrl, ticketClickCount FROM events WHERE id = ? LIMIT 1", [asId])
      : await get("SELECT id, ticketUrl, ticketClickCount FROM events WHERE LOWER(slug) = LOWER(?) LIMIT 1", [raw.toLowerCase()]);

    if (!row) return res.status(404).json({ error: "Event not found" });
    if (!String(row.ticketUrl || "").trim()) return res.status(400).json({ error: "No ticket URL configured" });

    await run(
      `UPDATE events
          SET ticketClickCount = COALESCE(ticketClickCount, 0) + 1,
              updatedAt = datetime('now')
        WHERE id = ?`,
      [row.id]
    );

    const updated = await get("SELECT ticketClickCount FROM events WHERE id = ?", [row.id]);
    return res.json({
      ok: true,
      ticketUrl: String(row.ticketUrl || "").trim(),
      ticketClickCount: Number(updated?.ticketClickCount || 0),
    });
  } catch (err) {
    console.error("[ticket-click] error:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// GET /events/:idOrSlug/tickets
router.get("/:idOrSlug/tickets", async (req, res) => {
  try {
    const ticketIp = clientIp(req);
    const rateKey = `ticket-redirect:${req.params.idOrSlug}:${ticketIp}`;
    if (!eventTicketClickRateLimiter.consume(rateKey)) {
      res.set("Retry-After", String(eventTicketClickRateLimiter.retryAfterSeconds));
      return res.status(429).send("Too many ticket clicks. Please try again later.");
    }
    const raw = String(req.params.idOrSlug || "").trim();
    if (!raw) return res.status(400).send("Missing id/slug");

    const asId = Number(raw);
    const isId = Number.isInteger(asId) && asId > 0;

    const row = isId
      ? await get("SELECT id, ticketUrl FROM events WHERE id = ? LIMIT 1", [asId])
      : await get("SELECT id, ticketUrl FROM events WHERE LOWER(slug) = LOWER(?) LIMIT 1", [raw.toLowerCase()]);

    if (!row) return res.status(404).send("Event not found");

    const ticketUrl = String(row.ticketUrl || "").trim();
    if (!ticketUrl) return res.status(400).send("No ticket URL configured");

    await run(
      `UPDATE events
          SET ticketClickCount = COALESCE(ticketClickCount, 0) + 1,
              updatedAt = datetime('now')
        WHERE id = ?`,
      [row.id]
    );

    return res.redirect(ticketUrl);
  } catch (err) {
    console.error("[tickets redirect] error:", err);
    return res.status(500).send("Server error");
  }
});


// POST /events/:idOrSlug/engagement
// Body supports either:
//   { goingDelta: 1 } or { goingDelta: -1 }
//   { interestedDelta: 1 } or { interestedDelta: -1 }
//   OR absolute set: { going: 12, interested: 5 }
router.post("/:idOrSlug/engagement", async (req, res) => {
  try {
    const engagementIp = clientIp(req);
    const rateKey = `engagement:${req.params.idOrSlug}:${engagementIp}`;
    if (!eventEngagementRateLimiter.consume(rateKey)) {
      res.set("Retry-After", String(eventEngagementRateLimiter.retryAfterSeconds));
      return res.status(429).json({ error: "Too many engagement updates. Please try again later." });
    }
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
module.exports.listEventsHandler = listEventsHandler;
// Reused by the authenticated event-authoring preview.  Keeping preview
// expansion on this function prevents the editor from drifting from the
// public recurrence, timezone, duration, and cutoff behavior.
module.exports.generateOccurrences = generateOccurrences;
