"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const { all, get, run, slugify, ensureUniqueSlug } = require("../db");

const router = express.Router();

// ---------------- Uploads ----------------
const UPLOADS_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.RENDER_DISK_PATH
    ? path.join(process.env.RENDER_DISK_PATH, "uploads")
    : path.join(process.cwd(), "uploads"));

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    const safeExt = ext && ext.length <= 10 ? ext : "";
    const name = `flyer_${Date.now()}_${Math.random().toString(16).slice(2)}${safeExt}`;
    cb(null, name);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ---------------- Helpers ----------------
function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function safeJsonParse(v, fallback) {
  try {
    if (!v) return fallback;
    return typeof v === "string" ? JSON.parse(v) : v;
  } catch (_) {
    return fallback;
  }
}

function readRecurrenceFromBody(body) {
  const hasRecurrence = body.hasRecurrence === "1" || body.hasRecurrence === "on";
  if (!hasRecurrence) {
    return { hasRecurrence: 0, recurrenceRule: null, recurrenceDates: null };
  }

  const type = String(body.recurrenceType || "none");
  const interval = Math.max(1, parseInt(body.recurrenceInterval || "1", 10) || 1);

  // Weekly BYDAY: multiple values
  const weeklyByDay = ([]
    .concat(body.weeklyByDay || [])
    .map((d) => String(d).toUpperCase())
    .filter(Boolean));

  // Monthly
  const monthlyMode = String(body.monthlyMode || "monthday");
  const byMonthday = parseInt(body.byMonthday || "1", 10) || 1;
  const setPos = parseInt(body.setPos || "1", 10) || 1;
  const monthlyByDay = String(body.monthlyByDay || "MO").toUpperCase();

  // Custom dates array
  const customDates = ([]
    .concat(body.recurrenceDates || [])
    .map((d) => String(d).trim())
    .filter(Boolean));

  const rule = { type, interval };

  if (type === "weekly") {
    rule.byDay = weeklyByDay.length ? weeklyByDay : ["MO"]; // default Monday
  }

  if (type === "monthly") {
    rule.mode = monthlyMode;
    if (monthlyMode === "nthweekday") {
      rule.setPos = setPos; // e.g. 1,2,3,4,-1
      rule.byDay = monthlyByDay; // e.g. TH
    } else {
      rule.byMonthday = Math.min(31, Math.max(1, byMonthday));
    }
  }

  if (type === "custom") {
    // store custom dates in recurrenceDates column (rule still describes type)
  }

  return {
    hasRecurrence: 1,
    recurrenceRule: JSON.stringify(rule),
    recurrenceDates: type === "custom" ? JSON.stringify(customDates) : null,
  };
}

// ---------------- Routes ----------------
router.get("/", async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page || "1", 10) || 1);
    const perPage = 25;
    const offset = (page - 1) * perPage;

    const rowCount = await get("SELECT COUNT(*) AS c FROM events", []);
    const total = rowCount?.c || 0;

    const rows = await all(
      `SELECT id, slug, city, title, startDateTime, endDateTime, location, organizer, imageUrl, featured,
              hasRecurrence, recurrenceRule, recurrenceDates
         FROM events
        ORDER BY datetime(startDateTime) DESC
        LIMIT ? OFFSET ?`,
      [perPage, offset]
    );

    const totalPages = Math.max(1, Math.ceil(total / perPage));

    // basic page
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>OpenCircle Admin</title>
  <style>
    :root{ --r:4px; --b:#1c2230; --fg:#e9eefb; --mut:#a9b3c9; --card:#0f1522; --line:rgba(255,255,255,.10); }
    body{ margin:0; font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0f19; color:var(--fg); }
    .wrap{ max-width:1100px; margin:0 auto; padding:24px; }
    h1{ margin:0 0 14px; font-size:24px; }
    .card{ background:linear-gradient(180deg, rgba(255,255,255,.06), rgba(255,255,255,.03)); border:1px solid var(--line); border-radius:var(--r); padding:16px; margin-bottom:18px; }
    .grid2{ display:grid; grid-template-columns: 1fr 1fr; gap:14px; }
    @media (max-width: 900px){ .grid2{ grid-template-columns:1fr; } }
    label{ display:block; font-size:12px; color:var(--mut); margin:10px 0 6px; }
    input, textarea, select{ width:100%; background:rgba(0,0,0,.25); color:var(--fg); border:1px solid var(--line); border-radius:var(--r); padding:10px; outline:none; }
    textarea{ min-height:90px; resize:vertical; }
    .row{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
    .btn{ background:#00c08b; border:0; color:#081018; font-weight:800; border-radius:var(--r); padding:10px 14px; cursor:pointer; }
    .btn.secondary{ background:rgba(255,255,255,.10); color:var(--fg); border:1px solid var(--line); }
    .btn.danger{ background:rgba(255,255,255,.06); color:#ffb1b1; border:1px solid rgba(255,80,80,.45); }
    .small{ font-size:12px; color:var(--mut); }
    .events-head{ display:flex; align-items:baseline; justify-content:space-between; gap:12px; }
    table{ width:100%; border-collapse:collapse; }
    th,td{ padding:10px; border-bottom:1px solid var(--line); text-align:left; font-size:13px; vertical-align:top; }
    th{ color:var(--mut); font-weight:700; }
    .thumb{ width:110px; height:62px; object-fit:cover; border-radius:var(--r); border:1px solid var(--line); background:#111; }
    .pill{ display:inline-block; padding:3px 8px; border-radius:999px; border:1px solid var(--line); font-size:11px; color:var(--mut); }
    .rec-box{ margin-top:10px; padding:12px; border:1px solid var(--line); border-radius:var(--r); background:rgba(0,0,0,.20); }
    .checkbox{ display:flex; gap:10px; align-items:center; }
    .checkbox input{ width:auto; }
    .note{ font-size:12px; color:var(--mut); margin-top:6px; }
    .rec-row{ display:grid; grid-template-columns: 1fr 1fr; gap:14px; align-items:start; }
    @media (max-width: 900px){ .rec-row{ grid-template-columns:1fr; } }
    .days{ display:flex; flex-wrap:wrap; gap:10px; }
    .day{ display:flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:var(--r); padding:8px 10px; background:rgba(255,255,255,.04); }
    .day input{ width:auto; }
    .chips{ display:flex; flex-wrap:wrap; gap:10px; }
    .chip{ display:flex; gap:8px; align-items:center; border:1px solid var(--line); border-radius:var(--r); padding:8px; background:rgba(255,255,255,.04); }
    .chip input{ width:170px; padding:8px; }
    .chip button{ width:32px; height:32px; border-radius:var(--r); border:1px solid var(--line); background:rgba(0,0,0,.25); color:var(--fg); cursor:pointer; }
    .pagination{ display:flex; gap:8px; align-items:center; justify-content:flex-end; margin-top:12px; }
    .pagination a{ color:var(--fg); text-decoration:none; padding:6px 10px; border:1px solid var(--line); border-radius:var(--r); }
    .pagination a.is-active{ background:rgba(255,255,255,.10); }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>OpenCircle Admin</h1>

    <div class="card">
      <h2 style="margin:0 0 10px; font-size:16px;">Add event</h2>
      <form action="/admin/events" method="post" enctype="multipart/form-data">
        <div class="grid2">
          <div>
            <label>City</label>
            <input name="city" value="Enumclaw" />
          </div>
          <div>
            <label>Organizer</label>
            <input name="organizer" placeholder="Organizer" required />
          </div>
        </div>

        <label>Title</label>
        <input name="title" placeholder="Event title" required />

        <label>Description</label>
        <textarea name="description" placeholder="Short description" required></textarea>

        <div class="grid2">
          <div>
            <label>Start date/time</label>
            <input type="datetime-local" name="startDateTime" required />
          </div>
          <div>
            <label>End date/time</label>
            <input type="datetime-local" name="endDateTime" required />
          </div>
        </div>

        <label>Location</label>
        <input name="location" placeholder="Location" required />

        <div class="grid2">
          <div>
            <label>Ticket URL</label>
            <input name="ticketUrl" placeholder="https://" />
          </div>
          <div>
            <label>Ticket label</label>
            <input name="ticketLabel" placeholder="Buy tickets" />
          </div>
        </div>

        <div class="grid2">
          <div>
            <label>Flyer image (upload)</label>
            <input type="file" name="flyer" accept="image/*" />
            <div class="note">Uploads go to ${esc(UPLOADS_DIR)} and are served at /uploads/...</div>
          </div>
          <div>
            <label>Or Image URL (optional)</label>
            <input name="imageUrl" placeholder="https://..." />
          </div>
        </div>

        <div class="rec-box">
          <div class="checkbox">
            <input type="checkbox" id="hasRecurrence" name="hasRecurrence" value="1" />
            <label for="hasRecurrence" style="margin:0;font-size:13px;font-weight:900;color:var(--fg);">Recurring Event</label>
          </div>
          <div class="note">Create a recurring rule (weekly/monthly) or a custom date list.</div>

          <div class="rec-row" style="margin-top:10px;">
            <div>
              <label style="margin-top:0;">Recurrence Type</label>
              <select id="recurrenceType" name="recurrenceType">
                <option value="none">None</option>
                <option value="weekly">Weekly</option>
                <option value="monthly">Monthly</option>
                <option value="custom">Custom Dates</option>
              </select>
            </div>
            <div id="intervalRow">
              <label style="margin-top:0;">Interval</label>
              <input type="number" min="1" name="recurrenceInterval" value="1" />
              <div class="note">Example: every 1 week, every 2 weeks, every 1 month, etc.</div>
            </div>
          </div>

          <div id="weeklyBox" style="margin-top:10px;">
            <label>Days of Week</label>
            <div class="days">
              ${["SU","MO","TU","WE","TH","FR","SA"].map(d=>{
                const label = ({SU:"Sun",MO:"Mon",TU:"Tue",WE:"Wed",TH:"Thu",FR:"Fri",SA:"Sat"})[d];
                return `<label class="day"><input type="checkbox" name="weeklyByDay" value="${d}" />${label}</label>`;
              }).join("")}
            </div>
            <div class="note">Pick one or more days.</div>
          </div>

          <div id="monthlyBox" style="margin-top:10px;">
            <div class="rec-row">
              <div>
                <label>Monthly Mode</label>
                <select id="monthlyMode" name="monthlyMode">
                  <option value="monthday">On day of month</option>
                  <option value="nthweekday">On nth weekday</option>
                </select>
              </div>
              <div></div>
            </div>

            <div id="monthdayBox" style="margin-top:10px;">
              <label>Day of Month (1–31)</label>
              <input type="number" min="1" max="31" name="byMonthday" value="1" />
            </div>

            <div id="nthweekdayBox" style="margin-top:10px; display:none;">
              <div class="rec-row">
                <div>
                  <label>Which Week</label>
                  <select name="setPos">
                    <option value="1">1st</option>
                    <option value="2">2nd</option>
                    <option value="3">3rd</option>
                    <option value="4">4th</option>
                    <option value="-1">Last</option>
                  </select>
                </div>
                <div>
                  <label>Weekday</label>
                  <select name="monthlyByDay">
                    <option value="SU">Sunday</option>
                    <option value="MO">Monday</option>
                    <option value="TU">Tuesday</option>
                    <option value="WE">Wednesday</option>
                    <option value="TH">Thursday</option>
                    <option value="FR">Friday</option>
                    <option value="SA">Saturday</option>
                  </select>
                </div>
              </div>
              <div class="note">Example: 1st Thursday, Last Monday, etc.</div>
            </div>
          </div>

          <div id="customBox" style="margin-top:10px; display:none;">
            <label>Custom Dates</label>
            <div class="note">Add specific dates (YYYY-MM-DD). Time comes from the Start/End above.</div>
            <div id="customDatesWrap" class="chips"></div>
            <div style="margin-top:10px;">
              <button id="addCustomDate" type="button" class="btn secondary">+ Add Date</button>
            </div>
          </div>
        </div>

        <div class="row" style="margin-top:14px;">
          <button class="btn" type="submit">Save event</button>
        </div>
      </form>
    </div>

    <div class="card">
      <div class="events-head">
        <h2 style="margin:0; font-size:16px;">Existing events <span class="pill">${total} total</span></h2>
        <div class="small">Page ${page} of ${totalPages}</div>
      </div>

      <div style="overflow:auto; margin-top:10px;">
        <table>
          <thead>
            <tr>
              <th>Image</th>
              <th>Title</th>
              <th>Start</th>
              <th>City</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rows.map(r => {
              const img = r.imageUrl ? esc(r.imageUrl) : "";
              const rec = r.hasRecurrence ? "<span class=\"pill\">recurring</span>" : "";
              return `
              <tr>
                <td>${img ? `<img class="thumb" src="${img}" alt="" />` : "<span class=\"small\">—</span>"}</td>
                <td><strong>${esc(r.title)}</strong> ${rec}<div class="small">${esc(r.location || "")}</div></td>
                <td>${esc(r.startDateTime)}</td>
                <td>${esc(r.city || "")}</td>
                <td>
                  <form action="/admin/events/${r.id}/delete" method="post" style="margin:0" onsubmit="return confirm('Delete this event?');">
                    <button class="btn danger" type="submit">Delete</button>
                  </form>
                </td>
              </tr>`;
            }).join("")}
          </tbody>
        </table>
      </div>

      <div class="pagination">
        ${Array.from({length: totalPages}).slice(0, 12).map((_, i) => {
          const p = i + 1;
          const cls = p === page ? "is-active" : "";
          return `<a class="${cls}" href="/admin?page=${p}">${p}</a>`;
        }).join(" ")}
      </div>
    </div>

  </div>

<script>
(function(){
  const hasRec = document.getElementById('hasRecurrence');
  const typeSel = document.getElementById('recurrenceType');
  const weeklyBox = document.getElementById('weeklyBox');
  const monthlyBox = document.getElementById('monthlyBox');
  const customBox = document.getElementById('customBox');
  const intervalRow = document.getElementById('intervalRow');
  const monthlyMode = document.getElementById('monthlyMode');
  const monthdayBox = document.getElementById('monthdayBox');
  const nthweekdayBox = document.getElementById('nthweekdayBox');
  const wrap = document.getElementById('customDatesWrap');
  const addBtn = document.getElementById('addCustomDate');

  function applyVisibility(){
    const enabled = !!hasRec.checked;
    weeklyBox.style.display = 'none';
    monthlyBox.style.display = 'none';
    customBox.style.display = 'none';
    intervalRow.style.display = 'block';

    if(!enabled){
      intervalRow.style.display = 'none';
      return;
    }

    const t = typeSel.value;
    if(t === 'weekly') weeklyBox.style.display = '';
    if(t === 'monthly') monthlyBox.style.display = '';
    if(t === 'custom'){
      customBox.style.display = '';
      intervalRow.style.display = 'none';
    }
  }

  function applyMonthlyMode(){
    const mode = monthlyMode.value;
    if(mode === 'nthweekday'){
      monthdayBox.style.display = 'none';
      nthweekdayBox.style.display = '';
    }else{
      monthdayBox.style.display = '';
      nthweekdayBox.style.display = 'none';
    }
  }

  function addDate(value=''){
    const span = document.createElement('span');
    span.className = 'chip';
    span.innerHTML =
      '<input type="date" name="recurrenceDates" value="' + (value || '') + '">' +
      '<button type="button" aria-label="Remove">×</button>';
    span.querySelector('button').addEventListener('click', ()=> span.remove());
    wrap.appendChild(span);
  }

  hasRec.addEventListener('change', applyVisibility);
  typeSel.addEventListener('change', applyVisibility);
  monthlyMode.addEventListener('change', applyMonthlyMode);
  addBtn.addEventListener('click', ()=> addDate(''));

  applyVisibility();
  applyMonthlyMode();
})();
</script>
</body>
</html>`);
  } catch (err) {
    console.error("[ADMIN] GET /admin failed", err);
    res.status(500).send("Internal server error");
  }
});

router.post("/events", upload.single("flyer"), async (req, res) => {
  try {
    const b = req.body || {};

    const title = String(b.title || "").trim();
    const description = String(b.description || "").trim();
    const city = String(b.city || "").trim();
    const location = String(b.location || "").trim();
    const organizer = String(b.organizer || "").trim();
    const startDateTime = String(b.startDateTime || "").trim();
    const endDateTime = String(b.endDateTime || "").trim();

    if (!title || !description || !location || !organizer || !startDateTime || !endDateTime) {
      return res.status(400).send("Missing required fields");
    }

    // image: prefer uploaded file if present
    let imageUrl = String(b.imageUrl || "").trim();
    if (req.file && req.file.filename) {
      imageUrl = `/uploads/${req.file.filename}`;
    }

    const ticketUrl = String(b.ticketUrl || "").trim();
    const ticketLabel = String(b.ticketLabel || "").trim();

    const baseSlug = slugify(b.slug || title);
    const slug = await ensureUniqueSlug(baseSlug);

    const rec = readRecurrenceFromBody(b);

    await run(
      `INSERT INTO events (
        slug, city, title, description,
        startDateTime, endDateTime,
        location, organizer,
        imageUrl, ticketUrl, ticketLabel,
        featured,
        hasRecurrence, recurrenceRule, recurrenceDates
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        slug,
        city,
        title,
        description,
        startDateTime,
        endDateTime,
        location,
        organizer,
        imageUrl || null,
        ticketUrl || null,
        ticketLabel || null,
        0,
        rec.hasRecurrence,
        rec.recurrenceRule,
        rec.recurrenceDates,
      ]
    );

    res.redirect("/admin");
  } catch (err) {
    console.error("[ADMIN] POST /admin/events failed", err);
    res.status(500).send("Internal server error");
  }
});

router.post("/events/:id/delete", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return res.redirect("/admin");

    // NOTE: we do NOT delete the file from disk automatically.
    // That prevents accidental loss and keeps image persistence safe.
    await run("DELETE FROM events WHERE id = ?", [id]);

    res.redirect("/admin");
  } catch (err) {
    console.error("[ADMIN] DELETE failed", err);
    res.status(500).send("Internal server error");
  }
});

module.exports = router;
