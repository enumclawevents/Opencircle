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

// GET /admin
router.get("/", async (req, res) => {
  try {
    // ✅ Pagination + total count + optional server-side search
const limit = Math.max(10, Math.min(200, parseInt(req.query.limit || "50", 10)));
const pg = Math.max(1, parseInt(req.query.pg || "1", 10));
const offset = (pg - 1) * limit;

const q = String(req.query.q || "").trim();
let whereSql = "";
let whereParams = [];
if (q) {
  const like = `%${q}%`;
  whereSql = `WHERE (title LIKE ? OR slug LIKE ? OR location LIKE ? OR CAST(id AS TEXT) LIKE ?)`;
  whereParams = [like, like, like, like];
}

const totalRow = await get(`SELECT COUNT(*) AS n FROM events ${whereSql}`, whereParams);
const total = Number(totalRow?.n || 0);
const pages = Math.max(1, Math.ceil(total / limit));
const hasPrev = pg > 1;
const hasNext = pg < pages;

function adminUrl(nextPg) {
  const sp = new URLSearchParams(req.query);
  sp.set("pg", String(nextPg));
  sp.set("limit", String(limit));
  if (q) sp.set("q", q);
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

// ✅ Resilient list query: supports optional columns
let events = [];
try {
  events = await all(
    `SELECT id, slug, title, startDateTime, location, featured,
            goingCount, interestedCount, viewCount, uniqueViewCount, lastViewedAt, imageUrl
     FROM events
     ${whereSql}
     ORDER BY startDateTime DESC
     LIMIT ? OFFSET ?`,
    [...whereParams, limit, offset]
  );
} catch (err) {
  events = await all(
    `SELECT id, slug, title, startDateTime, location, featured
     FROM events
     ${whereSql}
     ORDER BY startDateTime DESC
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
      </div>

      <div class="event-meta">
        <div><strong>Slug:</strong> ${esc(e.slug || "")}</div>
        <div><strong>Start:</strong> ${esc(e.startDateTime)}</div>
        <div><strong>Location:</strong> ${esc(e.location)}</div>
      </div>

      <div class="event-actions">
        <a href="${e.slug ? `/events/slug/${esc(e.slug)}` : `/events/${e.id}`}"
           target="_blank" rel="noopener">View JSON</a>

        <a class="btn btn-edit" href="/admin?edit=${e.id}&pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}">Edit</a>

        <form method="POST"
              action="/admin/events/${e.id}/delete?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}"
              class="inline"
              onsubmit="return confirm('Delete this event permanently? This cannot be undone.');">
          <button type="submit" class="btn btn-danger">Delete</button>
        </form>
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

    // Counts
    const upcomingRow = await get(
      `SELECT COUNT(*) AS n FROM events WHERE datetime(startDateTime) >= datetime('now')`
    );
    const pastRow = await get(
      `SELECT COUNT(*) AS n FROM events WHERE datetime(startDateTime) < datetime('now')`
    );
    const featuredRow = await get(`SELECT COUNT(*) AS n FROM events WHERE featured = 1`);

    const upcoming = Number(upcomingRow?.n || 0);
    const past = Number(pastRow?.n || 0);
    const featuredCount = Number(featuredRow?.n || 0);

    // Optional sums (only if columns exist)
    let viewsSum = 0;
    if (cols.has("viewCount")) {
      const r = await get(`SELECT COALESCE(SUM(viewCount), 0) AS n FROM events`);
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

    // Top locations
    const locRows = await all(
      `SELECT location, COUNT(*) AS n FROM events
       GROUP BY location
       ORDER BY n DESC
       LIMIT 7`
    );

    const topLocationsHtml =
      (locRows || []).length
        ? (locRows || [])
            .map((r) => {
              const name = String(r?.location || "").trim() || "(no location)";
              return `<div class="kv"><span>${esc(name)}</span><strong>${fmt(r?.n || 0)}</strong></div>`;
            })
            .join("")
        : `<div class="muted">No location data yet.</div>`;

    // Chart: events per day (last 14 days)
    const chartRows = await all(
      `SELECT date(startDateTime) AS d, COUNT(*) AS n
       FROM events
       WHERE date(startDateTime) >= date('now','-13 day')
       GROUP BY d
       ORDER BY d`
    );
    const byDay = new Map((chartRows || []).map((r) => [String(r.d), Number(r.n || 0)]));

    const labels = [];
    const values = [];
    for (let i = 13; i >= 0; i--) {
      const dt = new Date();
      dt.setDate(dt.getDate() - i);
      const key = dt.toISOString().slice(0, 10); // YYYY-MM-DD
      labels.push(key.slice(5)); // MM-DD
      values.push(byDay.get(key) || 0);
    }
    const chartDataJson = JSON.stringify({ labels, values });

    res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="/assets/brand/favicon.ico" />
    <title>Dashboard</title>
    <style>
      :root{
        --bg:#0b0f14;
        --panel:#0f172a;
        --panel2:#0b1220;
        --text:#e5e7eb;
        --muted:#94a3b8;
        --line:rgba(148,163,184,.16);
        --brand:#00c08b;
        --brand2:#0ea5e9;
        --danger:#ef4444;
        --shadow:0 18px 40px rgba(0,0,0,.45);
        --radius:8px;
        --radius2:8px;
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
      .rail{
        width:72px; background:var(--panel);
        border-right:1px solid var(--line);
        display:flex; flex-direction:column; align-items:center;
        padding:14px 10px; gap:14px;
        position:sticky; top:0; height:100vh;
      }
      .rail .dot{
        width:42px; height:42px; border-radius: 8px;
        background: rgba(0,192,139,.12);
        border: 1px solid rgba(0,192,139,.22);
        display:flex; align-items:center; justify-content:center;
      }
      .rail .dot img{ width:26px; height:26px; display:block; }
      .rail .ico{
        width:42px; height:42px; border-radius: 8px;
        display:flex; align-items:center; justify-content:center;
        color: var(--muted);
        border: 1px solid transparent;
        cursor: default;
        font-weight: 1000;
      }
      .rail .ico.active{
        background: rgba(0,192,139,.12);
        border-color: rgba(0,192,139,.22);
        color: var(--text);
      }
      .rail .spacer{ flex:1; }
      .rail .user{
        width:42px; height:42px; border-radius: 8px;
        background: linear-gradient(135deg, rgba(14,165,233,.18), rgba(0,192,139,.18));
        border: 1px solid var(--line);
      }

      .sidebar{
        width:260px; background:var(--panel);
        border-right:1px solid var(--line);
        padding:18px;
        position:sticky; top:0; height:100vh; overflow:auto;
      }
      .sb-brand{
        display:flex; align-items:center; gap:10px; margin-bottom:18px;
      }
      .sb-brand img{ height:30px; width:auto; display:block; }
      .sb-title{ font-weight:1000; letter-spacing:.2px; }
      .sb-sub{ font-size:12px; color:var(--muted); margin-top:2px; }

      .nav{ display:grid; gap:8px; margin-top:10px; }
      .nav a{
        text-decoration:none; color:var(--muted);
        display:flex; align-items:center; gap:10px;
        padding:10px 12px; border-radius: 8px;
        border:1px solid transparent;
        font-weight:900; font-size:13px;
      }
      .nav a .n-dot{
        width:8px; height:8px; border-radius: 8px; background: rgba(100,116,139,.35);
      }
      .nav a.active{
        color:var(--text);
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
        margin-bottom:16px;
      }
      .h-left h1{ margin:0; font-size:22px; letter-spacing:.2px; }
      .h-left p{ margin:6px 0 0; color:var(--muted); font-size:13px; }
      .h-right{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }

      .search{
        display:flex; align-items:center; gap:10px;
        background:var(--panel);
        border:1px solid var(--line);
        border-radius: 8px;
        padding: 10px 12px;
        box-shadow: var(--shadow);
      }
      .search input{
        border:0; outline:none; background:transparent;
        min-width: 260px;
        font-size:14px; font-weight:800; color:var(--text);
      }

      /* Cards + widgets */
      .card{
        background:var(--panel);
        border:1px solid var(--line);
        border-radius: 8px;
        box-shadow: var(--shadow);
        padding: 16px;
      }

      .metrics{
        display:grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap:12px;
        margin-bottom:12px;
      }
      .metric{
        display:flex; align-items:flex-end; justify-content:space-between; gap:10px;
        padding:14px;
        border-radius: 8px;
        background: var(--panel);
        border:1px solid var(--line);
        box-shadow: var(--shadow);
      }
      .metric .k{ color:var(--muted); font-size:12px; font-weight:1000; }
      .metric .v{ font-size:22px; font-weight:1100; letter-spacing:.2px; margin-top:6px; }
      .metric .tag{
        font-size:12px; font-weight:1000;
        padding:6px 10px; border-radius: 8px;
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
        grid-template-columns: 1.25fr .75fr;
        gap:12px;
        margin-bottom:12px;
      }

      .gridMain{
        display:grid;
        grid-template-columns: 1.05fr .95fr;
        gap:12px;
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

      h2{ margin:0 0 10px; font-size:16px; }
      .sub{ margin:0; color:var(--muted); font-size:13px; }

      /* Controls */
      label{ display:block; margin: 12px 0 6px; font-weight:1000; font-size:12px; color:var(--text); }
      .ctrl, input, textarea, select{
        width:100%;
        padding: 11px 12px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--panel2);
        color: var(--text);
        font-size: 14px;
        outline: none;
      }
      .ctrl:focus, input:focus, textarea:focus, select:focus{
        box-shadow: 0 0 0 4px rgba(0,192,139,.12);
        border-color: rgba(0,192,139,.35);
        background: var(--panel);
      }
      textarea{ min-height: 110px; resize: vertical; }
      .note{ font-size: 12px; color: var(--muted); margin-top:8px; }

      .btn{
        display:inline-flex; align-items:center; justify-content:center;
        padding: 10px 14px;
        border-radius: 8px;
        border: 1px solid var(--line);
        background: var(--panel);
        cursor:pointer;
        font-weight:1000;
        text-decoration:none;
        color: var(--text);
      }
      .btn:hover{ transform: translateY(-1px); }
      .btn-primary{
        background: var(--brand);
        border-color: var(--brand);
        color:#06202b;
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

      a:not(.btn){ color: var(--brand2); text-decoration:none; font-weight:1000; }
      a:not(.btn):hover{ text-decoration:underline; }

      /* Small widgets */
      .mini{
        border: 1px solid var(--line);
        background: var(--panel2);
        border-radius: 8px;
        padding: 12px;
      }
      .mini + .mini{ margin-top:10px; }
      .kv{ display:flex; justify-content:space-between; align-items:center; margin: 6px 0; color:var(--muted); font-size:13px; }
      .kv strong{ color:var(--text); font-size:14px; }

      /* Chart */
      .chartWrap{ height:220px; }
      canvas{ width:100%; height:220px; display:block; }

      /* Existing events list */
      .event-card{
        border: 1px solid var(--line);
        border-radius: 8px;
        padding: 14px;
        background: var(--panel);
        display:flex;
        justify-content:space-between;
        gap:16px;
        align-items:flex-start;
      }
      .event-left{ flex: 1; min-width: 0; }
      .event-title{ font-weight:1000; margin-bottom:6px; }
      .event-meta{ color: var(--muted); font-size: 13px; display:grid; gap:4px; }
      .event-actions{ margin-top:10px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }

      .pill{
        font-size:12px;
        background: rgba(0,192,139,.12);
        border: 1px solid rgba(0,192,139,.22);
        padding: 6px 10px;
        border-radius: 8px;
        font-weight:1000;
        color:#065f46;
        display:inline-flex; align-items:center; gap:6px;
      }

      .event-thumb{
        width: 116px; flex: 0 0 116px;
      }
      .event-thumb-img{
        width: 116px; height: 116px;
        object-fit: cover;
        border-radius: 8px;
        border: 1px solid var(--line);
        display:block;
      }
      .thumb-empty,
      .thumb-fallback{
        width: 116px; height: 116px;
        border-radius: 8px;
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
        border-radius: 8px;
        padding: 12px;
        background: var(--panel2);
      }
      .stat{ display:flex; justify-content:space-between; align-items:center; font-size: 13px; color: var(--muted); margin: 6px 0; }
      .stat strong{ color: var(--text); font-size: 16px; }

      .pager{
        display:flex;
        justify-content:space-between;
        align-items:center;
        gap:12px;
        margin: 10px 0 14px;
        flex-wrap:wrap;
      }
      .pager-right{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .pager-left{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }

      /* Category selection */
      .cat-grid{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; }
      @media (max-width: 900px){ .cat-grid{ grid-template-columns: 1fr; } }

      /* Recurrence UI polish (keep your functionality, just match the new look) */
      .recurrence{ background: var(--panel2); border:1px solid var(--line); border-radius: 8px; padding: 14px; }
      .rec-grid{ display:grid; grid-template-columns: 1.2fr .8fr; gap: 16px; align-items: start; }
      @media (max-width: 900px){ .rec-grid{ grid-template-columns: 1fr; } }
      .rec-label{ font-weight:1100; font-size: 12px; margin-bottom: 8px; color: var(--text); letter-spacing: .2px; }
      .rec-help{ margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.4; }

      .rec-box{ border:1px solid var(--line); border-radius: 8px; padding: 14px; background: var(--panel2); margin-top: 10px; }
      .checkbox{ display:flex; gap:10px; align-items:center; margin-top: 8px; font-weight:1000; }
      .checkbox input{ width:auto; }

      .dow{ display:flex; flex-wrap:wrap; gap: 10px; margin-top: 10px; }
      .dow-pill{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap: 8px;
        padding: 10px 12px;
        border-radius: 8px;
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        font-weight: 1000;
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
        border-radius: 8px;
        padding: 8px 10px;
        background: var(--panel);
        font-size: 13px;
      }
      .chip button{ border:0; background: transparent; cursor:pointer; font-weight:1000; color: #b91c1c; }

      .sectionTitle{ display:flex; align-items:flex-end; justify-content:space-between; gap:12px; margin-bottom:10px; }
      .sectionTitle .right{ display:flex; align-items:center; gap:8px; flex-wrap:wrap; }

      .small{ font-size:12px; color:var(--muted); font-weight:900; }
    

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
      <!-- Icon rail -->
      <div class="rail">
        <div class="dot" title="OpenCircle">
          <img src="/assets/brand/oc-logo.svg" alt="OC" onerror="this.style.display='none';" />
        </div>
        <div class="ico active" title="Dashboard">▦</div>
        <div class="ico" title="Events">⧉</div>
        <div class="ico" title="Analytics">⌁</div>
        <div class="ico" title="Settings">⚙</div>
        <div class="spacer"></div>
        <div class="user" title="User"></div>
      </div>

      <!-- Sidebar -->
      <aside class="sidebar">
        <div class="sb-brand">
          <img src="/assets/brand/oc-logo.svg" alt="OpenCircle" onerror="this.style.display='none';" />
          </div>

        <nav class="nav">
          <a class="active" href="/admin"><span class="n-dot"></span> Dashboard</a>
          <a href="#manage"><span class="n-dot"></span> Manage events</a>
          <a href="#analytics"><span class="n-dot"></span> Analytics</a>
          <a href="#settings"><span class="n-dot"></span> Settings</a>
        </nav>

        <div style="margin-top:18px;">
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
              <button class="btn btn-primary" type="submit">Search</button>
              ${q ? `<a class="btn" href="/admin?pg=1&limit=${esc(String(limit))}">Reset</a>` : ``}
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
                <p class="sub">Last 14 days (by start date)</p>
              </div>
              <div class="right">
                <span class="small">Past: <strong>${esc(stats.past)}</strong></span>
                <span class="small">Upcoming: <strong>${esc(stats.upcoming)}</strong></span>
              </div>
            </div>
            <div class="chartWrap">
              <canvas id="eventsChart" width="900" height="220"></canvas>
            </div>
          </div>

          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Top locations</h2>
                <p class="sub">Most frequent event locations</p>
              </div>
            </div>

            <div class="mini">
              ${topLocationsHtml}
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
                  <label for="featured" style="margin:0;font-size:12px;font-weight:1100;">Featured event</label>
                </div>
                <div class="note">Featured events show a badge on the event card and event page.</div>
              </div>

              <div class="rec-box">
                <div style="font-weight:1100; margin-bottom:6px;">Categories (pick up to 3)</div>
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
                  <label for="hasRecurrence" style="margin:0;font-size:12px;font-weight:1100;">Recurring event</label>
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

              <img id="uploadPreview" style="margin-top:10px; width:160px; height:160px; object-fit:cover; border-radius:8px; border:1px solid var(--line); display:none;" alt="Flyer upload preview" />

              <label style="margin-top:12px;">Image URL (optional fallback)</label>
              <input class="ctrl" name="imageUrl" value="${esc(editEvent?.imageUrl || "")}" placeholder="https://..." />

              ${
                editEvent?.imageUrl
                  ? `
                    <div class="note">Current: <a href="${esc(editEvent.imageUrl)}" target="_blank" rel="noopener">View image</a></div>
                    <div style="margin-top:10px;">
                      <img id="existingPreview" src="${esc(editEvent.imageUrl)}"
                        style="width:160px; height:160px; object-fit:cover; border-radius:8px; border:1px solid var(--line);"
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
                ${editEvent ? `<a class="btn btn-link" href="/admin?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}">Cancel</a>` : ""}
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
                <span class="small">Showing <strong>${showingFrom}–${showingTo}</strong> of <strong>${total}</strong></span>
              </div>
            </div>

            ${pagerHtml}

            <div style="display:flex; gap:12px; align-items:center; margin: 10px 0 14px; flex-wrap:wrap;">
              <input id="eventSearch" class="ctrl" type="text" placeholder="Instant filter on this page..." />
              <button id="eventSearchClear" type="button" class="btn">Clear</button>
            </div>

            <div id="eventsList" style="display:grid; gap:12px;">${listHtml}</div>
            <div id="eventsEmpty" class="muted" style="display:none; margin-top:10px;">No matching events.</div>

            ${pagerHtml}
          </div>
        </section>

      </main>
    </div>

    <script>
      // ---- helpers ----
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

      // Simple bar chart (no libraries)
      (function(){
        var data = ${chartDataJson};
        var c = document.getElementById("eventsChart");
        if(!c || !c.getContext) return;
        var ctx = c.getContext("2d");
        if(!ctx) return;

        function draw(){
          // handle DPR
          var dpr = window.devicePixelRatio || 1;
          var cssW = c.clientWidth || 900;
          var cssH = 220;
          c.width = Math.floor(cssW * dpr);
          c.height = Math.floor(cssH * dpr);
          ctx.setTransform(dpr,0,0,dpr,0,0);

          ctx.clearRect(0,0,cssW,cssH);

          var padL = 36, padR = 12, padT = 10, padB = 28;
          var w = cssW - padL - padR;
          var h = cssH - padT - padB;

          // axes
          ctx.globalAlpha = 1;
          ctx.strokeStyle = "rgba(148,163,184,.22)";
          ctx.beginPath();
          ctx.moveTo(padL, padT);
          ctx.lineTo(padL, padT + h);
          ctx.lineTo(padL + w, padT + h);
          ctx.stroke();

          var maxV = 1;
          for(var i=0;i<data.values.length;i++){ if(data.values[i] > maxV) maxV = data.values[i]; }

          // grid lines (4)
          ctx.fillStyle = "rgba(229,231,235,.75)";
          ctx.font = "12px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
          for(var g=0; g<=4; g++){
            var y = padT + (h * g / 4);
            ctx.strokeStyle = "rgba(148,163,184,.14)";
            ctx.beginPath();
            ctx.moveTo(padL, y);
            ctx.lineTo(padL + w, y);
            ctx.stroke();

            var val = Math.round(maxV * (1 - g/4));
            ctx.fillText(String(val), 6, y + 4);
          }

          // bars
          var n = data.values.length;
          var gap = 8;
          var barW = Math.max(10, Math.floor((w - gap*(n-1)) / n));
          for(var b=0;b<n;b++){
            var v = data.values[b];
            var bh = Math.round((v / maxV) * (h - 6));
            var x = padL + b * (barW + gap);
            var y2 = padT + h - bh;

            ctx.fillStyle = "rgba(0,192,139,.65)";
            ctx.fillRect(x, y2, barW, bh);

            ctx.fillStyle = "rgba(229,231,235,.70)";
            ctx.font = "11px ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial";
            var label = data.labels[b];
            ctx.save();
            ctx.translate(x + barW/2, padT + h + 16);
            ctx.rotate(-0.45);
            ctx.textAlign = "center";
            ctx.fillText(label, 0, 0);
            ctx.restore();
          }
        }

        draw();
        window.addEventListener("resize", function(){ draw(); });
      })();
    </script>
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
const limit = req.query.limit ? String(req.query.limit) : "50";
const q = req.query.q ? String(req.query.q) : "";

const sp = new URLSearchParams({ edit: String(id), pg, limit });
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
const limit = req.query.limit ? String(req.query.limit) : "50";
const q = req.query.q ? String(req.query.q) : "";

const sp = new URLSearchParams({ pg, limit });
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
const limit = req.query.limit ? String(req.query.limit) : "50";
const q = req.query.q ? String(req.query.q) : "";

const sp = new URLSearchParams({ pg, limit });
if (q) sp.set("q", q);

res.redirect(`/admin?${sp.toString()}`);

  } catch (err) {
    console.error(err);
    res.status(500).send("Server error.");
  }
});

module.exports = router;
