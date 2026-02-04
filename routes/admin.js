"use strict";

const express = require("express");
const router = express.Router();
const { run, all, get, slugify, ensureUniqueSlug } = require("../db");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

/**
 * Fixed category list (12 total)
 * Admin must choose from these; max 3 per event.
 */
const ALLOWED_CATEGORIES = [
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
  "Seasonal & Holiday",
];

// --- Uploads (local disk or Render disk mount) ---
const UPLOAD_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.RENDER_DISK_PATH
    ? path.join(process.env.RENDER_DISK_PATH, "uploads")
    : path.join(process.cwd(), "uploads"));

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
    const base = path
      .basename(file.originalname || "image", ext)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");

    const stamp = Date.now();
    cb(null, `${base || "event"}-${stamp}${ext}`);
  },
});

function fileFilter(req, file, cb) {
  const ok = /^image\/(jpeg|jpg|png|webp|gif)$/i.test(file.mimetype || "");
  cb(ok ? null : new Error("Only image files are allowed."), ok);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

function normalizeCategories(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === "string" && input.trim() !== "") arr = [input.trim()];

  const uniq = [];
  for (const c of arr) {
    const v = String(c || "").trim();
    if (!v) continue;
    if (!ALLOWED_CATEGORIES.includes(v)) continue;
    if (!uniq.includes(v)) uniq.push(v);
    if (uniq.length >= 3) break;
  }
  return uniq;
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

function parseStoredCategories(stored) {
  const parsed = safeParseJson(stored, null);
  if (Array.isArray(parsed)) return parsed;
  if (!stored) return [];
  return String(stored)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseStoredDates(stored) {
  const parsed = safeParseJson(stored, null);
  if (Array.isArray(parsed)) return parsed;
  return [];
}

function parseStoredRule(stored) {
  const parsed = safeParseJson(stored, null);
  if (parsed && typeof parsed === "object") return parsed;
  return null;
}

// Convert datetime-local (no timezone) into ISO with local timezone offset
function toLocalISOWithOffset(dtLocal) {
  const d = new Date(dtLocal);
  if (isNaN(d.getTime())) return null;

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

function toDateTimeLocalValue(isoWithOffset) {
  if (!isoWithOffset) return "";
  return String(isoWithOffset).slice(0, 16);
}

function toDateValue(isoWithOffset) {
  if (!isoWithOffset) return "";
  return String(isoWithOffset).slice(0, 10); // YYYY-MM-DD
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * Optional: schema safety (so admin doesn't crash if columns don't exist)
 */
let _eventsColsCache = null;
async function getEventsColumns() {
  if (_eventsColsCache) return _eventsColsCache;
  try {
    const rows = await all("PRAGMA table_info(events)");
    _eventsColsCache = new Set((rows || []).map((r) => String(r.name)));
    return _eventsColsCache;
  } catch {
    _eventsColsCache = new Set();
    return _eventsColsCache;
  }
}

// --- Archive schema (soft-delete best practice) ---
let _archiveSchemaEnsured = false;
async function ensureArchiveSchema() {
  if (_archiveSchemaEnsured) return;

  const cols = await getEventsColumns();

  // Prefer "archived" naming; support legacy "isArchived" if present.
  if (!cols.has("archived") && !cols.has("isArchived")) {
    await run(`ALTER TABLE events ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
    cols.add("archived");
  }
  if (!cols.has("archived_at") && !cols.has("archivedAt")) {
    await run(`ALTER TABLE events ADD COLUMN archived_at TEXT`);
    cols.add("archived_at");
  }
  if (!cols.has("archived_reason") && !cols.has("archivedReason")) {
    await run(`ALTER TABLE events ADD COLUMN archived_reason TEXT`);
    cols.add("archived_reason");
  }

  // Optional index for faster filtering
  try {
    if (cols.has("archived")) await run(`CREATE INDEX IF NOT EXISTS idx_events_archived ON events(archived)`);
    if (cols.has("isArchived")) await run(`CREATE INDEX IF NOT EXISTS idx_events_isArchived ON events(isArchived)`);
  } catch (_) {}

  _archiveSchemaEnsured = true;
}

// GET /admin
router.get("/", async (req, res) => {
  try {
    // ✅ Pagination + total count + optional server-side search
const limit = Math.max(5, Math.min(200, parseInt(req.query.limit || "20", 10)));
const pg = Math.max(1, parseInt(req.query.pg || "1", 10));
const offset = (pg - 1) * limit;

const q = String(req.query.q || "").trim();
const sort = String(req.query.sort || "datetime"); // datetime | alpha | recent | id

// Archive filter (best practice: soft-delete via archived_at + is_archived)
const archivedMode = String(req.query.archived || "0"); // "0"=active, "1"=archived, "all"=all

let whereParts = [];
let whereParams = [];

// Search
if (q) {
  const like = `%${q}%`;
  whereParts.push(`(title LIKE ? OR slug LIKE ? OR location LIKE ? OR CAST(id AS TEXT) LIKE ?)`);
  whereParams.push(like, like, like, like);
}

// Archive constraints (only if DB has the columns)
const colsForWhere = await getEventsColumns();
const colArchived = colsForWhere.has("archived")
  ? "archived"
  : (colsForWhere.has("isArchived") ? "isArchived" : null);

const colArchivedAt = colsForWhere.has("archived_at")
  ? "archived_at"
  : (colsForWhere.has("archivedAt") ? "archivedAt" : null);

const selectArchived = colArchived ? `COALESCE(${colArchived},0) as isArchived` : `0 as isArchived`;
const selectArchivedAt = colArchivedAt ? `${colArchivedAt} as archivedAt` : `NULL as archivedAt`;

if (colArchived) {
  if (archivedMode === "1") whereParts.push(`${colArchived} = 1`);
  else if (archivedMode === "0") whereParts.push(`(${colArchived} IS NULL OR ${colArchived} = 0)`);
  // "all" => no clause
} else {
  // If schema doesn't support archive yet, force active view behavior
  if (archivedMode === "1") whereParts.push(`1=0`);
}

const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

const totalRow = await get(`SELECT COUNT(*) AS n FROM events ${whereSql}`, whereParams);
const total = Number(totalRow?.n || 0);
const pages = Math.max(1, Math.ceil(total / limit));
const hasPrev = pg > 1;
const hasNext = pg < pages;

function adminUrl(nextPg) {
  const sp = new URLSearchParams(req.query);
  sp.set("pg", String(nextPg));
  sp.set("limit", String(limit));
  if (sort) sp.set("sort", sort);
  if (q) sp.set("q", q);
  if (archivedMode) sp.set("archived", archivedMode);
  return `/admin?${sp.toString()}`;
}

const showingFrom = total ? offset + 1 : 0;
const showingTo = Math.min(offset + limit, total);

const pagerHtml = `
  <div class="pager">
    <div class="pager-left">
      <span class="muted">Total: <strong style="color:var(--text)">${total}</strong></span>
      <span class="muted">Showing ${showingFrom}–${showingTo}</span>
    </div>
    <div class="pager-right">
      <a class="btn" href="${adminUrl(1)}" ${pg === 1 ? 'style="opacity:.45; pointer-events:none;"' : ""}>First</a>
      <a class="btn" href="${adminUrl(Math.max(1, pg - 1))}" ${!hasPrev ? 'style="opacity:.45; pointer-events:none;"' : ""}>Prev</a>
      <span class="muted" style="padding:0 8px;">Page <strong style="color:var(--text)">${pg}</strong> / ${pages}</span>
      <a class="btn" href="${adminUrl(Math.min(pages, pg + 1))}" ${!hasNext ? 'style="opacity:.45; pointer-events:none;"' : ""}>Next</a>
      <a class="btn" href="${adminUrl(pages)}" ${pg === pages ? 'style="opacity:.45; pointer-events:none;"' : ""}>Last</a>
    </div>
  </div>
`;


// Sort for listing
let orderBySql = "startDateTime ASC";
try {
  const colsForSort = await getEventsColumns();
  if (sort === "alpha") orderBySql = "title COLLATE NOCASE ASC";
  else if (sort === "recent") {
    orderBySql = colsForSort.has("createdAt") ? "datetime(createdAt) DESC" : "id DESC";
  } else if (sort === "id") orderBySql = "id DESC";
  else orderBySql = "startDateTime ASC";
} catch (_) {
  if (sort === "alpha") orderBySql = "title COLLATE NOCASE ASC";
  else if (sort === "recent") orderBySql = "id DESC";
  else if (sort === "id") orderBySql = "id DESC";
  else orderBySql = "startDateTime ASC";
}

// ✅ Resilient list query: supports optional columns
let events = [];
try {
  events = await all(
    `SELECT id, slug, title, startDateTime, location, featured,
            goingCount, interestedCount, viewCount, uniqueViewCount, lastViewedAt, imageUrl,
            ${selectArchived}, ${selectArchivedAt}
     FROM events
     ${whereSql}
     ORDER BY ${orderBySql}
     LIMIT ? OFFSET ?`,
    [...whereParams, limit, offset]
  );
} catch (err) {
  events = await all(
    `SELECT id, slug, title, startDateTime, location, featured
     FROM events
     ${whereSql}
     ORDER BY ${orderBySql}
     LIMIT ? OFFSET ?`,
    [...whereParams, limit, offset]
  );
  events = events.map((x) => ({
    ...x,
    goingCount: 0,
    interestedCount: 0,
    viewCount: 0,
    uniqueViewCount: 0,
    lastViewedAt: null,
    imageUrl: null,
    isArchived: 0,
    archivedAt: null,
    imageUrl: null,
  }));
}


    const editId = req.query.edit ? parseInt(req.query.edit, 10) : null;
    let editEvent = null;
    if (editId) editEvent = await get("SELECT * FROM events WHERE id = ?", [editId]);

    const selectedCats = normalizeCategories(parseStoredCategories(editEvent?.categories));
    const isFeatured = Number(editEvent?.featured || 0) === 1;

    // ✅ recurrence values for UI (these existed in your file, UI block was missing)
    const hasRecurrence = Number(editEvent?.hasRecurrence || 0) === 1;
    const rule = parseStoredRule(editEvent?.recurrenceRule) || { type: "none", interval: 1 };
    const ruleType = String(rule.type || (hasRecurrence ? "weekly" : "none")).toLowerCase();
    const storedRecurrenceDates = parseStoredDates(editEvent?.recurrenceDates);

    const customDates = (function(){
      if (ruleType != "custom") return [];

      const items = Array.isArray(rule?.items) ? rule.items : [];
      if (items.length) {
        return items
          .map((it) => ({
            start: String(it?.start || "").trim(),
            end: String(it?.end || "").trim(),
          }))
          .filter((it) => it.start && it.end);
      }

      const baseStart = String(editEvent?.startDateTime || "").trim();
      const baseEnd   = String(editEvent?.endDateTime || "").trim();

      return (storedRecurrenceDates || [])
        .map((d) => {
          if (d && typeof d === "object") {
            const s = String(d.start || "").trim();
            const e = String(d.end || "").trim();
            if (s && e) return { start: s, end: e };
          }

          const date = String(d || "").trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

          if (baseStart.length >= 16 && baseEnd.length >= 16) {
            return { start: date + baseStart.slice(10), end: date + baseEnd.slice(10) };
          }

          return { start: date + "T00:00:00+00:00", end: date + "T00:00:00+00:00" };
        })
        .filter(Boolean);
    })();
    const recurrenceStartDateVal = editEvent?.recurrenceStartDate || toDateValue(editEvent?.startDateTime) || "";
    const recurrenceUntilDateVal = editEvent?.recurrenceUntilDate || "";

    const weeklyByDay = Array.isArray(rule.byDay) ? rule.byDay : [];
    const monthlyMode = String(rule.mode || "monthday");
    const byMonthday = rule.byMonthday ? String(rule.byMonthday) : "";
    const setPos = rule.setPos ? String(rule.setPos) : "1";
    const monthlyByDay = rule.byDay ? String(rule.byDay) : "MO";
    const recurrenceInterval = rule.interval ? String(rule.interval) : "1";

    const categorySelect = (idx) => {
      const current = selectedCats[idx] || "";
      return `
        <select name="categories" class="ctrl">
          <option value="">— None —</option>
          ${ALLOWED_CATEGORIES
            .map((c) => {
              const sel = current === c ? "selected" : "";
              return `<option value="${esc(c)}" ${sel}>${esc(c)}</option>`;
            })
            .join("")}
        </select>
      `;
    };

    const listHtml = events.length
      ? events
          .map((e) => {
  const going = Number(e.goingCount || 0);
  const interested = Number(e.interestedCount || 0);
const views = Number(e.viewCount || 0);
const uniques = Number(e.uniqueViewCount || 0);

            const thumbHtml = e.imageUrl
              ? `
                <a class="thumb-link" href="${esc(e.imageUrl)}" target="_blank" rel="noopener" title="View image">
                  <img class="event-thumb-img" src="${esc(e.imageUrl)}" alt="${esc(e.title)} flyer" loading="lazy"
                       onerror="this.closest('.event-thumb').classList.add('broken'); this.style.display='none';" />
                  <div class="thumb-fallback">Image not found</div>
                </a>
              `
              : `<div class="thumb-empty">No image</div>`;

return `
  <div class="event-card" data-eid="${e.id}">
    <div class="event-thumb">${thumbHtml}</div>

    <div class="event-left">
      <div class="event-title">
        #${e.id} — ${esc(e.title)}
        ${
          Number(e.featured || 0) === 1
            ? `<span class="pill" style="margin-left:8px;">Featured</span>`
            : ""
        }
        ${
          Number(e.isArchived || 0) === 1
            ? `<span class="pill" style="margin-left:8px; background: rgba(148,163,184,.12); border-color: rgba(148,163,184,.22); color: rgba(229,231,235,.85);">Archived</span>`
            : ""
        }
      </div>

      <div class="event-meta">
        <div><strong>Slug:</strong> ${esc(e.slug || "")}</div>
        <div><strong>Start:</strong> ${esc(e.startDateTime)}</div>
        <div><strong>Location:</strong> ${esc(e.location)}</div>
      </div>

      <div class="event-actions">
        <a href="${e.slug ? `/events/slug/${esc(e.slug)}` : `/events/${e.id}`}"
           target="_blank" rel="noopener">View JSON</a>

        <a class="btn btn-edit" href="/admin?edit=${e.id}&pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${archivedMode ? `&archived=${encodeURIComponent(archivedMode)}` : ""}">Edit</a>

        <form method="POST"
              action="/admin/events/${e.id}/delete?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${archivedMode ? `&archived=${encodeURIComponent(archivedMode)}` : ""}"
              class="inline"
              onsubmit="return confirm('Delete this event permanently? This cannot be undone.');">
          <button type="submit" class="btn btn-danger">Delete</button>
        </form>

        ${
          Number(e.isArchived || 0) === 1
            ? `
              <form method="POST"
                    action="/admin/events/${e.id}/unarchive?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${archivedMode ? `&archived=${encodeURIComponent(archivedMode)}` : ""}"
                    class="inline"
                    onsubmit="return confirm('Unarchive this event?');">
                <button type="submit" class="btn">Unarchive</button>
              </form>
            `
            : `
              <form method="POST"
                    action="/admin/events/${e.id}/archive?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${archivedMode ? `&archived=${encodeURIComponent(archivedMode)}` : ""}"
                    class="inline"
                    onsubmit="return confirm('Archive this event? (It will be hidden from the public list)');">
                <button type="submit" class="btn">Archive</button>
              </form>
            `
        }
      </div>
    </div>
<div class="event-stats">
  <div class="stat"><span>Views</span><strong class="js-views">${views}</strong></div>
  <div class="stat"><span>Unique</span><strong class="js-unique">${uniques}</strong></div>
  <div class="stat"><span>Going</span><strong class="js-going">${going}</strong></div>
  <div class="stat"><span>Interested</span><strong class="js-interested">${interested}</strong></div>
  <div class="note" style="margin-top:10px;">Live</div>
</div>

    </div>
  `;
})
          .join("")
      : `<div class="muted">No events yet.</div>`;

    const isChecked = (arr, code) => (arr.includes(code) ? "checked" : "");

    // ===== Dashboard metrics + widgets =====
    const cols = await getEventsColumns();

    // Apply archive filter to dashboard widgets when supported
    const hasArchiveCols2 = cols.has("isArchived") && cols.has("archivedAt");
    let dashWhere = "";
    if (hasArchiveCols2) {
      if (archivedMode === "1") dashWhere = "WHERE isArchived = 1";
      else if (archivedMode === "0") dashWhere = "WHERE (isArchived IS NULL OR isArchived = 0)";
      // all => no where
    } else {
      if (archivedMode === "1") dashWhere = "WHERE 1=0";
    }

    const dashWhereSql = dashWhere ? (dashWhere + " ") : "";
    const dashAnd = dashWhere ? (dashWhere + " AND ") : "WHERE ";


    // Counts
    const upcomingRow = await get(
      `SELECT COUNT(*) AS n FROM events ${dashAnd}datetime(startDateTime) >= datetime('now')`
    );
    const pastRow = await get(
      `SELECT COUNT(*) AS n FROM events ${dashAnd}datetime(startDateTime) < datetime('now')`
    );
    const featuredRow = await get(`SELECT COUNT(*) AS n FROM events ${dashAnd}featured = 1`);

    const upcoming = Number(upcomingRow?.n || 0);
    const past = Number(pastRow?.n || 0);
    const featuredCount = Number(featuredRow?.n || 0);

    // Optional sums (only if columns exist)
    let viewsSum = 0;
    if (cols.has("viewCount")) {
      const r = await get(`SELECT COALESCE(SUM(viewCount), 0) AS n FROM events ${dashWhereSql}`);
      viewsSum = Number(r?.n || 0);
    }

    const fmt = (n) => Number(n || 0).toLocaleString("en-US");

    const stats = {
      total: fmt(total),
      upcoming: fmt(upcoming),
      past: fmt(past),
      featured: fmt(featuredCount),
      views: fmt(viewsSum),
      serverTime: new Date().toISOString().replace("T", " ").slice(0, 19) + "Z",
    };

    // Top organizers
    const orgRows = await all(`
      SELECT 
        COALESCE(NULLIF(TRIM(organizer), ''), '(unknown)') AS organizer,
        COUNT(*) AS c
      FROM events
      GROUP BY organizer
      ORDER BY c DESC
      LIMIT 7
    `);

    const topOrganizersHtml = orgRows
      .map((r) => {
        const label = esc(r.organizer);
        const count = Number(r.c || 0);
        return `<div class="kv"><div class="k">${label}</div><div class="v">${count}</div></div>`;
      })
      .join("");

    // ------------------------------
    // Chart: Daily / Weekly / Monthly / Yearly
    // ------------------------------
    const buildDaily = async () => {
      const rows = await all(
        `SELECT date(startDateTime) AS d, COUNT(*) AS n
         FROM events
         ${dashAnd}date(startDateTime) >= date('now','-13 day')
         GROUP BY d
         ORDER BY d`
      );
      const byDay = new Map((rows || []).map((r) => [String(r.d), Number(r.n || 0)]));
      const labels = [];
      const values = [];
      for (let i = 13; i >= 0; i--) {
        const dt = new Date();
        dt.setDate(dt.getDate() - i);
        const key = dt.toISOString().slice(0, 10); // YYYY-MM-DD
        labels.push(key.slice(5)); // MM-DD
        values.push(byDay.get(key) || 0);
      }
      return { labels, values };
    };

    const buildWeekly = async () => {
      // Group by Monday week-start. Keep last 12 weeks.
      const rows = await all(
        `SELECT date(startDateTime, 'weekday 1', '-7 day') AS wk, COUNT(*) AS n
         FROM events
         ${dashAnd}date(startDateTime) >= date('now','-83 day')
         GROUP BY wk
         ORDER BY wk`
      );
      const byWk = new Map((rows || []).map((r) => [String(r.wk), Number(r.n || 0)]));
      const labels = [];
      const values = [];
      // Walk back 11 weeks to current week
      const now = new Date();
      const day = now.getDay(); // 0 Sun..6 Sat
      // Monday start
      const monday = new Date(now);
      const diffToMon = (day + 6) % 7;
      monday.setDate(monday.getDate() - diffToMon);
      for (let i = 11; i >= 0; i--) {
        const dt = new Date(monday);
        dt.setDate(dt.getDate() - i * 7);
        const key = dt.toISOString().slice(0, 10);
        // Label as MM-DD of week start
        labels.push(key.slice(5));
        values.push(byWk.get(key) || 0);
      }
      return { labels, values };
    };

    const buildMonthly = async () => {
      // Last 12 months, group by YYYY-MM.
      const rows = await all(
        `SELECT strftime('%Y-%m', startDateTime) AS ym, COUNT(*) AS n
         FROM events
         ${dashAnd}date(startDateTime) >= date('now','start of month','-11 month')
         GROUP BY ym
         ORDER BY ym`
      );
      const byYm = new Map((rows || []).map((r) => [String(r.ym), Number(r.n || 0)]));
      const labels = [];
      const values = [];
      const d = new Date();
      d.setDate(1);
      for (let i = 11; i >= 0; i--) {
        const dt = new Date(d);
        dt.setMonth(dt.getMonth() - i);
        const ym = dt.toISOString().slice(0, 7);
        // Label as Mon (and year if different from current year)
        const mon = dt.toLocaleString('en-US', { month: 'short' });
        const yr = dt.getFullYear();
        const curYr = new Date().getFullYear();
        labels.push(yr === curYr ? mon : `${mon} ${String(yr).slice(-2)}`);
        values.push(byYm.get(ym) || 0);
      }
      return { labels, values };
    };

    const buildYearly = async () => {
      // Last 5 years, group by YYYY.
      const rows = await all(
        `SELECT strftime('%Y', startDateTime) AS y, COUNT(*) AS n
         FROM events
         ${dashAnd}date(startDateTime) >= date('now','start of year','-4 year')
         GROUP BY y
         ORDER BY y`
      );
      const byY = new Map((rows || []).map((r) => [String(r.y), Number(r.n || 0)]));
      const labels = [];
      const values = [];
      const curY = new Date().getFullYear();
      for (let y = curY - 4; y <= curY; y++) {
        labels.push(String(y));
        values.push(byY.get(String(y)) || 0);
      }
      return { labels, values };
    };

    const chartSets = {
      daily: await buildDaily(),
      weekly: await buildWeekly(),
      monthly: await buildMonthly(),
      yearly: await buildYearly(),
    };
    const chartDataJson = JSON.stringify(chartSets);

    res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="/assets/brand/favicon.ico" />
    <title>Dashboard</title>
    <style>
      :root{
        /* Main (light, WordPress-like) */
        --bg:#eef2f6;
        --panel:#ffffff;
        --panel2:#f8fafc;
        --text:#0f172a;
        --muted:#475569;
        --line:rgba(15,23,42,.12);
        --brand:#00c08b;
        --brand2:#0ea5e9;
        --danger:#ef4444;
        --shadow:none;
        --radius:8px;
        --radius-inner:6px;
        --radius2:8px;
        --gap:22px;

        /* Sidebar (dark) */
        --sidebar-bg:#0b1220;
        --sidebar-panel:#0f172a;
        --sidebar-text:#e5e7eb;
        --sidebar-muted:#475569;
        --sidebar-line:rgba(148,163,184,.16);
      }

      *{ box-sizing:border-box; }
      body{
        margin:0;
        background:var(--bg);
        color:var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      }

      /* Layout */
      .app{ display:flex; min-height:100vh; }

      .sidebar{
        width:220px;
        background:var(--sidebar-panel);
        border-right:1px solid var(--sidebar-line);
        padding:18px;
        position:sticky; top:0; height:100vh; overflow:auto;
        display:flex; flex-direction:column;
        color:var(--sidebar-text);
      }
      .sidebar .card{
        background: rgba(255,255,255,.04);
        border-color: var(--sidebar-line);
        color: var(--sidebar-text);
        box-shadow:none;
      }
      .sidebar .card .muted{ color: var(--sidebar-muted); }
      .sb-brand{
        display:flex; align-items:center; justify-content:flex-start; margin-bottom:14px;
      }
      .sb-brand img{
        width:150px;
        max-width:150px;
        height:auto;
        display:block;
      }
      .sb-title{ font-weight:650; letter-spacing:.2px; }
      .sb-sub{ font-size:12px; color:var(--sidebar-muted); margin-top:2px; }

      .nav{ display:grid; gap:8px; margin-top:10px; }
      .sb-bottom{ margin-top:auto; display:grid; gap:10px; }
      .sidebar .mini a{ color:#38bdf8; font-weight:600; }
      .sidebar .mini a:hover{ color:#7dd3fc; }

      /* Keep sidebar widgets dark (Quick links / Tip) */
      .sidebar .mini{
        border: 1px solid var(--sidebar-line);
        background: rgba(255,255,255,.04);
        color: var(--sidebar-text);
      }
      .sidebar .mini .small{ color: var(--sidebar-muted); }
      .sidebar .note{ color: var(--sidebar-muted); }

      /* Sidebar checkboxes should stay dark */
      .sidebar input[type="checkbox"]{
        border-color: rgba(148,163,184,.35) !important;
        background: rgba(255,255,255,.04) !important;
      }
      .sidebar .note{ color: var(--sidebar-muted); }
      .nav a{
        text-decoration:none; color:var(--sidebar-muted);
        display:flex; align-items:center; gap:10px;
        padding:10px 12px; border-radius: var(--radius);
        border:1px solid transparent;
        font-weight:600; font-size:13px;
      }
      .nav a .n-dot{
        width:8px; height:8px; border-radius:999px; background: rgba(100,116,139,.35);
      }
      .nav a.active{
        color:var(--sidebar-text);
        background: rgba(0,192,139,.10);
        border-color: rgba(0,192,139,.22);
      }
      .nav a.active .n-dot{ background: var(--brand); }

      .main{
        flex:1;
        padding:22px;
        min-width:0;
      }

      /* Header */
      .header{
        display:flex; align-items:center; justify-content:space-between; gap:14px;
        margin-bottom:var(--gap);
      }
      .h-left h1{ margin:0; font-size:22px; letter-spacing:.2px; font-weight:600; }
      .h-left p{ margin:6px 0 0; color:var(--muted); font-size:13px; }
      .h-right{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }

      .search{
        display:flex; align-items:center; gap:10px;
        background:var(--panel);
        border:1px solid var(--line);
        border-radius: var(--radius-inner);
        padding: 10px 12px;
        box-shadow: var(--shadow);
      }
      .search input{
        border:0; outline:none; background:transparent;
        width: 520px;
        min-width: 360px;
        font-size:14px; font-weight:500; color:var(--text);
      }

      /* Cards + widgets */
      .card{
        background:var(--panel);
        border:1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        padding: 16px;
      }

      /* Chart card uses the original dark treatment so the canvas grid/ticks remain legible */
      .chartCard{
  background: var(--panel);
  border-color: var(--line);
  box-shadow: var(--shadow);
  color: var(--text);
}
.chartCard h2,
.chartCard h3{
  color: var(--text);
}
.chartCard .muted,
.chartCard .statLine{
  color: var(--muted);
}

.metrics{
        display:grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap:var(--gap);
        margin-bottom:var(--gap);
      }
      .metric{
        display:flex; align-items:flex-end; justify-content:space-between; gap:10px;
        padding:14px;
        border-radius: var(--radius);
        background: var(--panel);
        border:1px solid var(--line);
        box-shadow: var(--shadow);
      }
      .metric .k{ color:var(--muted); font-size:12px; font-weight:600; }
      .metric .v{ font-size:22px; font-weight:650; letter-spacing:.2px; margin-top:6px; color: var(--text); }
      .metric .tag{
        font-size:12px; font-weight:650;
        padding:6px 10px; border-radius: var(--radius);
        background: rgba(0,192,139,.12);
        border: 1px solid rgba(0,192,139,.22);
        color: #065f46;
        white-space:nowrap;
      }
      .metric .tag.blue{
        background: rgba(14,165,233,.12);
        border-color: rgba(14,165,233,.20);
        color: #0c4a6e;
      }

      .grid2{
        display:grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap:var(--gap);
        margin-bottom:var(--gap);
        align-items: stretch;
      }
      .grid2 > .card{ height:100%; }
      .grid2 > .card:first-child{ grid-column: span 3; display:flex; flex-direction:column; }
      .grid2 > .card:last-child{ grid-column: span 1; display:flex; flex-direction:column; }

      .grid2 > .card:last-child .sectionTitle{ margin-bottom:12px; }
      .grid2 > .card:last-child .mini{ flex:1 1 auto; }
      .grid2 > .card:last-child .mini + .mini{ margin-top:var(--gap); }

      .gridMain{
        display:grid;
        /* 40% Create form / 60% Existing events */
        grid-template-columns: 2fr 3fr;
        gap:var(--gap);
        align-items:start;
      }

      @media (max-width: 1100px){
        .metrics{ grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .grid2{ grid-template-columns: 1fr; }
        .gridMain{ grid-template-columns: 1fr; }
        .rail{ display:none; }
        .sidebar{ display:none; }
        .main{ padding:16px; }
        .search input{ min-width: 160px; }
      }

      h2{ margin:0 0 10px; font-size:16px; font-weight:600; }
      .sub{ margin:0; color:var(--muted); font-size:13px; }

      /* Controls */
      label{ display:block; margin: 12px 0 6px; font-weight:600; font-size:12px; color:var(--text); }
            .ctrl,
      input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),
      textarea,
      select{
        width:100%;
        padding: 11px 12px;
        border: 1px solid var(--line);
        border-radius: var(--radius-inner);
        background: var(--panel2);
        color: var(--text);
        font-size: 14px;
        outline: none;
      }

      /* File input */
      input[type="file"]{
        width:100%;
        padding:10px 12px;
        border: 1px solid var(--line);
        border-radius: var(--radius-inner);
        background: var(--panel2);
        color: var(--text);
        font-size: 14px;
      }
      input[type="file"]::file-selector-button{
        margin-right: 12px;
        padding: 10px 12px;
        border-radius: var(--radius-inner);
        border: 1px solid var(--line);
        background: #ffffff;
        color: var(--text);
        font-weight:600;
        cursor:pointer;
      }
      input[type="file"]::file-selector-button:hover{
        background: #f1f5f9;
      }

      /* Square checkboxes */
      input[type="checkbox"]{
        width:18px;
        height:18px;
        border-radius:4px;
        border:1px solid var(--line);
        background:#ffffff;
        appearance:none;
        -webkit-appearance:none;
        display:inline-grid;
        place-content:center;
      }
      input[type="checkbox"]::before{
        content:"";
        width:10px;
        height:10px;
        transform: scale(0);
        transition: transform .08s ease-in-out;
        background: var(--brand);
        border-radius:2px;
      }
      input[type="checkbox"]:checked::before{
        transform: scale(1);
      }
      input[type="checkbox"]:focus{
        box-shadow: 0 0 0 4px rgba(0,192,139,.12);
        border-color: rgba(0,192,139,.35);
      }
      .ctrl:focus, input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):focus, textarea:focus, select:focus{
        box-shadow: 0 0 0 4px rgba(0,192,139,.12);
        border-color: rgba(0,192,139,.35);
        background: var(--panel);
      }


      /* Checkbox + file input (avoid stock UI) */
      input[type="checkbox"]{
        -webkit-appearance:none; appearance:none;
        width:18px !important; height:18px !important;
        border-radius:0px;
        border:1px solid rgba(148,163,184,.28);
        background: var(--panel);
        display:inline-grid; place-content:center;
        cursor:pointer;
      }
      input[type="checkbox"]::before{
        content:"";
        width:10px; height:10px;
        border-radius: 0 !important;
        transform: scale(0);
        transition: transform .12s ease;
        background: var(--brand);
      }
      input[type="checkbox"]:checked::before{ transform: scale(1); }
      input[type="checkbox"]:focus{ box-shadow: 0 0 0 4px rgba(0,192,139,.12); border-color: rgba(0,192,139,.35); }

      input[type="file"]{
        padding:10px;
        background: var(--panel2);
        color: var(--muted);
      }
      input[type="file"]::file-selector-button{
        margin-right:12px;
        border:1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        padding:10px 12px;
        border-radius: var(--radius-inner);
        font-weight:600;
        cursor:pointer;
      }
      input[type="file"]::file-selector-button:hover{
        border-color: rgba(0,192,139,.28);
        box-shadow: 0 0 0 4px rgba(0,192,139,.10);
      }
      textarea{ min-height: 110px; resize: vertical; }
      .note{ font-size: 12px; color: var(--muted); margin-top:8px; }

      .btn{
        display:inline-flex; align-items:center; justify-content:center;
        padding: 10px 14px;
        border-radius: var(--radius-inner);
        border: 1px solid var(--line);
        background: var(--panel);
        cursor:pointer;
        font-weight:600;
        text-decoration:none;
        color: var(--text);
      }
      .btn:hover{ transform: translateY(-1px); }
      .btn-primary{
        background: var(--brand);
        border-color: var(--brand);
        color:#ffffff;
      }
      .btn-primary:hover{ background: #00b681; border-color: #00b681; }
      .btn-danger{
        background: rgba(239,68,68,.10);
        border-color: rgba(239,68,68,.18);
        color: #991b1b;
      }
      .btn-link{
        background: transparent;
        border-color: transparent;
        color: var(--brand);
        padding: 8px 10px;
      }

      .actions{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top: 14px; }
      .inline{ display:inline; margin:0; }
      .muted{ color: var(--muted); }

      a:not(.btn){ color: var(--brand2); text-decoration:none; font-weight:600; }
      a:not(.btn):hover{ text-decoration:underline; }

      /* Small widgets */
      .mini{
        border: 1px solid var(--line);
        background: var(--panel2);
        border-radius: var(--radius-inner);
        padding: 12px;
      }
      .mini + .mini{ margin-top:var(--gap); }
      .kv{ display:flex; justify-content:space-between; align-items:center; margin: 6px 0; color:var(--muted); font-size:13px; }
      .kv strong{ color:var(--text); font-size:14px; }

      /* Chart */
      .chart-wrap{ position:relative; height:320px; min-height:320px; }
      /* Keep canvas CSS height aligned with the inline height attribute (260px) */
      .chart-wrap canvas{ width:100%; height:260px; display:block; }

      .seg{
        display:inline-flex;
        align-items:center;
        gap:6px;
        padding:6px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--panel2);
      }
      .seg button{
        appearance:none;
        border: 1px solid transparent;
        background: transparent;
        color: var(--muted);
        padding: 7px 10px;
        border-radius: 999px;
        font-weight: 650;
        cursor: pointer;
        line-height: 1;
      }
      .seg button:hover{ color: var(--text); }
      .seg button.on{
        background: rgba(0,192,139,.14);
        border-color: rgba(0,192,139,.28);
        color: #065f46;
      }

      /* Existing events list */
      .event-card{
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 14px;
        background: var(--panel);
        display:flex;
        justify-content:space-between;
        gap:16px;
        align-items:flex-start;
      }
      .event-left{ flex: 1; min-width: 0; }
      .event-title{ font-weight:650; margin-bottom:6px; }
      .event-meta{ color: var(--muted); font-size: 13px; display:grid; gap:4px; }
      .event-actions{ margin-top:10px; display:flex; gap:var(--gap); align-items:center; flex-wrap:wrap; }

      
      .event-actions .btn{ min-width: 104px; height:40px; }
      .event-actions .btn{ padding: 10px 14px; }
.pill{
        font-size:12px;
        background: rgba(0,192,139,.12);
        border: 1px solid rgba(0,192,139,.22);
        padding: 6px 10px;
        border-radius: var(--radius-inner);
        font-weight:650;
        color:#065f46;
        display:inline-flex; align-items:center; gap:6px;
      }

      .event-thumb{
        width: 116px; flex: 0 0 116px;
      }
      .event-thumb-img{
        width: 116px; height: 116px;
        object-fit: cover;
        border-radius: var(--radius-inner);
        border: 1px solid var(--line);
        display:block;
      }
      .thumb-empty,
      .thumb-fallback{
        width: 116px; height: 116px;
        border-radius: var(--radius-inner);
        border: 1px solid var(--line);
        display:flex; align-items:center; justify-content:center;
        font-size: 12px; color: var(--muted);
        background: var(--panel2);
        text-align:center;
        padding: 8px;
      }
      .event-thumb .thumb-fallback{ display:none; }
      .event-thumb.broken .thumb-fallback{ display:flex; }

      .event-stats{
        width: 170px; flex: 0 0 170px;
        border: 1px solid var(--line);
        border-radius: var(--radius-inner);
        padding: 12px;
        background: var(--panel2);
      }
      .stat{ display:flex; justify-content:space-between; align-items:center; font-size: 13px; color: var(--muted); margin: 6px 0; }
      .stat strong{ color: var(--text); font-size: 16px; }

      .pager{
        display:grid;
        grid-template-columns: 1fr auto;
        align-items:center;
        gap:var(--gap);
        margin: 10px 0 14px;
      }
      .pager-right{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; justify-self:end; }
      .pager-left{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; min-width:0; }

      /* Existing events: keep Clear inline with search (wrap only on small screens) */
      .listSearchRow{
        display:grid;
        grid-template-columns: 1fr auto;
        gap:var(--gap);
        align-items:center;
        margin: 10px 0 14px;
      }
      .listSearchRow #eventSearch{ flex: 1 1 auto; min-width: 280px; }
      @media (max-width: 900px){
        .listSearchRow{ flex-wrap: wrap; }
        .listSearchRow #eventSearch{ flex: 1 1 100%; min-width: 0; }
      }

      /* Category selection */
      .cat-grid{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; }
      @media (max-width: 900px){ .cat-grid{ grid-template-columns: 1fr; } }

      /* Recurrence UI polish (keep your functionality, just match the new look) */
      .recurrence{ background: var(--panel2); border:1px solid var(--line); border-radius: var(--radius-inner); padding: 14px; }
      .rec-grid{ display:grid; grid-template-columns: 1.2fr .8fr; gap: 16px; align-items: start; }
      @media (max-width: 900px){ .rec-grid{ grid-template-columns: 1fr; } }
      .rec-label{ font-weight:650; font-size: 12px; margin-bottom: 8px; color: var(--text); letter-spacing: .2px; }
      .rec-help{ margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.4; }

      .rec-box{ border:1px solid var(--line); border-radius: var(--radius-inner); padding: 14px; background: var(--panel2); margin-top: 10px; }
      .checkbox{ display:flex; gap:10px; align-items:center; margin-top: 8px; font-weight:650; }
      input[type=checkbox]{ width:18px; height:18px; border-radius:0px !important; accent-color: var(--brand); }
      .checkbox input{ width:18px !important; height:18px !important; border-radius:0px !important; }

      .dow{ display:flex; flex-wrap:wrap; gap: 10px; margin-top: 10px; }
      .dow-pill{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap: 8px;
        padding: 10px 12px;
        border-radius: var(--radius);
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        font-weight:650;
        font-size: 13px;
        cursor: pointer;
        user-select:none;
      }
      .dow-pill input{ position:absolute; opacity:0; pointer-events:none; }
      .dow-pill:has(input:checked){
        background: rgba(0,192,139,.12);
        border-color: rgba(0,192,139,.28);
        box-shadow: 0 0 0 4px rgba(0,192,139,.10);
      }

      .chips{ display:flex; flex-wrap:wrap; gap:8px; margin-top: 10px; }
      .chip{
        display:inline-flex; align-items:center; gap:8px;
        border:1px solid var(--line);
        border-radius: var(--radius-inner);
        padding: 8px 10px;
        background: var(--panel);
        font-size: 13px;
      }
      .chip button{ border:0; background: transparent; cursor:pointer; font-weight:650; color: #b91c1c; }


      /* Section headers (title above, controls below) */
      .sectionTitle{
        display:flex;
        flex-direction:column;
        align-items:flex-start;
        justify-content:flex-start;
        gap:10px;
        margin-bottom:10px;
      }
      .sectionTitle > div{ width:auto; }
      .sectionTitle .right{ width:auto; display:flex; gap:12px; justify-content:flex-start; flex-wrap:wrap; }
      /* Keep controls in one line on desktop; allow wrap on small screens */
      .sectionTitle .rightRow{
        width:100%;
        display:flex;
        align-items:center;
        justify-content:flex-start;
        gap:10px;
        flex-wrap:nowrap;
      }
      .sectionTitle .rightRow .sortBy{ flex:1; min-width:280px; }

      @media (max-width: 980px){
        .sectionTitle .rightRow{ flex-wrap:wrap; }
      }


      .small{ font-size:12px; color:var(--muted); font-weight:600; }
    

      /* Dark theme tweaks */
      input, textarea, select{
        background: var(--panel2);
        color: var(--text);
        border: 1px solid var(--line);
      }
      input::placeholder, textarea::placeholder{ color: rgba(148,163,184,.75); }
      .btn, button{
        border: 1px solid var(--line);
      }
      .chip{
        background: rgba(148,163,184,.10);
        border: 1px solid var(--line);
      }
      a{ color: var(--text); }
</style>
  </head>
  <body>
    <div class="app">

      <!-- Sidebar -->
      <aside class="sidebar">
        <div class="sb-brand">
          <img src="/assets/brand/oc-logo.svg" alt="OpenCircle" onerror="this.style.display='none';" />
          </div>

        <nav class="nav">
          <a class="active" href="/admin"><span class="n-dot"></span> Events</a>
        </nav>

        <div class="sb-bottom">
          <div class="mini">
            <div class="small">Quick links</div>
            <div style="margin-top:10px; display:grid; gap:8px;">
              <a href="/events" target="_blank" rel="noopener">View events API</a>
              <a href="/uploads" target="_blank" rel="noopener">Uploads directory</a>
            </div>
          </div>

          <div class="mini" style="margin-top:10px;">
            <div class="small">Tip</div>
            <div class="note" style="margin-top:8px;">
              Use the top search to filter server-side (fast + shareable URL). The list also has an instant filter.
            </div>
          </div>
        </div>
      </aside>

      <!-- Main content -->
      <main class="main">
        <div class="header">
          <div class="h-left">
            <h1>Dashboard</h1>
            <p>Overview + event management</p>
          </div>

          <div class="h-right">
            <form class="search" method="GET" action="/admin">
              <input name="q" value="${esc(q)}" placeholder="Search events (title, slug, location, ID)..." />
              <input type="hidden" name="pg" value="1" />
              <input type="hidden" name="limit" value="${esc(String(limit))}" />
              <input type="hidden" name="archived" value="${esc(String(archivedMode))}" />
              <button class="btn btn-primary" type="submit">Search</button>
              ${q ? `<a class="btn" href="/admin?pg=1&limit=${esc(String(limit))}&archived=${esc(String(archivedMode))}">Reset</a>` : ``}
            </form>
          </div>
        </div>

        <!-- Metrics -->
        <section class="metrics" id="analytics">
          <div class="metric">
            <div>
              <div class="k">Total events</div>
              <div class="v">${esc(stats.total)}</div>
            </div>
            <div class="tag">All time</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">Upcoming</div>
              <div class="v">${esc(stats.upcoming)}</div>
            </div>
            <div class="tag blue">Next</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">Featured</div>
              <div class="v">${esc(stats.featured)}</div>
            </div>
            <div class="tag">Pinned</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">Total views</div>
              <div class="v">${esc(stats.views)}</div>
            </div>
            <div class="tag blue">Tracked</div>
          </div>
        </section>

        <!-- Charts -->
        <section class="grid2">
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Events over time</h2>
                <p class="sub" id="chartRangeLabel">Last 14 days (by start date)</p>
              </div>
              <div class="right">
                <div class="seg" id="chartViewSeg" aria-label="Chart view">
                  <button type="button" data-view="daily" class="on">Daily</button>
                  <button type="button" data-view="weekly">Weekly</button>
                  <button type="button" data-view="monthly">Monthly</button>
                  <button type="button" data-view="yearly">Yearly</button>
                </div>
                <span class="small">Past: <strong>${esc(stats.past)}</strong></span>
                <span class="small">Upcoming: <strong>${esc(stats.upcoming)}</strong></span>
              </div>
            </div>
            <div class="chart-wrap" id="eventsChartWrap">
              <canvas id="eventsChart" style="width:100%; height:260px; display:block;"></canvas>
                <div id="eventsChartTip" style="position:absolute; display:none; pointer-events:none; padding:6px 8px; border-radius:10px; border:1px solid rgba(148,163,184,.35); background:rgba(255,255,255,.98); color:rgba(15,23,42,.95); font-size:12px; line-height:1.2; box-shadow:0 8px 20px rgba(15,23,42,.12);"></div>
            </div>
          </div>

          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Top organizers</h2>
                <p class="sub">Most frequent organizers</p>
              </div>
            </div>

            <div class="mini">
              ${topOrganizersHtml}
            </div>

            <div class="mini">
              <div class="small">Status</div>
              <div class="kv"><span>Server time</span><strong>${esc(stats.serverTime)}</strong></div>
              <div class="kv"><span>Pagination</span><strong>${esc(String(limit))}/page</strong></div>
            </div>
          </div>
        </section>

        <!-- Manage -->
        <section class="gridMain" id="manage">
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>${editEvent ? "Edit event" : "Create event"}</h2>
                <p class="sub">This saves to SQLite and powers your API</p>
              </div>
              <div class="right">
                <span class="pill">/admin</span>
              </div>
            </div>

            <form method="POST" action="/admin/events" enctype="multipart/form-data">
              ${editEvent ? `<input type="hidden" name="id" value="${esc(editEvent.id)}" />` : ""}

              <label>City</label>
              <input class="ctrl" name="city" value="${esc(editEvent?.city || "Enumclaw")}" />

              <input type="hidden" name="startDateTimeISO" id="startDateTimeISO" value="" />
              <input type="hidden" name="endDateTimeISO" id="endDateTimeISO" value="" />

              <div class="rec-box">
                <div class="checkbox">
                  <input type="checkbox" id="featured" name="featured" value="1" ${isFeatured ? "checked" : ""} />
                  <label for="featured" style="margin:0;font-size:12px;font-weight:650;">Featured event</label>
                </div>
                <div class="note">Featured events show a badge on the event card and event page.</div>
              </div>

              <div class="rec-box">
                <div style="font-weight:650; margin-bottom:6px;">Categories (pick up to 3)</div>
                <div class="cat-grid">
                  <div><div class="muted" style="font-size:12px; margin-bottom:6px;">Category 1</div>${categorySelect(0)}</div>
                  <div><div class="muted" style="font-size:12px; margin-bottom:6px;">Category 2</div>${categorySelect(1)}</div>
                  <div><div class="muted" style="font-size:12px; margin-bottom:6px;">Category 3</div>${categorySelect(2)}</div>
                </div>
                <div class="note">Max 3. Only your allow-list categories are accepted.</div>
              </div>

              <label>Title</label>
              <input class="ctrl" name="title" value="${esc(editEvent?.title || "")}" required />

              <label>Description</label>
              <textarea class="ctrl" name="description" required>${esc(editEvent?.description || "")}</textarea>

              <label>Event Details</label>
              <textarea class="ctrl" name="eventDetails">${esc(editEvent?.eventDetails || "")}</textarea>

              <label>Good to Know</label>
              <textarea class="ctrl" name="goodToKnow">${esc(editEvent?.goodToKnow || "")}</textarea>

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Start</label>
                  <input id="startDateTime" class="ctrl" type="datetime-local" name="startDateTime"
                    value="${esc(toDateTimeLocalValue(editEvent?.startDateTime))}" required />
                </div>
                <div>
                  <label style="margin-top:0;">End</label>
                  <input id="endDateTime" class="ctrl" type="datetime-local" name="endDateTime"
                    value="${esc(toDateTimeLocalValue(editEvent?.endDateTime))}" required />
                </div>
              </div>

              <!-- Recurring Events -->
              <div class="rec-box recurrence">
                <div class="checkbox">
                  <input type="checkbox" id="hasRecurrence" name="hasRecurrence" value="1" ${hasRecurrence ? "checked" : ""} />
                  <label for="hasRecurrence" style="margin:0;font-size:12px;font-weight:650;">Recurring event</label>
                </div>
                <div class="note">Weekly/monthly rule or custom dates list.</div>

                <div class="rec-grid" style="margin-top:12px;">
                  <div>
                    <label style="margin-top:0;">First date (series starts)</label>
                    <input class="ctrl" type="date" name="recurrenceStartDate" value="${esc(recurrenceStartDateVal)}" />
                    <div class="note">First occurrence date for this series.</div>
                  </div>

                  <div>
                    <label style="margin-top:0;">Until date (series ends)</label>
                    <input class="ctrl" type="date" name="recurrenceUntilDate" value="${esc(recurrenceUntilDateVal)}" />
                    <div class="note">No occurrences after this date.</div>
                  </div>
                </div>

                <div class="rec-grid" style="margin-top:12px;">
                  <div>
                    <div class="rec-label">Recurrence Type</div>
                    <select id="recurrenceType" name="recurrenceType" class="ctrl">
                      <option value="none" ${ruleType === "none" ? "selected" : ""}>None</option>
                      <option value="weekly" ${ruleType === "weekly" ? "selected" : ""}>Weekly</option>
                      <option value="monthly" ${ruleType === "monthly" ? "selected" : ""}>Monthly</option>
                      <option value="custom" ${ruleType === "custom" ? "selected" : ""}>Custom Dates</option>
                    </select>
                  </div>

                  <div id="intervalRow">
                    <div class="rec-label">Interval</div>
                    <input class="ctrl" type="number" min="1" name="recurrenceInterval" value="${esc(recurrenceInterval)}" />
                    <div class="rec-help">Example: every 1 week, every 2 weeks, every 1 month, etc.</div>
                  </div>
                </div>

                <div id="weeklyBox" style="margin-top:14px;">
                  <div class="rec-label">Days of Week</div>
                  <div class="dow">
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="SU" ${isChecked(weeklyByDay, "SU")} />Sun</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="MO" ${isChecked(weeklyByDay, "MO")} />Mon</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="TU" ${isChecked(weeklyByDay, "TU")} />Tue</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="WE" ${isChecked(weeklyByDay, "WE")} />Wed</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="TH" ${isChecked(weeklyByDay, "TH")} />Thu</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="FR" ${isChecked(weeklyByDay, "FR")} />Fri</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="SA" ${isChecked(weeklyByDay, "SA")} />Sat</label>
                  </div>
                  <div class="rec-help">Pick one or more days.</div>
                </div>

                <div id="monthlyBox" style="margin-top:14px;">
                  <div class="rec-grid">
                    <div>
                      <div class="rec-label">Monthly Mode</div>
                      <select id="monthlyMode" name="monthlyMode" class="ctrl">
                        <option value="monthday" ${monthlyMode === "monthday" ? "selected" : ""}>On day of month</option>
                        <option value="nthweekday" ${monthlyMode === "nthweekday" ? "selected" : ""}>On nth weekday</option>
                      </select>
                    </div>
                    <div></div>
                  </div>

                  <div id="monthdayBox" style="margin-top:12px;">
                    <div class="rec-label">Day of Month (1–31)</div>
                    <input class="ctrl" type="number" min="1" max="31" name="byMonthday" value="${esc(byMonthday)}" />
                  </div>

                  <div id="nthweekdayBox" style="margin-top:12px;">
                    <div class="rec-grid">
                      <div>
                        <div class="rec-label">Which Week</div>
                        <select name="setPos" class="ctrl">
                          <option value="1" ${setPos === "1" ? "selected" : ""}>1st</option>
                          <option value="2" ${setPos === "2" ? "selected" : ""}>2nd</option>
                          <option value="3" ${setPos === "3" ? "selected" : ""}>3rd</option>
                          <option value="4" ${setPos === "4" ? "selected" : ""}>4th</option>
                          <option value="-1" ${setPos === "-1" ? "selected" : ""}>Last</option>
                        </select>
                      </div>
                      <div>
                        <div class="rec-label">Weekday</div>
                        <select name="monthlyByDay" class="ctrl">
                          <option value="SU" ${monthlyByDay === "SU" ? "selected" : ""}>Sunday</option>
                          <option value="MO" ${monthlyByDay === "MO" ? "selected" : ""}>Monday</option>
                          <option value="TU" ${monthlyByDay === "TU" ? "selected" : ""}>Tuesday</option>
                          <option value="WE" ${monthlyByDay === "WE" ? "selected" : ""}>Wednesday</option>
                          <option value="TH" ${monthlyByDay === "TH" ? "selected" : ""}>Thursday</option>
                          <option value="FR" ${monthlyByDay === "FR" ? "selected" : ""}>Friday</option>
                          <option value="SA" ${monthlyByDay === "SA" ? "selected" : ""}>Saturday</option>
                        </select>
                      </div>
                    </div>
                  </div>
                </div>

                <div id="customBox" style="margin-top:14px;">
                  <div class="rec-label">Custom Dates</div>
                  <div class="rec-help">Add specific dates and set start/end time for each date.</div>

                  <div id="customDatesWrap" class="chips" style="margin-top:10px;">
                    ${
                      (customDates || [])
                        .map((row) => {
                          const startIso = String(row?.start || "").trim();
                          const endIso   = String(row?.end || "").trim();

                          const dateVal  = startIso ? startIso.slice(0, 10) : "";
                          const startVal = startIso ? startIso.slice(11, 16) : "";
                          const endVal   = endIso ? endIso.slice(11, 16) : "";

                          return `
                            <span class="chip">
                              <input class="ctrl" style="width:160px; padding:8px 10px;" type="date" name="customDate" value="${esc(dateVal)}" />
                              <input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customStart" value="${esc(startVal)}" />
                              <input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customEnd" value="${esc(endVal)}" />
                              <button type="button" data-remove-date="1" aria-label="Remove">×</button>
                            </span>
                          `;
                        })
                        .join("")
                    }
                  </div>

                  <input type="hidden" name="recurrenceDatesJson" id="recurrenceDatesJson" value="" />

                  <div class="actions" style="margin-top:10px;">
                    <button id="addCustomDate" type="button" class="btn">+ Add Date</button>
                  </div>
                </div>
              </div>

              <label>Flyer Image (Upload)</label>
              <input id="imageFileInput" class="ctrl" type="file" name="imageFile" accept="image/*" />
              <div class="note">Uploading replaces the Image URL below.</div>

              <img id="uploadPreview" style="margin-top:10px; width:160px; height:160px; object-fit:cover; border-radius:var(--radius); border:1px solid var(--line); display:none;" alt="Flyer upload preview" />

              <label style="margin-top:12px;">Image URL (optional fallback)</label>
              <input class="ctrl" name="imageUrl" value="${esc(editEvent?.imageUrl || "")}" placeholder="https://..." />

              ${
                editEvent?.imageUrl
                  ? `
                    <div class="note">Current: <a href="${esc(editEvent.imageUrl)}" target="_blank" rel="noopener">View image</a></div>
                    <div style="margin-top:10px;">
                      <img id="existingPreview" src="${esc(editEvent.imageUrl)}"
                        style="width:160px; height:160px; object-fit:cover; border-radius:var(--radius); border:1px solid var(--line);"
                        alt="Current flyer preview" onerror="this.style.display='none';" />
                    </div>
                  `
                  : ""
              }

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Ticket Button Text</label>
                  <input class="ctrl" name="ticketLabel" value="${esc(editEvent?.ticketLabel || "Tickets")}" placeholder="Tickets / Reserve / Buy Tickets..." />
                </div>
                <div>
                  <label style="margin-top:0;">Ticket Link (URL)</label>
                  <input class="ctrl" name="ticketUrl" value="${esc(editEvent?.ticketUrl || "")}" placeholder="https://..." />
                  <div class="note">If provided, a ticket button will show on the event page.</div>
                </div>
              </div>

              <label>Location</label>
              <input class="ctrl" name="location" value="${esc(editEvent?.location || "")}" required />

              <label>Organizer</label>
              <input class="ctrl" name="organizer" value="${esc(editEvent?.organizer || "")}" required />

              <div class="actions">
                <button type="submit" class="btn btn-primary">${editEvent ? "Update Event" : "Save Event"}</button>
                ${editEvent ? `<a class="btn btn-link" href="/admin?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${archivedMode ? `&archived=${encodeURIComponent(archivedMode)}` : ""}">Cancel</a>` : ""}
                <span class="note">Dates are saved with your server's local timezone offset automatically.</span>
              </div>
            </form>
          </div>

          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Existing events</h2>
                <p class="sub">Edit, delete, and check stats</p>
              </div>
              <div class="right">
                <div class="rightRow">
                  <a class="btn ${archivedMode === "0" ? "btn-primary" : ""}" href="/admin?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}&sort=${encodeURIComponent(sort)}&archived=0">Active</a>
                  <a class="btn ${archivedMode === "1" ? "btn-primary" : ""}" href="/admin?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}&sort=${encodeURIComponent(sort)}&archived=1">Archived</a>
                  <a class="btn ${archivedMode === "all" ? "btn-primary" : ""}" href="/admin?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}&sort=${encodeURIComponent(sort)}&archived=all">All</a>

                  <select id="sortBy" class="ctrl sortBy">
                    <option value="datetime" ${sort === "datetime" ? "selected" : ""}>Sort: Event date/time</option>
                    <option value="alpha" ${sort === "alpha" ? "selected" : ""}>Sort: Alphabetical (A–Z)</option>
                    <option value="recent" ${sort === "recent" ? "selected" : ""}>Sort: Recently added</option>
                    <option value="id" ${sort === "id" ? "selected" : ""}>Sort: ID (newest)</option>
                  </select></div>
              </div>
            </div>

            <div class="listSearchRow">
              <input id="eventSearch" class="ctrl" type="text" placeholder="Instant filter on this page..." />
              <button id="eventSearchClear" type="button" class="btn">Clear</button>
            </div>

            ${pagerHtml}

            <div id="eventsList" style="display:grid; gap:var(--gap);">${listHtml}</div>
            <div id="eventsEmpty" class="muted" style="display:none; margin-top:10px;">No matching events.</div>

          </div>
        </section>

      </main>
    </div>

    <script>
      // ---- helpers ----
      // ---- sort dropdown (server-side) ----
      (function(){
        var sel = document.getElementById("sortBy");
        if (!sel) return;
        sel.addEventListener("change", function(){
          var sp = new URLSearchParams(window.location.search || "");
          sp.set("sort", sel.value);
          sp.set("pg", "1");
          window.location.href = "/admin?" + sp.toString();
        });
      })();


      function toISOWithOffsetFromLocalInput(dtLocal) {
        var d = new Date(dtLocal);
        if (isNaN(d.getTime())) return "";
        function pad(n){ return String(n).padStart(2, "0"); }
        var y = d.getFullYear();
        var m = pad(d.getMonth() + 1);
        var day = pad(d.getDate());
        var hh = pad(d.getHours());
        var mm = pad(d.getMinutes());
        var ss = "00";
        var offsetMin = -d.getTimezoneOffset();
        var sign = offsetMin >= 0 ? "+" : "-";
        var abs = Math.abs(offsetMin);
        var offH = pad(Math.floor(abs / 60));
        var offM = pad(abs % 60);
        return y + "-" + m + "-" + day + "T" + hh + ":" + mm + ":" + ss + sign + offH + ":" + offM;
      }

      // ---- Date ISO fields on submit + custom recurrence serialization ----
      (function(){
        var form = document.querySelector('form[action="/admin/events"]');
        if(!form) return;

        form.addEventListener("submit", function(){
          var startLocal = (document.getElementById("startDateTime") || {}).value || "";
          var endLocal   = (document.getElementById("endDateTime") || {}).value || "";

          var startISO = toISOWithOffsetFromLocalInput(startLocal);
          var endISO   = toISOWithOffsetFromLocalInput(endLocal);

          var startHidden = document.getElementById("startDateTimeISO");
          var endHidden   = document.getElementById("endDateTimeISO");
          if(startHidden) startHidden.value = startISO;
          if(endHidden) endHidden.value = endISO;

          var recHidden = document.getElementById("recurrenceDatesJson");
          var hasRec = !!((document.getElementById("hasRecurrence") || {}).checked);
          var recType = String(((document.getElementById("recurrenceType") || {}).value) || "").toLowerCase();

          if (recHidden) {
            if (hasRec && recType === "custom") {
              var wrap = document.getElementById("customDatesWrap");
              var chips = wrap ? wrap.querySelectorAll(".chip") : [];
              var fallbackStart = (startLocal && startLocal.length >= 16) ? startLocal.slice(11,16) : "00:00";
              var fallbackEnd = (endLocal && endLocal.length >= 16) ? endLocal.slice(11,16) : fallbackStart;

              var items = [];
              for (var i=0;i<chips.length;i++){
                var chip = chips[i];
                var date = (chip.querySelector('input[name="customDate"]') || {}).value || "";
                if (!date) continue;
                var st = (chip.querySelector('input[name="customStart"]') || {}).value || "";
                var en = (chip.querySelector('input[name="customEnd"]') || {}).value || "";
                var sIso = toISOWithOffsetFromLocalInput(date + "T" + (st || fallbackStart));
                var eIso = toISOWithOffsetFromLocalInput(date + "T" + (en || fallbackEnd));
                if (!sIso || !eIso) continue;
                items.push({ date: date, start: sIso, end: eIso });
              }
              recHidden.value = JSON.stringify(items);
            } else {
              recHidden.value = "";
            }
          }
        });
      })();

      // Auto-set End = Start + 2 hours (only if end is empty)
      (function(){
        var startEl = document.getElementById("startDateTime");
        var endEl = document.getElementById("endDateTime");
        if (!startEl || !endEl) return;

        function pad(n){ return String(n).padStart(2, "0"); }

        startEl.addEventListener("change", function(){
          if (!startEl.value) return;
          if (!endEl.value) {
            var d = new Date(startEl.value);
            if (isNaN(d.getTime())) return;
            d.setHours(d.getHours() + 2);
            endEl.value =
              d.getFullYear() + "-" +
              pad(d.getMonth() + 1) + "-" +
              pad(d.getDate()) + "T" +
              pad(d.getHours()) + ":" +
              pad(d.getMinutes());
          }
        });
      })();

      // Upload preview
      (function () {
        var fileInput = document.getElementById("imageFileInput");
        var preview = document.getElementById("uploadPreview");
        if (!fileInput || !preview) return;

        fileInput.addEventListener("change", function () {
          var f = fileInput.files && fileInput.files[0];
          if (!f) {
            preview.style.display = "none";
            preview.src = "";
            return;
          }
          preview.src = URL.createObjectURL(f);
          preview.style.display = "block";
        });
      })();

      // Instant filter (page-only)
      (function(){
        var input = document.getElementById('eventSearch');
        var clearBtn = document.getElementById('eventSearchClear');
        if(!input) return;

        function normalize(s){ return String(s || '').toLowerCase(); }

        function applyFilter(){
          var q = normalize(input.value).trim();
          var cards = document.querySelectorAll('.event-card[data-eid]');
          var shown = 0;

          for(var i=0;i<cards.length;i++){
            var card = cards[i];
            var hay = normalize(card.textContent);
            var ok = !q || hay.indexOf(q) !== -1;
            card.style.display = ok ? '' : 'none';
            if(ok) shown++;
          }

          var empty = document.getElementById('eventsEmpty');
          if(empty) empty.style.display = shown ? 'none' : '';
        }

        input.addEventListener('input', applyFilter);
        if(clearBtn){
          clearBtn.addEventListener('click', function(){
            input.value = '';
            applyFilter();
            input.focus();
          });
        }
        applyFilter();
      })();

      // Recurrence UI show/hide + custom chips
      (function(){
        var hasRecEl = document.getElementById("hasRecurrence");
        var typeEl = document.getElementById("recurrenceType");
        var intervalRow = document.getElementById("intervalRow");
        var weeklyBox = document.getElementById("weeklyBox");
        var monthlyBox = document.getElementById("monthlyBox");
        var customBox = document.getElementById("customBox");

        var monthlyModeEl = document.getElementById("monthlyMode");
        var monthdayBox = document.getElementById("monthdayBox");
        var nthweekdayBox = document.getElementById("nthweekdayBox");

        function show(el, on){
          if(!el) return;
          el.style.display = on ? "" : "none";
        }

        function sync(){
          var enabled = !!(hasRecEl && hasRecEl.checked);
          var t = typeEl ? String(typeEl.value || "none") : "none";

          if(!enabled){
            show(intervalRow, false);
            show(weeklyBox, false);
            show(monthlyBox, false);
            show(customBox, false);
            return;
          }

          show(intervalRow, true);
          show(weeklyBox, t === "weekly");
          show(monthlyBox, t === "monthly");
          show(customBox, t === "custom");

          if(t === "monthly"){
            var mm = monthlyModeEl ? String(monthlyModeEl.value || "monthday") : "monthday";
            show(monthdayBox, mm === "monthday");
            show(nthweekdayBox, mm === "nthweekday");
          } else {
            show(monthdayBox, false);
            show(nthweekdayBox, false);
          }
        }

        if(hasRecEl) hasRecEl.addEventListener("change", sync);
        if(typeEl) typeEl.addEventListener("change", sync);
        if(monthlyModeEl) monthlyModeEl.addEventListener("change", sync);
        sync();

        // Custom date chips
        var addBtn = document.getElementById("addCustomDate");
        var wrap = document.getElementById("customDatesWrap");

        function attachRemove(){
          if(!wrap) return;
          var btns = wrap.querySelectorAll("button[data-remove-date]");
          for(var i=0;i<btns.length;i++){
            btns[i].onclick = function(){
              var chip = this.closest(".chip");
              if(chip) chip.remove();
            };
          }
        }
        attachRemove();

        if(addBtn && wrap){
          addBtn.addEventListener("click", function(){
            var chip = document.createElement("span");
            chip.className = "chip";

            var startLocal = (document.getElementById("startDateTime") && document.getElementById("startDateTime").value) ? document.getElementById("startDateTime").value : "";
            var endLocal   = (document.getElementById("endDateTime") && document.getElementById("endDateTime").value) ? document.getElementById("endDateTime").value : "";
            var startTime = startLocal && startLocal.length >= 16 ? startLocal.slice(11,16) : "";
            var endTime   = endLocal && endLocal.length >= 16 ? endLocal.slice(11,16) : startTime;

            chip.innerHTML =
              '<input class="ctrl" style="width:160px; padding:8px 10px;" type="date" name="customDate" value="" />' +
              '<input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customStart" value="" />' +
              '<input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customEnd" value="" />' +
              '<button type="button" data-remove-date="1" aria-label="Remove">×</button>';

            wrap.appendChild(chip);

            var st = chip.querySelector('input[name="customStart"]');
            var en = chip.querySelector('input[name="customEnd"]');
            if(st && startTime) st.value = startTime;
            if(en && endTime) en.value = endTime;

            attachRemove();
          });
        }
      })();

      // Live going/interested/views refresh (safe)
      (function(){
        async function refreshOne(card){
          var id = card.getAttribute("data-eid");
          if(!id) return;

          try{
            var res = await fetch("/events/" + encodeURIComponent(id), { headers: { "Accept": "application/json" } });
            if(!res.ok) return;
            var json = await res.json();
            var e = (json && json.data) ? json.data : json;

            var v = card.querySelector(".js-views");
            var u = card.querySelector(".js-unique");
            var g = card.querySelector(".js-going");
            var i = card.querySelector(".js-interested");

            if(v && typeof e.viewCount !== "undefined") v.textContent = String(Number(e.viewCount || 0));
            if(u && typeof e.uniqueViewCount !== "undefined") u.textContent = String(Number(e.uniqueViewCount || 0));
            if(g && typeof e.goingCount !== "undefined") g.textContent = String(Number(e.goingCount || 0));
            if(i && typeof e.interestedCount !== "undefined") i.textContent = String(Number(e.interestedCount || 0));
          }catch(_){}
        }

        function tick(){
          var cards = document.querySelectorAll(".event-card[data-eid]");
          for(var j=0;j<cards.length;j++){
            refreshOne(cards[j]);
          }
        }
        tick();
        setInterval(tick, 4000);
      })();

      // Simple bar chart (no libraries) + hover tooltip + view toggles
(function(){
  function initEventsChart(){
    const chartSets = ${chartDataJson};
    const $canvas = document.getElementById("eventsChart");
    const $wrap   = document.getElementById("eventsChartWrap");
    const $tip    = document.getElementById("eventsChartTip");
    const $seg    = document.getElementById("chartViewSeg");
    const $range  = document.getElementById("chartRangeLabel");

    if (!$canvas || !$wrap) return;
    const ctx = $canvas.getContext("2d");
    if (!ctx) return;

    let mode = "daily";
    let hoverIndex = -1;
    let resizeRetry = 0;

  function setActiveBtn(){
    if (!$seg) return;
    $seg.querySelectorAll("[data-view]").forEach((b) => {
      const on = (b.getAttribute("data-view") === mode);
      b.classList.toggle("on", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
    });
  }

  function setRangeLabel(){
    if (!$range) return;
    const map = {
      daily:  "Last 14 days (by start date)",
      weekly: "Last 12 weeks (by start date)",
      monthly:"Last 12 months (by start date)",
      yearly: "Last 5 years (by start date)",
    };
    $range.textContent = map[mode] || map.daily;
  }

  function sizeCanvas(){
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    // Some layouts briefly report 0 widths while CSS loads; fall back to bounding boxes.
    let w = $wrap.clientWidth;
    if (!w || w < 10) w = Math.floor($wrap.getBoundingClientRect().width || 0);
    if (!w || w < 10) w = Math.floor(($canvas.parentElement ? $canvas.parentElement.getBoundingClientRect().width : 0) || 0);
    w = Math.max(320, w);

    let h = $wrap.clientHeight;
    if (!h || h < 10) h = Math.floor($wrap.getBoundingClientRect().height || 0);
    h = Math.max(260, h || 360);

    $canvas.style.width  = w + "px";
    $canvas.style.height = h + "px";
    $canvas.width  = Math.floor(w * dpr);
    $canvas.height = Math.floor(h * dpr);

    ctx.setTransform(dpr,0,0,dpr,0,0); // draw in CSS pixels
    return { w, h, ready: (w > 0 && h > 0) };
  }

  function draw(){
    const set = chartSets[mode] || chartSets.daily;
    const labels = (set && set.labels) ? set.labels : [];
    const values = (set && set.values) ? set.values : [];

    const { w, h, ready } = sizeCanvas();
    if (!ready) {
      window.requestAnimationFrame(draw);
      return;
    }
    ctx.clearRect(0,0,w,h);

    if (!labels.length || !values.length){
      ctx.fillStyle = "rgba(15,23,42,.75)";
      ctx.font = "600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.fillText("No recent events", 18, 90);
      return;
    }

    const padL = 56, padR = 18, padT = 18, padB = 46;
    const gw = w - padL - padR;
    const gh = h - padT - padB;

    const maxV = Math.max(1, ...values);
    const yTicks = Math.min(6, maxV);
    const tickStep = Math.max(1, Math.ceil(maxV / yTicks));
    const yMax = tickStep * yTicks;

    // grid + y labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(15,23,42,.12)";
    ctx.fillStyle = "rgba(15,23,42,.92)";
    ctx.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

    for (let i=0;i<=yTicks;i++){
      const v = i * tickStep;
      const y = padT + gh - (v / yMax) * gh;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL+gw, y); ctx.stroke();
      ctx.fillText(String(v), 18, y+4);
    }

    // x labels + bars
    const n = values.length;
    const gap = 16;
    const barW = Math.max(10, Math.floor((gw - gap*(n-1)) / n));
    const totalW = barW*n + gap*(n-1);
    const x0 = padL + Math.max(0, (gw-totalW)/2);

    // x label style
    ctx.fillStyle = "rgba(15,23,42,.92)";
    ctx.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

    for (let i=0;i<n;i++){
      const v = values[i];
      const bh = (v / yMax) * gh;
      const x = x0 + i*(barW+gap);
      const y = padT + gh - bh;

      // bar
      ctx.fillStyle = "rgba(16,185,129,.45)";
      ctx.fillRect(x, y, barW, bh);

      // hover outline
      if (i === hoverIndex){
        ctx.strokeStyle = "rgba(16,185,129,.95)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x+0.5, y+0.5, barW-1, bh-1);
        ctx.lineWidth = 1;
      }

      // label
      const lab = labels[i] || "";
      ctx.save();
      ctx.translate(x + barW/2, padT + gh + 22);
      ctx.rotate(-0.35);
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(15,23,42,.92)";
      ctx.fillText(lab, 0, 0);
      ctx.restore();
    }
  }

  function getBarIndexFromEvent(ev){
    const set = chartSets[mode] || chartSets.daily;
    const values = (set && set.values) ? set.values : [];
    if (!values.length) return -1;

    const rect = $canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;

    const padL = 56, padR = 18, padT = 18, padB = 46;
    const gw = rect.width - padL - padR;
    const gh = rect.height - padT - padB;

    if (mx < padL || mx > padL+gw || my < padT || my > padT+gh) return -1;

    const n = values.length;
    const gap = 16;
    const barW = Math.max(10, Math.floor((gw - gap*(n-1)) / n));
    const totalW = barW*n + gap*(n-1);
    const x0 = padL + Math.max(0, (gw-totalW)/2);

    for (let i=0;i<n;i++){
      const x = x0 + i*(barW+gap);
      if (mx >= x && mx <= x+barW) return i;
    }
    return -1;
  }

  function showTip(ev, idx){
    if (!$tip) return;
    const set = chartSets[mode] || chartSets.daily;
    const labels = (set && set.labels) ? set.labels : [];
    const values = (set && set.values) ? set.values : [];

    const rect = $canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    const value = values[idx] ?? 0;

    $tip.textContent = String(value) + " event" + (value === 1 ? "" : "s");
    $tip.style.display = "block";

    const tipRect = $tip.getBoundingClientRect();
    const left = Math.min(rect.left + rect.width - tipRect.width - 10, rect.left + x + 12);
    const top  = Math.max(rect.top + 10, rect.top + y - 32);

    $tip.style.left = (left - rect.left) + "px";
    $tip.style.top  = (top - rect.top) + "px";
  }

  function hideTip(){
    if ($tip) $tip.style.display = "none";
  }

  // Bind toggle
  if ($seg){
    $seg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-view]");
      if (!btn) return;
      mode = btn.getAttribute("data-view") || "daily";
      hoverIndex = -1;
      hideTip();
      setActiveBtn();
      setRangeLabel();
      draw();
    });
  }

  // Hover tooltip
  $canvas.addEventListener("mousemove", (e) => {
    const idx = getBarIndexFromEvent(e);
    if (idx !== hoverIndex){
      hoverIndex = idx;
      draw();
    }
    if (idx >= 0) showTip(e, idx); else hideTip();
  });
  $canvas.addEventListener("mouseleave", () => {
    hoverIndex = -1;
    hideTip();
    draw();
  });

  // Initial paint / resize
  function init(){
    setActiveBtn();
    setRangeLabel();
    draw();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.addEventListener("resize", () => window.requestAnimationFrame(draw));
}

  initEventsChart();
})();</script>
  </body>
</html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
});

// POST /admin/events (create or update)
router.post("/events", upload.single("imageFile"), async (req, res) => {
  try {
    let {
      id,
      city = "Enumclaw",
      title,
      description,
      eventDetails,
      goodToKnow,
      startDateTime,
      endDateTime,
      location,
      organizer,
      imageUrl,
      ticketUrl,
      ticketLabel,
      categories,
      featured,

      hasRecurrence,
      recurrenceType,
      recurrenceInterval,
      weeklyByDay,
      monthlyMode,
      byMonthday,
      setPos,
      monthlyByDay,

      recurrenceStartDate,
      recurrenceUntilDate,

      // legacy/simple custom dates
      recurrenceDates,
    } = req.body;

    // If a file was uploaded, prefer it over the URL field
    if (req.file && req.file.filename) {
      const proto = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["x-forwarded-host"] || req.get("host");
      imageUrl = `${proto}://${host}/uploads/${req.file.filename}`;
    }

    // Prefer browser-generated ISO with offset (prevents UTC shift)
    const startISO = (req.body.startDateTimeISO || "").trim();
    const endISO = (req.body.endDateTimeISO || "").trim();

    if (startISO && endISO) {
      startDateTime = startISO;
      endDateTime = endISO;
    } else {
      startDateTime = toLocalISOWithOffset(startDateTime);
      endDateTime = toLocalISOWithOffset(endDateTime);
    }

    // Validate required fields
    if (!title || !description || !startDateTime || !endDateTime || !location || !organizer) {
      return res.status(400).send("Missing required fields.");
    }

    if (ticketUrl && !/^https?:\/\//i.test(ticketUrl)) {
      return res.status(400).send("Ticket link must start with http:// or https://");
    }

    const finalTicketLabel =
      ticketLabel && String(ticketLabel).trim() ? String(ticketLabel).trim() : "Tickets";

    const startMs = Date.parse(startDateTime);
    const endMs = Date.parse(endDateTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return res.status(400).send("Invalid date/time.");
    }
    if (endMs <= startMs) {
      return res.status(400).send("End time must be after start time.");
    }

    const featuredFlag = String(featured || "") === "1" ? 1 : 0;

    // Slug
    const baseSlug = slugify(title);
    const slug = await ensureUniqueSlug(baseSlug, id ? Number(id) : null);

    // Categories (max 3, from allow-list)
    const cats = normalizeCategories(categories);
    const catsJson = JSON.stringify(cats);

    // ---- Recurrence normalize ----
    const hasRec = String(hasRecurrence || "") === "1" ? 1 : 0;
    const t = String(recurrenceType || "none").toLowerCase();

    let recurrenceRule = null;
    let recurrenceDatesJson = null;

    if (hasRec && t !== "none") {
      if (t === "custom") {
        // Prefer the hidden JSON emitted by the admin UI (keeps per-date start/end)
        let raw = safeParseJson((req.body.recurrenceDatesJson || "").trim(), []);
        if (!Array.isArray(raw)) raw = [];

        // Back-compat: if hidden JSON missing, build from the visible fields
        if (raw.length === 0) {
          const dates  = Array.isArray(req.body.customDate)  ? req.body.customDate  : (req.body.customDate  ? [req.body.customDate]  : []);
          const starts = Array.isArray(req.body.customStart) ? req.body.customStart : (req.body.customStart ? [req.body.customStart] : []);
          const ends   = Array.isArray(req.body.customEnd)   ? req.body.customEnd   : (req.body.customEnd   ? [req.body.customEnd]   : []);

          const baseStartTime = String(startDateTime || "").slice(11,16) || "00:00";
          const baseEndTime   = String(endDateTime || "").slice(11,16) || baseStartTime;

          for (let i = 0; i < dates.length; i++) {
            const date = String(dates[i] || "").trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            const st = String(starts[i] || "").trim();
            const en = String(ends[i] || "").trim();

            // NOTE: this is a fallback; the UI should normally submit full ISO strings.
            const startIso = toLocalISOWithOffset(`${date}T${st || baseStartTime}`);
            const endIso   = toLocalISOWithOffset(`${date}T${en || baseEndTime}`);

            raw.push({ date, start: startIso, end: endIso });
          }
        }

        // Legacy: accept recurrenceDates (date-only array)
        if (raw.length === 0) {
          let arr = [];
          if (Array.isArray(recurrenceDates)) arr = recurrenceDates;
          else if (typeof recurrenceDates === "string" && recurrenceDates.trim() !== "") arr = [recurrenceDates];
          raw = arr;
        }

        const uniqDates = [];
        const items = [];

        for (const it of raw) {
          // Date-only string
          if (typeof it === "string") {
            const date = String(it || "").trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            if (!uniqDates.includes(date)) uniqDates.push(date);

            // Create an item using the base times so the admin UI can round-trip
            if (String(startDateTime || "").length >= 16 && String(endDateTime || "").length >= 16) {
              items.push({
                date,
                start: date + String(startDateTime).slice(10),
                end: date + String(endDateTime).slice(10),
              });
            }
            continue;
          }

          // Object with start/end
          if (it && typeof it === "object") {
            const s = String(it.start || "").trim();
            const e = String(it.end || "").trim();
            let date = String(it.date || "").trim();
            if (!date && s.length >= 10) date = s.slice(0,10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

            if (!uniqDates.includes(date)) uniqDates.push(date);
            if (s && e) items.push({ date, start: s, end: e });
          }
        }

        uniqDates.sort();
        items.sort((a,b) => String(a.start||"").localeCompare(String(b.start||"")));

        recurrenceRule = items.length ? { type: "custom", items } : { type: "custom" };
        recurrenceDatesJson = JSON.stringify(uniqDates);
      }

      if (t === "weekly") {
        let days = [];
        if (Array.isArray(weeklyByDay)) days = weeklyByDay;
        else if (typeof weeklyByDay === "string" && weeklyByDay.trim() !== "") days = [weeklyByDay];

        const allowed = new Set(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
        const uniq = [];
        for (const d of days.map((x) => String(x).trim()).filter(Boolean)) {
          if (!allowed.has(d)) continue;
          if (!uniq.includes(d)) uniq.push(d);
        }

        const interval = Math.max(1, parseInt(recurrenceInterval || "1", 10) || 1);
        recurrenceRule = { type: "weekly", interval, byDay: uniq };
      }

      if (t === "monthly") {
        const interval = Math.max(1, parseInt(recurrenceInterval || "1", 10) || 1);
        const mode = String(monthlyMode || "monthday");

        if (mode === "nthweekday") {
          const sp = parseInt(setPos || "1", 10);
          const wd = String(monthlyByDay || "").trim() || "MO";
          recurrenceRule = { type: "monthly", interval, mode: "nthweekday", setPos: sp, byDay: wd };
        } else {
          const md = Math.max(1, Math.min(31, parseInt(byMonthday || "0", 10) || 0));
          recurrenceRule = { type: "monthly", interval, mode: "monthday", byMonthday: md };
        }
      }
    }

    const recurrenceRuleJson = recurrenceRule ? JSON.stringify(recurrenceRule) : null;

    const cols = await getEventsColumns();

    const normYmd = (v) => {
      const s = String(v || "").trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    };

    const recurrenceStartDateClean = normYmd(recurrenceStartDate);
    const recurrenceUntilDateClean = normYmd(recurrenceUntilDate);

    // ---- Build fields ----
    const baseFields = [
      ["city", city],
      ["slug", slug],
      ["title", title],
      ["description", description],
      ["eventDetails", eventDetails || ""],
      ["goodToKnow", goodToKnow || ""],
      ["startDateTime", startDateTime],
      ["endDateTime", endDateTime],
      ["location", location],
      ["organizer", organizer],
      ["imageUrl", imageUrl || null],
      ["ticketUrl", ticketUrl || null],
      ["ticketLabel", finalTicketLabel],
      ["categories", catsJson],
      ["featured", featuredFlag],
    ];

    const recFields = [
      ["hasRecurrence", hasRec],
      ["recurrenceRule", recurrenceRuleJson],
      ["recurrenceDates", recurrenceDatesJson],
      ["recurrenceStartDate", recurrenceStartDateClean],
      ["recurrenceUntilDate", recurrenceUntilDateClean],
    ];

    const fields = [...baseFields];

    // Only include recurrence columns if they exist in DB
    const hasRecCols =
      cols.has("hasRecurrence") &&
      cols.has("recurrenceRule") &&
      cols.has("recurrenceDates") &&
      cols.has("recurrenceStartDate") &&
      cols.has("recurrenceUntilDate");

    if (hasRecCols) fields.push(...recFields);

    const isUpdate = id !== undefined && id !== null && String(id).trim() !== "";

    if (isUpdate) {
      const sets = [];
      const vals = [];
      for (const [k, v] of fields) {
        if (!cols.size || cols.has(k)) {
          sets.push(`${k}=?`);
          vals.push(v);
        }
      }
      vals.push(Number(id));

await run(`UPDATE events SET ${sets.join(", ")} WHERE id=?`, vals);

// preserve list state (pg/limit/q) if present
const pg = req.query.pg ? String(req.query.pg) : "1";
const limit = req.query.limit ? String(req.query.limit) : "20";
const q = req.query.q ? String(req.query.q) : "";

const archived = req.query.archived ? String(req.query.archived) : "0";

const sp = new URLSearchParams({ edit: String(id), pg, limit, archived });
if (q) sp.set("q", q);

return res.redirect(`/admin?${sp.toString()}`);

    } else {
      const insertCols = [];
      const placeholders = [];
      const insertVals = [];

      for (const [k, v] of fields) {
        if (!cols.size || cols.has(k)) {
          insertCols.push(k);
          placeholders.push("?");
          insertVals.push(v);
        }
      }

await run(
  `INSERT INTO events (${insertCols.join(", ")}) VALUES (${placeholders.join(", ")})`,
  insertVals
);

const pg = req.query.pg ? String(req.query.pg) : "1";
const limit = req.query.limit ? String(req.query.limit) : "20";
const q = req.query.q ? String(req.query.q) : "";

const archived = req.query.archived ? String(req.query.archived) : "0";

const sp = new URLSearchParams({ pg, limit, archived });
if (q) sp.set("q", q);

return res.redirect(`/admin?${sp.toString()}`);

    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error.");
  }
});

router.post("/events/:id/delete", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    await run("DELETE FROM events WHERE id = ?", [id]);

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const archived = req.query.archived ? String(req.query.archived) : "0";
    const sort = req.query.sort ? String(req.query.sort) : "datetime";

    const sp = new URLSearchParams({ pg, limit, archived, sort });
    if (q) sp.set("q", q);

    return res.redirect(`/admin?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

// Soft-archive (best practice) — works with either (archived, archived_at, archived_reason)
// or legacy (isArchived, archivedAt) columns depending on what's present.
router.post("/events/:id/archive", async (req, res) => {
  try {
    await ensureArchiveSchema();

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    const cols = await getEventsColumns();

    const colArchived = cols.has("archived") ? "archived" : (cols.has("isArchived") ? "isArchived" : null);
    const colArchivedAt = cols.has("archived_at") ? "archived_at" : (cols.has("archivedAt") ? "archivedAt" : null);
    const colReason = cols.has("archived_reason") ? "archived_reason" : (cols.has("archivedReason") ? "archivedReason" : null);

    const sets = [];
    const params = [];

    if (colArchived) sets.push(`${colArchived} = 1`);
    if (colArchivedAt) sets.push(`${colArchivedAt} = datetime('now')`);
    if (colReason) { sets.push(`${colReason} = ?`); params.push("manual"); }

    if (sets.length === 0) return res.status(400).send("Archive not supported by schema.");

    await run(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const archived = req.query.archived ? String(req.query.archived) : "0";
    const sort = req.query.sort ? String(req.query.sort) : "datetime";

    const sp = new URLSearchParams({ pg, limit, archived, sort });
    if (q) sp.set("q", q);

    return res.redirect(`/admin?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

router.post("/events/:id/unarchive", async (req, res) => {
  try {
    await ensureArchiveSchema();

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    const cols = await getEventsColumns();

    const colArchived = cols.has("archived") ? "archived" : (cols.has("isArchived") ? "isArchived" : null);
    const colArchivedAt = cols.has("archived_at") ? "archived_at" : (cols.has("archivedAt") ? "archivedAt" : null);
    const colReason = cols.has("archived_reason") ? "archived_reason" : (cols.has("archivedReason") ? "archivedReason" : null);

    const sets = [];
    if (colArchived) sets.push(`${colArchived} = 0`);
    if (colArchivedAt) sets.push(`${colArchivedAt} = NULL`);
    if (colReason) sets.push(`${colReason} = NULL`);

    if (sets.length === 0) return res.status(400).send("Unarchive not supported by schema.");

    await run(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`, [id]);

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const archived = req.query.archived ? String(req.query.archived) : "0";
    const sort = req.query.sort ? String(req.query.sort) : "datetime";

    const sp = new URLSearchParams({ pg, limit, archived, sort });
    if (q) sp.set("q", q);

    return res.redirect(`/admin?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

module.exports = router;
