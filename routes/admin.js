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
// IMPORTANT: use repo-root /uploads (opencircle-api/uploads)
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

  const offsetMin = -d.getTimezoneOffset(); // minutes east of UTC
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

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// GET /admin
router.get("/", async (req, res) => {
  try {
    const events = await all(
      "SELECT id, slug, title, startDateTime, location, featured FROM events ORDER BY startDateTime DESC LIMIT 50"
    );

    const editId = req.query.edit ? parseInt(req.query.edit, 10) : null;
    let editEvent = null;

    if (editId) editEvent = await get("SELECT * FROM events WHERE id = ?", [editId]);

    const selectedCats = normalizeCategories(parseStoredCategories(editEvent?.categories));
    const isFeatured = Number(editEvent?.featured || 0) === 1;

    const hasRecurrence = Number(editEvent?.hasRecurrence || 0) === 1;
    const rule = parseStoredRule(editEvent?.recurrenceRule) || { type: "none", interval: 1 };
    const ruleType = String(rule.type || (hasRecurrence ? "weekly" : "none")).toLowerCase();
    const customDates = parseStoredDates(editEvent?.recurrenceDates);

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
          .map(
            (e) => `
          <div class="event-card">
            <div class="event-title">#${e.id} — ${esc(e.title)} ${
              Number(e.featured || 0) === 1 ? `<span class="pill" style="margin-left:8px;">Featured</span>` : ""
            }</div>
            <div class="event-meta">
              <div><strong>Slug:</strong> ${esc(e.slug || "")}</div>
              <div><strong>Start:</strong> ${esc(e.startDateTime)}</div>
              <div><strong>Location:</strong> ${esc(e.location)}</div>
            </div>
            <div class="event-actions">
              <a href="${e.slug ? `/events/slug/${esc(e.slug)}` : `/events/${e.id}`}" target="_blank" rel="noopener">
                View JSON
              </a>
              <a href="/admin?edit=${e.id}">Edit</a>

              <!-- FIXED: delete goes to /admin/events/:id/delete -->
              <form method="POST" action="/admin/events/${e.id}/delete" class="inline">
                <button type="submit" class="btn btn-danger">Delete</button>
              </form>
            </div>
          </div>
        `
          )
          .join("")
      : `<div class="muted">No events yet.</div>`;

    res.send(`
<!doctype html>
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
        --brand:#3fabd1; --brand2:#1b7ea8; --danger:#ef4444;
        --shadow:0 10px 30px rgba(0,0,0,.35);
        --radius:14px;
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
      .brand img{ height:42px; width:auto; display:block; }
      .brand-title{ font-size:18px; font-weight:700; line-height:1; }
      .pill{
        font-size:12px; color: var(--text);
        background: rgba(63,171,209,.15);
        border: 1px solid rgba(63,171,209,.35);
        padding:6px 10px; border-radius:999px; font-weight:600;
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

      label{ display:block; margin: 12px 0 6px; font-weight:700; font-size:13px; }
      .ctrl, input, textarea, select{
        width:100%; padding: 10px 12px; border: 1px solid rgba(148,163,184,.25);
        border-radius: 12px; background:#0b1220; color: var(--text); font-size: 14px; outline: none;
      }
      textarea{ min-height: 110px; resize: vertical; }
      .note{ font-size: 12px; color: var(--muted); margin-top:8px; }
      .btn{
        display:inline-flex; align-items:center; justify-content:center;
        padding: 10px 14px; border-radius: 12px;
        border: 1px solid rgba(148,163,184,.22);
        background:#0b1220; cursor:pointer; font-weight:700; text-decoration:none; color: var(--text);
      }
      .btn-primary{ background: var(--brand); border-color: var(--brand); color:#06202b; }
      .btn-primary:hover{ background: var(--brand2); border-color: var(--brand2); color:#071c24; }
      .btn-danger{ background: rgba(239,68,68,.12); border-color: rgba(239,68,68,.25); color: #fecaca; }
      .btn-link{ background: transparent; border-color: transparent; color: var(--brand); padding: 8px 10px; }
      .actions{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top: 14px; }

      .event-card{ border: 1px solid var(--line); border-radius: 14px; padding: 14px; background: #0b1220; }
      .event-title{ font-weight:800; margin-bottom:6px; }
      .event-meta{ color: var(--muted); font-size: 13px; display:grid; gap:4px; }
      .event-actions{ margin-top:10px; display:flex; gap:12px; align-items:center; flex-wrap:wrap; }

      a{ color: var(--brand); text-decoration:none; font-weight:700; }
      a:hover{ text-decoration:underline; }
      .inline{ display:inline; margin:0; }
      .muted{ color: var(--muted); }

      .cat-grid{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; }
      @media (max-width: 900px){ .cat-grid{ grid-template-columns: 1fr; } }

      .rec-box{
        border:1px solid var(--line);
        border-radius: 14px;
        padding: 14px;
        background: #0b1220;
        margin-top: 10px;
      }
      .rec-row{
        display:grid;
        grid-template-columns: 1fr 1fr;
        gap:12px;
        align-items:end;
      }
      @media (max-width: 900px){ .rec-row{ grid-template-columns: 1fr; } }

      .checkbox{ display:flex; gap:10px; align-items:center; margin-top: 8px; font-weight:700; }
      .checkbox input{ width:auto; }

      .chips{ display:flex; flex-wrap:wrap; gap:8px; margin-top: 10px; }
      .chip{
        display:inline-flex; align-items:center; gap:8px;
        border:1px solid var(--line);
        border-radius:999px;
        padding: 6px 10px;
        background: #0b1220;
        font-size: 13px;
      }
      .chip button{ border:0; background: transparent; cursor:pointer; font-weight:900; color: #fecaca; }
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

        <!-- IMPORTANT: enctype is required for file uploads -->
        <form method="POST" action="/admin/events" enctype="multipart/form-data">
          ${editEvent ? `<input type="hidden" name="id" value="${esc(editEvent.id)}" />` : ""}

          <label>City</label>
          <input class="ctrl" name="city" value="${esc(editEvent?.city || "Enumclaw")}" />

          <div class="rec-box">
            <div class="checkbox">
              <input type="checkbox" id="featured" name="featured" value="1" ${isFeatured ? "checked" : ""} />
              <label for="featured" style="margin:0;font-size:13px;font-weight:900;">Mark as Featured Event</label>
            </div>
            <div class="note">Featured events show a badge on the event card and event page.</div>
          </div>

          <div class="rec-box">
            <div style="font-weight:900; margin-bottom:6px;">Categories (pick up to 3)</div>
            <div class="cat-grid">
              <div><div class="muted" style="font-size:12px; margin-bottom:6px;">Category 1</div>${categorySelect(0)}</div>
              <div><div class="muted" style="font-size:12px; margin-bottom:6px;">Category 2</div>${categorySelect(1)}</div>
              <div><div class="muted" style="font-size:12px; margin-bottom:6px;">Category 3</div>${categorySelect(2)}</div>
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

          <div class="row">
            <div>
              <label>Start Date/Time</label>
              <input id="startDateTime" class="ctrl" type="datetime-local" name="startDateTime"
                value="${esc(toDateTimeLocalValue(editEvent?.startDateTime))}" required />
            </div>
            <div>
              <label>End Date/Time</label>
              <input id="endDateTime" class="ctrl" type="datetime-local" name="endDateTime"
                value="${esc(toDateTimeLocalValue(editEvent?.endDateTime))}" required />
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
        <h1 style="margin-bottom:10px;">Existing Events (latest 50)</h1>
        <div style="display:grid; gap:12px;">${listHtml}</div>
      </div>
    </div>
             <script>
    (function(){
      var startEl = document.getElementById('startDateTime');
      var endEl   = document.getElementById('endDateTime');
      if(!startEl || !endEl) return;

      function pad(n){ return String(n).padStart(2,'0'); }

      function addHours(dtLocal, hours){
        if(!dtLocal) return '';
        var d = new Date(dtLocal);
        if (isNaN(d.getTime())) return '';
        d.setHours(d.getHours() + hours);
        return d.getFullYear() + '-' +
          pad(d.getMonth()+1) + '-' +
          pad(d.getDate()) + 'T' +
          pad(d.getHours()) + ':' +
          pad(d.getMinutes());
      }

      function maybeSetEnd(){
        var s = startEl.value;
        if(!s) return;
        var sTime = new Date(s).getTime();
        var eTime = endEl.value ? new Date(endEl.value).getTime() : NaN;

        // only auto-fill if empty/invalid or <= start
        if(!endEl.value || !isFinite(eTime) || eTime <= sTime){
          endEl.value = addHours(s, 2);
        }
      }

      startEl.addEventListener('change', maybeSetEnd);
      startEl.addEventListener('blur', maybeSetEnd);
      maybeSetEnd();
    })();
    </script>

  </body>
</html>
    `);
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
    } = req.body;

    // If a file was uploaded, prefer it over the URL field
    if (req.file && req.file.filename) {
      const proto = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["x-forwarded-host"] || req.get("host");
      imageUrl = `${proto}://${host}/uploads/${req.file.filename}`;
    }

    const featuredFlag = String(featured || "") === "1" ? 1 : 0;

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
          eventId,
        ]
      );

      if (result && typeof result.changes === "number" && result.changes === 0) {
        return res.status(404).send("Event not found (ID does not exist).");
      }

      return res.redirect(`/admin?edit=${result.lastID}`);
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
        updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
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
      ]
    );

    res.redirect(`/events/${result.lastID}`);
  } catch (err) {
    console.error(err);
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
    console.error(err);
    res.status(500).send("Server error.");
  }
});

module.exports = router;
