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
  "Community",
  "Family & Kids",
  "Sports & Fitness",
  "Nightlife",
  "Markets & Shopping",
  "Classes & Workshops",
  "Outdoors",
  "Business & Networking",
  "Charity & Fundraising",
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

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Convert yyyy-mm-dd + hh:mm (datetime-local-ish) into ISO with local offset
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

function toDateValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toTimeValue(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isChecked(arr, v) {
  return Array.isArray(arr) && arr.includes(v) ? "checked" : "";
}

/**
 * GET /admin
 * Supports:
 *  - ?edit=ID
 *  - ?q=searchTerm
 *  - ?page=1..n
 */
router.get("/", async (req, res) => {
  try {
    const pageSize = 50;
    const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
    const q = String(req.query.q || "").trim();

    const where = q ? `WHERE title LIKE ? OR location LIKE ? OR slug LIKE ?` : "";
    const params = q ? [`%${q}%`, `%${q}%`, `%${q}%`] : [];

    const totalRow = await get(
      `SELECT COUNT(*) as c FROM events ${where}`,
      params
    );
    const totalCount = Number(totalRow?.c || 0);

    const offset = (page - 1) * pageSize;
    const events = await all(
      `SELECT id, slug, title, startDateTime, location, featured, goingCount, interestedCount
       FROM events
       ${where}
       ORDER BY startDateTime DESC
       LIMIT ? OFFSET ?`,
      [...params, pageSize, offset]
    );

    const editId = req.query.edit ? parseInt(req.query.edit, 10) : null;
    let editEvent = null;
    if (editId) editEvent = await get("SELECT * FROM events WHERE id = ?", [editId]);

    // --- Edit values ---
    const selectedCats = normalizeCategories(parseStoredCategories(editEvent?.categories));
    const isFeatured = Number(editEvent?.featured || 0) === 1;

    const hasRecurrence = Number(editEvent?.hasRecurrence || 0) === 1;

    const rule = parseStoredRule(editEvent?.recurrenceRule) || { type: "none", interval: 1 };
    const ruleType = String(rule.type || "none").toLowerCase();

    const recurrenceInterval = String(rule.interval || 1);
    const weeklyByDay = Array.isArray(rule.byDay) ? rule.byDay : [];

    // Monthly mode:
    // - "monthday": byMonthday (1..31)
    // - "nthweekday": setPos (1..4 or -1) + byDay (one weekday)
    const monthlyMode = String(rule.monthlyMode || "monthday");
    const byMonthday = rule.byMonthday ? String(rule.byMonthday) : "";
    const setPos = rule.setPos !== undefined ? String(rule.setPos) : "1";
    const monthlyByDay = rule.monthlyByDay ? String(rule.monthlyByDay) : "TH";

    const customDates = parseStoredDates(editEvent?.recurrenceDates);

    // Optional recurrence range fields (simple date inputs)
    const recurrenceStartDate = String(editEvent?.recurrenceStartDate || "");
    const recurrenceUntilDate = String(editEvent?.recurrenceUntilDate || "");

    const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));

    const listHtml = events.length
      ? events
          .map((e) => {
            const going = Number(e.goingCount || 0);
            const interested = Number(e.interestedCount || 0);
            const featuredPill =
              Number(e.featured || 0) === 1
                ? `<span class="pill" style="margin-left:8px;">Featured</span>`
                : "";

            const viewHref = e.slug ? `/events/slug/${esc(e.slug)}` : `/events/${e.id}`;

            return `
              <div class="event-card" data-eid="${e.id}">
                <div class="event-left">
                  <div class="event-title">#${e.id} — ${esc(e.title)} ${featuredPill}</div>
                  <div class="event-meta">
                    <div><strong>Slug:</strong> ${esc(e.slug || "")}</div>
                    <div><strong>Start:</strong> ${esc(e.startDateTime || "")}</div>
                    <div><strong>Location:</strong> ${esc(e.location || "")}</div>
                  </div>

                  <div class="event-actions">
                    <a href="${viewHref}" target="_blank" rel="noopener">View JSON</a>
                    <a href="/admin?edit=${e.id}">Edit</a>

                    <form method="POST" action="/admin/events/${e.id}/delete" class="inline js-delete-form">
                      <button type="submit" class="btn btn-danger">Delete</button>
                    </form>
                  </div>
                </div>

                <div class="event-stats">
                  <div class="stat"><span>Going</span><strong class="js-going">${going}</strong></div>
                  <div class="stat"><span>Interested</span><strong class="js-interested">${interested}</strong></div>
                  <div class="note" style="margin-top:10px;">Live</div>
                </div>
              </div>
            `;
          })
          .join("")
      : `<div class="muted">No events found.</div>`;

    // Pagination UI
    const pagination = totalPages > 1
      ? (() => {
          const mkLink = (p, label, disabled) => {
            const cls = disabled ? "btn is-disabled" : "btn";
            const href = disabled ? "#" : `/admin?page=${p}${q ? `&q=${encodeURIComponent(q)}` : ""}`;
            return `<a class="${cls}" href="${href}" ${disabled ? 'aria-disabled="true" tabindex="-1"' : ""}>${label}</a>`;
          };

          const prev = mkLink(page - 1, "← Prev", page <= 1);
          const next = mkLink(page + 1, "Next →", page >= totalPages);

          return `
            <div class="pager">
              <div class="muted">Page ${page} of ${totalPages}</div>
              <div class="pager-actions">
                ${prev}
                ${next}
              </div>
            </div>
          `;
        })()
      : "";

    res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="/assets/brand/favicon.ico" />
    <title>OpenCircle Admin</title>
    <style>
      :root{
        --bg:#0b1220; --card:#0f172a; --text:#e5e7eb; --muted:#94a3b8;
        --line:rgba(148,163,184,.18);
        --brand:#00c08b; --brand2:#0aa678; --danger:#ef4444;
        --shadow:0 10px 30px rgba(0,0,0,.35);
        --radius:4px;
      }
      *{ box-sizing:border-box; }
      body{
        margin:0; background:var(--bg); color:var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        padding:24px;
      }
      .wrap{ max-width: 980px; margin: 0 auto; }
      .topbar{ display:flex; align-items:center; justify-content:space-between; gap:16px; margin-bottom:18px; }
      .brand{ display:flex; align-items:center; gap:12px; }
      .brand img{ height:54px; width:auto; display:block; }
      .brand-title{ font-size:18px; font-weight:800; line-height:1; }
      .pill{
        font-size:12px; color: var(--text);
        background: rgba(0,192,139,.14);
        border: 1px solid rgba(0,192,139,.35);
        padding:6px 10px; border-radius:999px; font-weight:700;
        display:inline-flex; align-items:center; gap:6px;
      }
      .card{
        background:var(--card);
        border:1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        padding: 18px;
      }
      .card + .card{ margin-top: 16px; }
      h1{ margin:0 0 8px; font-size:22px; }
      .sub{ margin:0; color:var(--muted); }
      .row{ display:grid; grid-template-columns: 1fr 1fr; gap:12px; }
      @media (max-width: 900px){ .row{ grid-template-columns: 1fr; } }

      label{ display:block; margin: 12px 0 6px; font-weight:800; font-size:13px; }
      .ctrl, input, textarea, select{
        width:100%; padding: 10px 12px; border: 1px solid rgba(148,163,184,.25);
        border-radius: var(--radius); background:#0b1220; color: var(--text); font-size: 14px; outline: none;
      }
      textarea{ min-height: 110px; resize: vertical; }
      .note{ font-size: 12px; color: var(--muted); margin-top:8px; }
      .btn{
        display:inline-flex; align-items:center; justify-content:center;
        padding: 10px 14px; border-radius: var(--radius);
        border: 1px solid rgba(148,163,184,.22);
        background:#0b1220; cursor:pointer; font-weight:800; text-decoration:none; color: var(--text);
      }
      .btn.is-disabled{ opacity:.5; pointer-events:none; }
      .btn-primary{ background: var(--brand); border-color: var(--brand); color:#05261d; }
      .btn-primary:hover{ background: var(--brand2); border-color: var(--brand2); }
      .btn-danger{ background: rgba(239,68,68,.12); border-color: rgba(239,68,68,.25); color: #fecaca; }
      .btn-link{ background: transparent; border-color: transparent; color: var(--brand); padding: 8px 10px; }
      .actions{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top: 14px; }

      .event-card{
        display:flex;
        justify-content:space-between;
        gap:16px;
        align-items:flex-start;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 14px;
        background: #0b1220;
      }
      .event-left{ flex: 1; min-width: 0; }
      .event-title{ font-weight:900; margin-bottom:6px; }
      .event-meta{ color: var(--muted); font-size: 13px; display:grid; gap:4px; }
      .event-actions{ margin-top:10px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }

      .event-stats{
        width: 160px;
        flex: 0 0 160px;
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 12px;
        background: rgba(15,23,42,.35);
      }
      .stat{
        display:flex;
        justify-content:space-between;
        align-items:center;
        font-size: 13px;
        color: var(--muted);
        margin: 6px 0;
      }
      .stat strong{
        color: var(--text);
        font-size: 16px;
      }

      a{ color: var(--brand); text-decoration:none; font-weight:800; }
      a:hover{ text-decoration:underline; }
      .inline{ display:inline; margin:0; }
      .muted{ color: var(--muted); }

      .cat-grid{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; }
      @media (max-width: 900px){ .cat-grid{ grid-template-columns: 1fr; } }

      .box{
        border:1px solid var(--line);
        border-radius: var(--radius);
        padding: 14px;
        background: #0b1220;
        margin-top: 10px;
      }
      .checkbox{ display:flex; gap:10px; align-items:center; margin-top: 8px; font-weight:900; }
      .checkbox input{ width:auto; }

      .rec-row{
        display:grid;
        grid-template-columns: 1.2fr .8fr;
        gap:12px;
        align-items:start;
      }
      @media (max-width: 900px){ .rec-row{ grid-template-columns: 1fr; } }

      .days{
        display:flex;
        flex-wrap:wrap;
        gap:10px;
        margin-top:8px;
      }
      .day{
        display:inline-flex;
        align-items:center;
        gap:8px;
        padding:8px 10px;
        border:1px solid rgba(148,163,184,.22);
        border-radius: var(--radius);
        background: rgba(15,23,42,.35);
        font-weight:800;
      }
      .day input{ width:auto; }

      .chips{ display:flex; flex-wrap:wrap; gap:10px; margin-top:10px; }
      .chip{
        display:flex; align-items:center; gap:8px;
        border:1px solid rgba(148,163,184,.22);
        border-radius: var(--radius);
        padding:8px;
        background: rgba(15,23,42,.35);
      }
      .chip button{
        width:28px; height:28px;
        border-radius: var(--radius);
        border:1px solid rgba(148,163,184,.22);
        background:#0b1220; color: var(--text);
        cursor:pointer; font-weight:900;
      }

      .list-head{
        display:flex;
        align-items:baseline;
        justify-content:space-between;
        gap:12px;
        flex-wrap:wrap;
        margin-bottom:10px;
      }
      .searchbar{
        display:flex;
        gap:10px;
        align-items:center;
        flex-wrap:wrap;
      }

      .pager{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:12px;
        margin-top:14px;
        padding-top:14px;
        border-top:1px solid var(--line);
      }
      .pager-actions{ display:flex; gap:10px; }
    </style>
  </head>

  <body>
    <div class="wrap">
      <div class="topbar">
        <div class="brand">
          <img src="/assets/brand/oc-logo.svg" alt="OpenCircle API" />
          <div>
            <div class="brand-title">OpenCircle Admin</div>
            <div class="muted" style="font-size:12px; margin-top:4px;">Create and manage events (SQLite)</div>
          </div>
        </div>
        <div class="pill">/admin</div>
      </div>

      <div class="card">
        <h1>${editEvent ? "Edit Event" : "Add Event"}</h1>
        <p class="sub"><a href="/events" target="_blank" rel="noopener">View all events (JSON)</a></p>

        <form method="POST" action="/admin/events" enctype="multipart/form-data">
          ${editEvent ? `<input type="hidden" name="id" value="${esc(editEvent.id)}" />` : ""}

          <label>City</label>
          <input class="ctrl" name="city" value="${esc(editEvent?.city || "Enumclaw")}" />

          <div class="box">
            <div class="checkbox">
              <input type="checkbox" id="featured" name="featured" value="1" ${isFeatured ? "checked" : ""} />
              <label for="featured" style="margin:0;font-size:13px;font-weight:900;">Mark as Featured Event</label>
            </div>
            <div class="note">Featured events show a badge on the event card and event page.</div>
          </div>

          <div class="box">
            <div style="font-weight:900; margin-bottom:6px;">Categories (pick up to 3)</div>
            <div class="cat-grid">
              ${[0,1,2].map((idx) => {
                const current = selectedCats[idx] || "";
                return `
                  <div>
                    <div class="muted" style="font-size:12px; margin-bottom:6px;">Category ${idx+1}</div>
                    <select name="categories" class="ctrl">
                      <option value="">— None —</option>
                      ${ALLOWED_CATEGORIES.map((c) => {
                        const sel = current === c ? "selected" : "";
                        return `<option value="${esc(c)}" ${sel}>${esc(c)}</option>`;
                      }).join("")}
                    </select>
                  </div>
                `;
              }).join("")}
            </div>
            <div class="note">Only these 12 categories are allowed. Max 3 per event.</div>
          </div>

          <label>Title</label>
          <input class="ctrl" name="title" value="${esc(editEvent?.title || "")}" required />

          <label>Description</label>
          <textarea class="ctrl" name="description" required>${esc(editEvent?.description || "")}</textarea>

          <label>Event Details</label>
          <textarea class="ctrl" name="eventDetails">${esc(editEvent?.eventDetails || "")}</textarea>

          <label>Good to Know</label>
          <textarea class="ctrl" name="goodToKnow">${esc(editEvent?.goodToKnow || "")}</textarea>

          <!-- Split date/time inputs -->
          <div class="row">
            <div>
              <label>Start</label>
              <div class="row" style="grid-template-columns: 1fr 1fr;">
                <input id="startDate" class="ctrl" type="date" name="startDate" value="${esc(toDateValue(editEvent?.startDateTime))}" required />
                <input id="startTime" class="ctrl" type="time" name="startTime" value="${esc(toTimeValue(editEvent?.startDateTime))}" required />
              </div>
            </div>

            <div>
              <label>End</label>
              <div class="row" style="grid-template-columns: 1fr 1fr;">
                <input id="endDate" class="ctrl" type="date" name="endDate" value="${esc(toDateValue(editEvent?.endDateTime))}" required />
                <input id="endTime" class="ctrl" type="time" name="endTime" value="${esc(toTimeValue(editEvent?.endDateTime))}" required />
              </div>
            </div>
          </div>

          <!-- ✅ Recurring Events -->
          <div class="box">
            <div class="checkbox">
              <input type="checkbox" id="hasRecurrence" name="hasRecurrence" value="1" ${hasRecurrence ? "checked" : ""} />
              <label for="hasRecurrence" style="margin:0;font-size:13px;font-weight:900;">Recurring Event</label>
            </div>
            <div class="note">Weekly, monthly (like “first Thursday”), or custom dates.</div>

            <div class="rec-row" style="margin-top:12px;">
              <div>
                <label style="margin-top:0;">Recurrence Type</label>
                <select id="recurrenceType" name="recurrenceType" class="ctrl">
                  <option value="none" ${ruleType === "none" ? "selected" : ""}>None</option>
                  <option value="weekly" ${ruleType === "weekly" ? "selected" : ""}>Weekly</option>
                  <option value="monthly" ${ruleType === "monthly" ? "selected" : ""}>Monthly</option>
                  <option value="custom" ${ruleType === "custom" ? "selected" : ""}>Custom Dates</option>
                </select>
              </div>

              <div id="intervalRow">
                <label style="margin-top:0;">Interval</label>
                <input class="ctrl" type="number" min="1" name="recurrenceInterval" value="${esc(recurrenceInterval)}" />
                <div class="note">Example: every 1 week, every 2 weeks, every 1 month, etc.</div>
              </div>
            </div>

            <div class="rec-row" style="margin-top:12px;">
              <div>
                <label style="margin-top:0;">First Date</label>
                <input class="ctrl" type="date" name="recurrenceStartDate" value="${esc(recurrenceStartDate)}" />
                <div class="note">Optional. If blank, start from the event Start Date above.</div>
              </div>
              <div>
                <label style="margin-top:0;">Until Date</label>
                <input class="ctrl" type="date" name="recurrenceUntilDate" value="${esc(recurrenceUntilDate)}" />
                <div class="note">Optional. Stops generating occurrences after this date.</div>
              </div>
            </div>

            <div id="weeklyBox" style="margin-top:12px;">
              <label>Days of Week</label>
              <div class="days">
                <label class="day"><input type="checkbox" name="weeklyByDay" value="SU" ${isChecked(weeklyByDay, "SU")} />Sun</label>
                <label class="day"><input type="checkbox" name="weeklyByDay" value="MO" ${isChecked(weeklyByDay, "MO")} />Mon</label>
                <label class="day"><input type="checkbox" name="weeklyByDay" value="TU" ${isChecked(weeklyByDay, "TU")} />Tue</label>
                <label class="day"><input type="checkbox" name="weeklyByDay" value="WE" ${isChecked(weeklyByDay, "WE")} />Wed</label>
                <label class="day"><input type="checkbox" name="weeklyByDay" value="TH" ${isChecked(weeklyByDay, "TH")} />Thu</label>
                <label class="day"><input type="checkbox" name="weeklyByDay" value="FR" ${isChecked(weeklyByDay, "FR")} />Fri</label>
                <label class="day"><input type="checkbox" name="weeklyByDay" value="SA" ${isChecked(weeklyByDay, "SA")} />Sat</label>
              </div>
              <div class="note">Pick one or more days.</div>
            </div>

            <div id="monthlyBox" style="margin-top:12px;">
              <div class="rec-row">
                <div>
                  <label style="margin-top:0;">Monthly Mode</label>
                  <select id="monthlyMode" name="monthlyMode" class="ctrl">
                    <option value="monthday" ${monthlyMode === "monthday" ? "selected" : ""}>On day of month</option>
                    <option value="nthweekday" ${monthlyMode === "nthweekday" ? "selected" : ""}>On nth weekday (ex: first Thursday)</option>
                  </select>
                </div>
                <div></div>
              </div>

              <div id="monthdayBox" style="margin-top:12px;">
                <label>Day of Month (1–31)</label>
                <input class="ctrl" type="number" min="1" max="31" name="byMonthday" value="${esc(byMonthday)}" />
              </div>

              <div id="nthweekdayBox" style="margin-top:12px;">
                <div class="rec-row">
                  <div>
                    <label>Which Week</label>
                    <select name="setPos" class="ctrl">
                      <option value="1" ${setPos === "1" ? "selected" : ""}>1st</option>
                      <option value="2" ${setPos === "2" ? "selected" : ""}>2nd</option>
                      <option value="3" ${setPos === "3" ? "selected" : ""}>3rd</option>
                      <option value="4" ${setPos === "4" ? "selected" : ""}>4th</option>
                      <option value="-1" ${setPos === "-1" ? "selected" : ""}>Last</option>
                    </select>
                  </div>
                  <div>
                    <label>Weekday</label>
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

            <div id="customBox" style="margin-top:12px;">
              <label>Custom Dates</label>
              <div class="note">Add specific dates (YYYY-MM-DD). Time comes from the Start/End above.</div>

              <div id="customDatesWrap" class="chips">
                ${
                  (customDates || [])
                    .map((d) => {
                      return `
                        <span class="chip">
                          <input class="ctrl" style="width:170px; padding:8px 10px;" type="date" name="recurrenceDates" value="${esc(d)}" />
                          <button type="button" data-remove-date="1" aria-label="Remove">×</button>
                        </span>
                      `;
                    })
                    .join("")
                }
              </div>

              <div class="actions" style="margin-top:10px;">
                <button id="addCustomDate" type="button" class="btn">+ Add Date</button>
              </div>
            </div>
          </div>

          <label>Flyer Image (Upload)</label>
          <input class="ctrl" type="file" name="imageFile" accept="image/*" />
          <div class="note">Uploading replaces the Image URL below.</div>

          <label style="margin-top:12px;">Image URL (optional fallback)</label>
          <input class="ctrl" name="imageUrl" value="${esc(editEvent?.imageUrl || "")}" placeholder="https://..." />

          ${editEvent?.imageUrl
            ? `<div class="note">Current: <a href="${esc(editEvent.imageUrl)}" target="_blank" rel="noopener">View image</a></div>`
            : ""
          }

          <div class="row">
            <div>
              <label>Ticket Button Text</label>
              <input class="ctrl" name="ticketLabel" value="${esc(editEvent?.ticketLabel || "Tickets")}" />
            </div>
            <div>
              <label>Ticket Link (URL)</label>
              <input class="ctrl" name="ticketUrl" value="${esc(editEvent?.ticketUrl || "")}" placeholder="https://..." />
            </div>
          </div>

          <label>Location</label>
          <input class="ctrl" name="location" value="${esc(editEvent?.location || "")}" required />

          <label>Organizer</label>
          <input class="ctrl" name="organizer" value="${esc(editEvent?.organizer || "")}" required />

          <div class="actions">
            <button type="submit" class="btn btn-primary">${editEvent ? "Update Event" : "Save Event"}</button>
            ${editEvent ? `<a class="btn btn-link" href="/admin">Cancel</a>` : ""}
          </div>
        </form>
      </div>

      <div class="card">
        <div class="list-head">
          <h1 style="margin:0;">Existing Events <span class="muted" style="font-weight:800; font-size:14px;">(${totalCount})</span></h1>

          <form class="searchbar" method="GET" action="/admin">
            <input class="ctrl" style="width:320px;" name="q" value="${esc(q)}" placeholder="Search title, location, or slug..." />
            <button class="btn" type="submit">Search</button>
            ${q ? `<a class="btn btn-link" href="/admin">Clear</a>` : ""}
          </form>
        </div>

        <div style="display:grid; gap:12px;">${listHtml}</div>
        ${pagination}
      </div>
    </div>

    <script>
      // Delete confirmation
      (function(){
        var forms = document.querySelectorAll(".js-delete-form");
        for (var i=0;i<forms.length;i++){
          forms[i].addEventListener("submit", function(ev){
            if(!confirm("Delete this event? This cannot be undone.")){
              ev.preventDefault();
            }
          });
        }
      })();

      // Live counts refresh (safe)
      (function(){
        function updateCard(card, payload){
          if(!card || !payload) return;
          var g = card.querySelector('.js-going');
          var i = card.querySelector('.js-interested');
          var e = payload.data ? payload.data : payload;
          if(!e) return;

          if(g && typeof e.goingCount !== 'undefined') g.textContent = String(Number(e.goingCount || 0));
          if(i && typeof e.interestedCount !== 'undefined') i.textContent = String(Number(e.interestedCount || 0));
        }

        async function refreshOne(card){
          var id = card.getAttribute('data-eid');
          if(!id) return;
          try{
            var res = await fetch('/events/' + encodeURIComponent(id), { headers: { 'Accept': 'application/json' } });
            if(!res.ok) return;
            var json = await res.json();
            updateCard(card, json);
          }catch(_){}
        }

        function tick(){
          var cards = document.querySelectorAll('.event-card[data-eid]');
          for(var j=0;j<cards.length;j++){
            refreshOne(cards[j]);
          }
        }

        tick();
        setInterval(tick, 15000);
      })();

      // Auto-set End = Start + 2 hours (safe)
      (function(){
        var sd = document.getElementById('startDate');
        var st = document.getElementById('startTime');
        var ed = document.getElementById('endDate');
        var et = document.getElementById('endTime');
        if(!sd || !st || !ed || !et) return;

        function pad(n){ return String(n).padStart(2,'0'); }

        function getStart(){
          if(!sd.value || !st.value) return null;
          var d = new Date(sd.value + 'T' + st.value);
          if(isNaN(d.getTime())) return null;
          return d;
        }

        function getEnd(){
          if(!ed.value || !et.value) return null;
          var d = new Date(ed.value + 'T' + et.value);
          if(isNaN(d.getTime())) return null;
          return d;
        }

        function setEnd(d){
          ed.value = d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
          et.value = pad(d.getHours()) + ':' + pad(d.getMinutes());
        }

        function maybeSetEnd(){
          var s = getStart();
          if(!s) return;
          var e = getEnd();
          if(!e || e.getTime() <= s.getTime()){
            var d = new Date(s.getTime());
            d.setHours(d.getHours() + 2);
            setEnd(d);
          }
        }

        sd.addEventListener('change', maybeSetEnd);
        st.addEventListener('change', maybeSetEnd);
        sd.addEventListener('blur', maybeSetEnd);
        st.addEventListener('blur', maybeSetEnd);

        maybeSetEnd();
      })();

      // Recurrence UI logic + custom date chips
      (function(){
        var hasRec = document.getElementById("hasRecurrence");
        var typeSel = document.getElementById("recurrenceType");
        var intervalRow = document.getElementById("intervalRow");
        var weeklyBox = document.getElementById("weeklyBox");
        var monthlyBox = document.getElementById("monthlyBox");
        var customBox = document.getElementById("customBox");

        var monthlyMode = document.getElementById("monthlyMode");
        var monthdayBox = document.getElementById("monthdayBox");
        var nthweekdayBox = document.getElementById("nthweekdayBox");

        var addBtn = document.getElementById("addCustomDate");
        var wrap = document.getElementById("customDatesWrap");

        function show(el, on){ if(!el) return; el.style.display = on ? "" : "none"; }

        function refresh(){
          var enabled = hasRec && hasRec.checked;
          show(typeSel && typeSel.closest(".rec-row"), enabled);
          show(intervalRow, enabled);

          var t = enabled ? (typeSel ? typeSel.value : "none") : "none";

          show(weeklyBox, t === "weekly");
          show(monthlyBox, t === "monthly");
          show(customBox, t === "custom");

          // Interval not needed for custom dates
          if(intervalRow) intervalRow.style.display = (t === "custom" || t === "none") ? "none" : "";

          // Monthly mode toggles
          if(monthlyMode){
            var m = monthlyMode.value;
            show(monthdayBox, t === "monthly" && m === "monthday");
            show(nthweekdayBox, t === "monthly" && m === "nthweekday");
          }
        }

        if(hasRec) hasRec.addEventListener("change", refresh);
        if(typeSel) typeSel.addEventListener("change", refresh);
        if(monthlyMode) monthlyMode.addEventListener("change", refresh);

        // custom dates add/remove
        if(addBtn && wrap){
          addBtn.addEventListener("click", function(){
            var chip = document.createElement("span");
            chip.className = "chip";
            chip.innerHTML =
              '<input class="ctrl" style="width:170px; padding:8px 10px;" type="date" name="recurrenceDates" value="" />' +
              '<button type="button" data-remove-date="1" aria-label="Remove">×</button>';
            wrap.appendChild(chip);
          });

          wrap.addEventListener("click", function(ev){
            var t = ev.target;
            if(t && t.getAttribute && t.getAttribute("data-remove-date") === "1"){
              ev.preventDefault();
              var chip = t.closest(".chip");
              if(chip) chip.remove();
            }
          });
        }

        refresh();
      })();
    </script>
  </body>
</html>`);
  } catch (err) {
    console.error("[ADMIN] GET /admin error:", err);
    res.status(500).send("Internal server error");
  }
});

/**
 * POST /admin/events (create or update)
 */
router.post("/events", upload.single("imageFile"), async (req, res) => {
  try {
    let {
      id,
      city = "Enumclaw",
      title,
      description,
      eventDetails,
      goodToKnow,
      startDate,
      startTime,
      endDate,
      endTime,
      location,
      organizer,
      imageUrl,
      ticketUrl,
      ticketLabel,
      categories,
      featured,

      // recurrence
      hasRecurrence,
      recurrenceType,
      recurrenceInterval,
      weeklyByDay,
      monthlyMode,
      byMonthday,
      setPos,
      monthlyByDay,
      recurrenceDates,
      recurrenceStartDate,
      recurrenceUntilDate,
    } = req.body;

    // Build datetime-local strings from split inputs
    let startDateTime = (startDate && startTime) ? `${startDate}T${startTime}` : "";
    let endDateTime   = (endDate && endTime) ? `${endDate}T${endTime}` : "";

    // If end missing, default to +2 hours
    if (startDateTime && (!endDateTime || !endDate || !endTime)) {
      const d = new Date(startDateTime);
      if (!isNaN(d.getTime())) {
        d.setHours(d.getHours() + 2);
        const pad = (n) => String(n).padStart(2, "0");
        endDateTime =
          `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
      }
    }

    // If a file was uploaded, prefer it over the URL field
    if (req.file && req.file.filename) {
      const proto = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["x-forwarded-host"] || req.get("host");
      imageUrl = `${proto}://${host}/uploads/${req.file.filename}`;
    }

    const featuredFlag = String(featured || "") === "1" ? 1 : 0;

    // Convert to stored format
    startDateTime = toLocalISOWithOffset(startDateTime);
    endDateTime = toLocalISOWithOffset(endDateTime);

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

    const baseSlug = slugify(title);
    const cats = normalizeCategories(categories);
    const catsJson = JSON.stringify(cats);

    // --- Recurrence payload ---
    const hasRecurrenceFlag = String(hasRecurrence || "") === "1" ? 1 : 0;
    const type = String(recurrenceType || "none").toLowerCase();

    let ruleObj = null;
    let datesArr = [];

    // Normalize recurrence dates array
    if (Array.isArray(recurrenceDates)) datesArr = recurrenceDates.filter(Boolean);
    else if (typeof recurrenceDates === "string" && recurrenceDates.trim() !== "") datesArr = [recurrenceDates.trim()];

    // Build rule only if recurrence enabled + type != none
    if (hasRecurrenceFlag && type !== "none") {
      const interval = Math.max(1, parseInt(recurrenceInterval || "1", 10) || 1);

      if (type === "weekly") {
        const byDay = Array.isArray(weeklyByDay)
          ? weeklyByDay
          : (weeklyByDay ? [weeklyByDay] : []);

        ruleObj = { type: "weekly", interval, byDay };
      } else if (type === "monthly") {
        const mm = String(monthlyMode || "monthday");
        if (mm === "nthweekday") {
          ruleObj = {
            type: "monthly",
            interval,
            monthlyMode: "nthweekday",
            setPos: parseInt(setPos || "1", 10) || 1,
            monthlyByDay: String(monthlyByDay || "TH"),
          };
        } else {
          ruleObj = {
            type: "monthly",
            interval,
            monthlyMode: "monthday",
            byMonthday: parseInt(byMonthday || "1", 10) || 1,
          };
        }
      } else if (type === "custom") {
        ruleObj = { type: "custom", interval: 1 };
      }
    } else {
      // not recurring
      ruleObj = { type: "none", interval: 1 };
      datesArr = [];
    }

    const recurrenceRuleJson = JSON.stringify(ruleObj || { type: "none", interval: 1 });
    const recurrenceDatesJson = JSON.stringify(datesArr || []);

    // sanitize recurrence range dates (YYYY-MM-DD or empty)
    const recStart = (typeof recurrenceStartDate === "string" && recurrenceStartDate.trim()) ? recurrenceStartDate.trim() : null;
    const recUntil = (typeof recurrenceUntilDate === "string" && recurrenceUntilDate.trim()) ? recurrenceUntilDate.trim() : null;

    // UPDATE
    if (id !== undefined && id !== null && String(id).trim() !== "") {
      const eventId = parseInt(String(id).trim(), 10);
      if (Number.isNaN(eventId)) return res.status(400).send("Invalid ID.");

      const finalSlug = await ensureUniqueSlug(baseSlug, eventId);

      const result = await run(
        `UPDATE events
         SET city=?,
             slug=?,
             title=?,
             description=?,
             eventDetails=?,
             goodToKnow=?,
             ticketUrl=?,
             ticketLabel=?,
             startDateTime=?,
             endDateTime=?,
             location=?,
             organizer=?,
             imageUrl=?,
             categories=?,
             featured=?,

             hasRecurrence=?,
             recurrenceRule=?,
             recurrenceDates=?,
             recurrenceStartDate=?,
             recurrenceUntilDate=?,

             updatedAt=datetime('now')
         WHERE id=?`,
        [
          city,
          finalSlug,
          title,
          description,
          eventDetails || null,
          goodToKnow || null,
          ticketUrl || null,
          finalTicketLabel,
          startDateTime,
          endDateTime,
          location,
          organizer,
          imageUrl || null,
          catsJson,
          featuredFlag,

          hasRecurrenceFlag,
          recurrenceRuleJson,
          recurrenceDatesJson,
          recStart,
          recUntil,

          eventId,
        ]
      );

      if (result && typeof result.changes === "number" && result.changes === 0) {
        return res.status(404).send("Event not found (ID does not exist).");
      }

      return res.redirect(`/admin?edit=${eventId}&saved=1`);
    }

    // INSERT
    const finalSlug = await ensureUniqueSlug(baseSlug);

    const result = await run(
      `INSERT INTO events (
        city, slug, title, description, eventDetails, goodToKnow,
        ticketUrl, ticketLabel,
        startDateTime, endDateTime, location, organizer,
        imageUrl, categories,
        featured,

        hasRecurrence, recurrenceRule, recurrenceDates, recurrenceStartDate, recurrenceUntilDate,

        updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        city,
        finalSlug,
        title,
        description,
        eventDetails || null,
        goodToKnow || null,
        ticketUrl || null,
        finalTicketLabel,
        startDateTime,
        endDateTime,
        location,
        organizer,
        imageUrl || null,
        catsJson,
        featuredFlag,

        hasRecurrenceFlag,
        recurrenceRuleJson,
        recurrenceDatesJson,
        recStart,
        recUntil,
      ]
    );

    return res.redirect(`/admin?edit=${result.lastID}&saved=1`);
  } catch (err) {
    console.error("[ADMIN] POST /admin/events error:", err);
    res.status(500).send("Server error.");
  }
});

// POST /admin/events/:id/delete
router.post("/events/:id/delete", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    await run("DELETE FROM events WHERE id = ?", [id]);
    res.redirect("/admin");
  } catch (err) {
    console.error("[ADMIN] DELETE error:", err);
    res.status(500).send("Server error.");
  }
});

module.exports = router;
