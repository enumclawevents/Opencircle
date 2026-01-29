// routes/admin.js
"use strict";

const express = require("express");
const router = express.Router();
const { run, all, get, slugify } = require("../db");

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
  if (!val) return fallback;
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

  return (
    year +
    "-" +
    month +
    "-" +
    day +
    "T" +
    hours +
    ":" +
    minutes +
    ":" +
    seconds +
    sign +
    offH +
    ":" +
    offM
  );
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

// Ensure slugs are unique
async function ensureUniqueSlug(baseSlug, excludeId = null) {
  let slug = baseSlug || "event";
  let i = 2;

  while (true) {
    const row = excludeId
      ? await get("SELECT id FROM events WHERE slug = ? AND id != ? LIMIT 1", [slug, excludeId])
      : await get("SELECT id FROM events WHERE slug = ? LIMIT 1", [slug]);

    if (!row) return slug;
    slug = `${baseSlug}-${i++}`;
  }
}

// GET /admin
router.get("/", async (req, res) => {
  const events = await all(
    "SELECT id, slug, title, startDateTime, location FROM events ORDER BY startDateTime DESC LIMIT 50"
  );

  const editId = req.query.edit ? parseInt(req.query.edit, 10) : null;
  let editEvent = null;

  if (editId) {
    editEvent = await get("SELECT * FROM events WHERE id = ?", [editId]);
  }

  const selectedCats = normalizeCategories(parseStoredCategories(editEvent?.categories));
  const isFeatured = Number(editEvent?.featured || 0) === 1;
  const hasRecurrence = Number(editEvent?.hasRecurrence || 0) === 1;
  const rule = parseStoredRule(editEvent?.recurrenceRule) || { type: "none", interval: 1 };
  const ruleType = String(rule.type || (hasRecurrence ? "weekly" : "none")).toLowerCase();

  const customDates = parseStoredDates(editEvent?.recurrenceDates);

  // Category dropdowns (3)
  const categorySelect = (idx) => {
    const current = selectedCats[idx] || "";
    return `
      <select name="categories" class="ctrl">
        <option value="">— None —</option>
        ${ALLOWED_CATEGORIES.map((c) => {
          const sel = current === c ? "selected" : "";
          return `<option value="${esc(c)}" ${sel}>${esc(c)}</option>`;
        }).join("")}
      </select>
    `;
  };

  const listHtml = events.length
    ? events
        .map(
          (e) => `
        <div class="event-card">
          <div class="event-title">#${e.id} — ${esc(e.title)}</div>
          <div class="event-meta">
            <div><strong>Slug:</strong> ${esc(e.slug || "")}</div>
            <div><strong>Start:</strong> ${esc(e.startDateTime)}</div>
            <div><strong>Location:</strong> ${esc(e.location)}</div>
          </div>
          <div class="event-actions">
            <a href="/events/${e.id}" target="_blank" rel="noopener">View JSON (id)</a>
            ${e.slug ? `<a href="/events/slug/${esc(e.slug)}" target="_blank" rel="noopener">View JSON (slug)</a>` : ""}
            <a href="/admin?edit=${e.id}">Edit</a>
            <form method="POST" action="/admin/events/${e.id}/delete" class="inline"
              onsubmit="return confirm('Delete event #${e.id}?');">
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
        --bg:#f3f4f6;
        --card:#ffffff;
        --text:#0f172a;
        --muted:#475569;
        --line:rgba(15, 23, 42, .12);
        --brand:#3fabd1;
        --brand2:#1b7ea8;
        --danger:#ef4444;
        --shadow:0 10px 30px rgba(2, 6, 23, .08);
        --radius:14px;
      }
      *{ box-sizing:border-box; }
      body{
        margin:0;
        background:var(--bg);
        color:var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        padding:24px;
      }
      .wrap{ max-width: 980px; margin: 0 auto; }
      .topbar{
        display:flex; align-items:center; justify-content:space-between;
        gap:16px;
        margin-bottom:18px;
      }
      .brand{ display:flex; align-items:center; gap:12px; }
      .brand img{ height:42px; width:auto; display:block; }
      .brand-title{ font-size:18px; font-weight:700; line-height:1; }
      .pill{
        font-size:12px; color: #0b1220;
        background: rgba(63,171,209,.18);
        border: 1px solid rgba(63,171,209,.35);
        padding:6px 10px;
        border-radius:999px;
        font-weight:600;
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

      label{
        display:block;
        margin: 12px 0 6px;
        font-weight:700;
        font-size:13px;
      }
      .ctrl, input, textarea, select{
        width:100%;
        padding: 10px 12px;
        border: 1px solid rgba(15, 23, 42, .18);
        border-radius: 12px;
        background:#fff;
        font-size: 14px;
        outline: none;
      }
      textarea{ min-height: 110px; resize: vertical; }
      .note{ font-size: 12px; color: var(--muted); margin-top:8px; }
      .btn{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        padding: 10px 14px;
        border-radius: 12px;
        border: 1px solid rgba(15, 23, 42, .12);
        background:#fff;
        cursor:pointer;
        font-weight:700;
        text-decoration:none;
        color: var(--text);
      }
      .btn-primary{
        background: var(--brand);
        border-color: var(--brand);
        color:#fff;
      }
      .btn-primary:hover{ background: var(--brand2); border-color: var(--brand2); }
      .btn-danger{
        background: rgba(239,68,68,.12);
        border-color: rgba(239,68,68,.25);
        color: #991b1b;
      }
      .btn-link{
        background: transparent;
        border-color: transparent;
        color: var(--brand2);
        padding: 8px 10px;
      }
      .actions{
        display:flex; gap:10px; align-items:center; flex-wrap:wrap;
        margin-top: 14px;
      }

      .event-card{
        border: 1px solid var(--line);
        border-radius: 14px;
        padding: 14px;
        background: #fff;
      }
      .event-title{ font-weight:800; margin-bottom:6px; }
      .event-meta{ color: var(--muted); font-size: 13px; display:grid; gap:4px; }
      .event-actions{
        margin-top:10px;
        display:flex; gap:12px; align-items:center; flex-wrap:wrap;
      }
      a{ color: var(--brand2); text-decoration:none; font-weight:700; }
      a:hover{ text-decoration:underline; }
      .inline{ display:inline; margin:0; }
      .muted{ color: var(--muted); }

      .cat-grid{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; }
      @media (max-width: 900px){ .cat-grid{ grid-template-columns: 1fr; } }

      .rec-box{
        border:1px solid var(--line);
        border-radius: 14px;
        padding: 14px;
        background: #fff;
        margin-top: 10px;
      }
      .rec-row{
        display:grid;
        grid-template-columns: 1fr 1fr;
        gap:12px;
        align-items:end;
      }
      @media (max-width: 900px){ .rec-row{ grid-template-columns: 1fr; } }

      .checkbox{
        display:flex; gap:10px; align-items:center;
        margin-top: 8px;
        font-weight:700;
      }
      .checkbox input{ width:auto; }

      .chips{ display:flex; flex-wrap:wrap; gap:8px; margin-top: 10px; }
      .chip{
        display:inline-flex; align-items:center; gap:8px;
        border:1px solid var(--line);
        border-radius:999px;
        padding: 6px 10px;
        background: #fff;
        font-size: 13px;
      }
      .chip button{
        border:0; background: transparent; cursor:pointer;
        font-weight:900; color: #991b1b;
      }
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
        <p class="sub">
          <a href="/events" target="_blank" rel="noopener">View all events (JSON)</a>
        </p>

        <form method="POST" action="/admin/events">
          ${editEvent ? `<input type="hidden" name="id" value="${esc(editEvent.id)}" />` : ""}

          <label>City</label>
          <input class="ctrl" name="city" value="${esc(editEvent?.city || "Enumclaw")}" />
          <div class="rec-box">
  <div class="checkbox">
    <input
      type="checkbox"
      id="isFeatured"
      name="isFeatured"
      value="1"
      <?php echo !empty($editEvent?.isFeatured) ? 'checked' : ''; ?>
    />
    <label for="isFeatured" style="margin:0;font-size:13px;font-weight:900;">
      Mark as Featured Event
    </label>
  </div>

  <div class="note">
    Featured events show a badge on the event card and event page.
  </div>
</div>

          <div class="rec-box">
            <div style="font-weight:900; margin-bottom:6px;">Categories (pick up to 3)</div>
            <div class="cat-grid">
              <div>
                <div class="muted" style="font-size:12px; margin-bottom:6px;">Category 1</div>
                ${categorySelect(0)}
              </div>
              <div>
                <div class="muted" style="font-size:12px; margin-bottom:6px;">Category 2</div>
                ${categorySelect(1)}
              </div>
              <div>
                <div class="muted" style="font-size:12px; margin-bottom:6px;">Category 3</div>
                ${categorySelect(2)}
              </div>
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

          <div class="rec-box">
            <div class="checkbox">
              <input id="hasRecurrence" type="checkbox" name="hasRecurrence" value="1" ${hasRecurrence ? "checked" : ""} />
              <label for="hasRecurrence" style="margin:0; font-size:13px; font-weight:900;">
                Check here if the event has occurrences
              </label>
            </div>

            <div id="intervalRow" class="rec-row" style="margin-top:10px;">
              <div>
                <label style="margin-top:0;">Occurrence Type</label>
                <select id="recurrenceType" name="recurrenceType" class="ctrl">
                  <option value="none" ${ruleType === "none" ? "selected" : ""}>None</option>
                  <option value="weekly" ${ruleType === "weekly" ? "selected" : ""}>Weekly</option>
                  <option value="monthly" ${ruleType === "monthly" ? "selected" : ""}>Monthly</option>
                  <option value="custom" ${ruleType === "custom" ? "selected" : ""}>Custom (pick dates)</option>
                </select>
              </div>

              <div>
                <label style="margin-top:0;">Interval</label>
                <select id="recurrenceInterval" name="recurrenceInterval" class="ctrl">
                  ${[1, 2, 3, 4]
                    .map((n) => {
                      const sel = Number(rule.interval || 1) === n ? "selected" : "";
                      return `<option value="${n}" ${sel}>Every ${n} ${
                        ruleType === "monthly" ? "month(s)" : "week(s)"
                      }</option>`;
                    })
                    .join("")}
                </select>
                <div class="note">Used for Weekly/Monthly only.</div>
              </div>
            </div>

            <div id="weeklyBox" style="margin-top:12px;">
              <label style="margin-top:0;">Weekly: Which days?</label>
              <div class="row" style="grid-template-columns: repeat(7, 1fr); gap:10px;">
                ${["SU", "MO", "TU", "WE", "TH", "FR", "SA"]
                  .map((d) => {
                    const byDay = Array.isArray(rule.byDay) ? rule.byDay : [];
                    const checked = byDay.includes(d) ? "checked" : "";
                    return `
                      <label class="checkbox" style="justify-content:center; margin:0; font-weight:900;">
                        <input type="checkbox" name="weeklyByDay" value="${d}" ${checked}/>
                        <span>${d}</span>
                      </label>
                    `;
                  })
                  .join("")}
              </div>
              <div class="note">Example: Every Wednesday = select WE.</div>
            </div>

            <div id="monthlyBox" style="margin-top:12px;">
              <label style="margin-top:0;">Monthly: Mode</label>
              <select id="monthlyMode" name="monthlyMode" class="ctrl">
                <option value="monthday" ${(rule.mode || "monthday") === "monthday" ? "selected" : ""}>Same day of month (e.g., 15th)</option>
                <option value="nthweekday" ${(rule.mode || "") === "nthweekday" ? "selected" : ""}>Nth weekday (e.g., 1st Thursday)</option>
              </select>

              <div id="monthdayBox" style="margin-top:10px;">
                <label>Day of month</label>
                <input class="ctrl" type="number" min="1" max="31" name="byMonthday" value="${esc(rule.byMonthday || "")}" placeholder="e.g. 15" />
              </div>

              <div id="nthweekdayBox" style="margin-top:10px;">
                <div class="row">
                  <div>
                    <label>Nth</label>
                    <select class="ctrl" name="setPos">
                      ${[
                        ["1", "First"],
                        ["2", "Second"],
                        ["3", "Third"],
                        ["4", "Fourth"],
                        ["-1", "Last"],
                      ]
                        .map(([v, label]) => {
                          const sel = String(rule.setPos ?? "1") === v ? "selected" : "";
                          return `<option value="${v}" ${sel}>${label}</option>`;
                        })
                        .join("")}
                    </select>
                  </div>
                  <div>
                    <label>Weekday</label>
                    <select class="ctrl" name="monthlyByDay">
                      ${[
                        ["SU", "Sunday"],
                        ["MO", "Monday"],
                        ["TU", "Tuesday"],
                        ["WE", "Wednesday"],
                        ["TH", "Thursday"],
                        ["FR", "Friday"],
                        ["SA", "Saturday"],
                      ]
                        .map(([v, label]) => {
                          const sel = String(rule.byDay || "") === v ? "selected" : "";
                          return `<option value="${v}" ${sel}>${label}</option>`;
                        })
                        .join("")}
                    </select>
                  </div>
                </div>
                <div class="note">Example: First Thursday = First + Thursday.</div>
              </div>
            </div>

            <div id="customBox" style="margin-top:12px;">
              <label style="margin-top:0;">Custom dates (pick specific dates)</label>

              <div class="actions" style="margin-top:8px;">
                <button type="button" id="addCustomDate" class="btn">+ Add date</button>
              </div>

              <div id="customDatesWrap" class="chips">
                ${(customDates.length ? customDates : [])
                  .map(
                    (d, i) => `
                    <span class="chip">
                      <input class="ctrl" style="width: 160px; padding:6px 8px; border-radius:10px;"
                        type="date" name="recurrenceDates" value="${esc(d)}" />
                      <button type="button" data-remove-date="${i}" aria-label="Remove">×</button>
                    </span>
                  `
                  )
                  .join("")}
              </div>

              <div class="note">
                These will show on the feed for the next 3 months, and all occurrences link back to the same single event page.
              </div>
            </div>
          </div>

          <label>Image URL (flyer)</label>
          <input class="ctrl" name="imageUrl" value="${esc(editEvent?.imageUrl || "")}" placeholder="https://..." />

          <div class="row">
            <div>
              <label>Ticket Button Text</label>
              <input class="ctrl" name="ticketLabel" value="${esc(editEvent?.ticketLabel || "Tickets")}" placeholder="Tickets / Reserve / Buy Tickets..." />
            </div>
            <div>
              <label>Ticket Link (URL)</label>
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
            ${editEvent ? `<a class="btn btn-link" href="/admin">Cancel</a>` : ""}
            <span class="note">Dates are saved with your server's local timezone offset automatically.</span>
          </div>
        </form>
      </div>

      <div class="card">
        <h1 style="margin-bottom:10px;">Existing Events (latest 50)</h1>
        <div style="display:grid; gap:12px;">
          ${listHtml}
        </div>
      </div>

    </div>

    <script>
      // Auto-fill end time +2 hours if empty
      const startEl = document.getElementById("startDateTime");
      const endEl = document.getElementById("endDateTime");

      if (startEl && endEl) {
        startEl.addEventListener("change", () => {
          if (!startEl.value) return;
          if (!endEl.value) {
            const d = new Date(startEl.value);
            d.setHours(d.getHours() + 2);
            const pad = (n) => String(n).padStart(2, "0");
            endEl.value =
              d.getFullYear() + "-" +
              pad(d.getMonth() + 1) + "-" +
              pad(d.getDate()) + "T" +
              pad(d.getHours()) + ":" +
              pad(d.getMinutes());
          }
        });
      }

      // Recurrence UI logic
      const hasRecEl = document.getElementById("hasRecurrence");
      const typeEl = document.getElementById("recurrenceType");
      const intervalRow = document.getElementById("intervalRow");

      const weeklyBox = document.getElementById("weeklyBox");
      const monthlyBox = document.getElementById("monthlyBox");
      const customBox = document.getElementById("customBox");

      const monthlyModeEl = document.getElementById("monthlyMode");
      const monthdayBox = document.getElementById("monthdayBox");
      const nthweekdayBox = document.getElementById("nthweekdayBox");

      function show(el, on) {
        if (!el) return;
        el.style.display = on ? "" : "none";
      }

      function syncRecurrenceUI() {
  const enabled = !!(hasRecEl && hasRecEl.checked);
  const t = (typeEl ? typeEl.value : "none");

  // If not enabled, hide everything
  if (!enabled) {
    show(intervalRow, false);
    show(weeklyBox, false);
    show(monthlyBox, false);
    show(customBox, false);
    return;
  }

  // Enabled: ALWAYS show the row that contains "Occurrence Type"
  show(intervalRow, true);

  // Show rule-specific sections
  show(weeklyBox, t === "weekly");
  show(monthlyBox, t === "monthly");
  show(customBox, t === "custom");

  // Monthly sub-mode switching
  if (t === "monthly") {
    const mm = monthlyModeEl ? monthlyModeEl.value : "monthday";
    show(monthdayBox, mm === "monthday");
    show(nthweekdayBox, mm === "nthweekday");
  } else {
    // If not monthly, hide monthly sub-boxes so they don't flicker
    show(monthdayBox, false);
    show(nthweekdayBox, false);
  }
}


      if (hasRecEl) hasRecEl.addEventListener("change", syncRecurrenceUI);
      if (typeEl) typeEl.addEventListener("change", syncRecurrenceUI);
      if (monthlyModeEl) monthlyModeEl.addEventListener("change", syncRecurrenceUI);
      syncRecurrenceUI();

      // Custom dates add/remove
      const addBtn = document.getElementById("addCustomDate");
      const wrap = document.getElementById("customDatesWrap");

      function attachRemoveHandlers() {
        if (!wrap) return;
        wrap.querySelectorAll("button[data-remove-date]").forEach((btn) => {
          btn.onclick = () => {
            const chip = btn.closest(".chip");
            if (chip) chip.remove();
          };
        });
      }

      if (addBtn && wrap) {
        addBtn.addEventListener("click", () => {
          const chip = document.createElement("span");
          chip.className = "chip";
          chip.innerHTML = \`
            <input class="ctrl" style="width: 160px; padding:6px 8px; border-radius:10px;"
              type="date" name="recurrenceDates" value="" />
            <button type="button" aria-label="Remove">×</button>
          \`;
          wrap.appendChild(chip);
          const x = chip.querySelector("button");
          x.onclick = () => chip.remove();
        });

        attachRemoveHandlers();
      }
    </script>
  </body>
</html>
  `);
});

// POST /admin/events -> create OR update depending on hidden id
router.post("/events", async (req, res) => {
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

      // recurrence fields
      hasRecurrence,
      recurrenceType,
      recurrenceInterval,
      weeklyByDay,
      monthlyMode,
      byMonthday,
      setPos,
      monthlyByDay,
      recurrenceDates,
    } = req.body;

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

    // Slug (auto from title)
    const baseSlug = slugify ? slugify(title) : String(title || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
    const cats = normalizeCategories(categories);
    const catsJson = JSON.stringify(cats);

    // --- Recurrence build ---
    const hasRec = String(hasRecurrence || "") === "1" ? 1 : 0;
    const t = String(recurrenceType || "none").toLowerCase();

    let recurrenceRule = null;
    let recurrenceDatesJson = null;

    if (hasRec && t !== "none") {
      if (t === "custom") {
        let arr = [];
        if (Array.isArray(recurrenceDates)) arr = recurrenceDates;
        else if (typeof recurrenceDates === "string" && recurrenceDates.trim() !== "")
          arr = [recurrenceDates];

        const uniq = [];
        for (const d of arr) {
          const v = String(d || "").trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) continue;
          if (!uniq.includes(v)) uniq.push(v);
        }
        uniq.sort();

        recurrenceRule = { type: "custom" };
        recurrenceDatesJson = JSON.stringify(uniq);
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
          const wd = String(monthlyByDay || "").trim(); // SU..SA
          recurrenceRule = { type: "monthly", interval, mode: "nthweekday", setPos: sp, byDay: wd };
        } else {
          const md = Math.max(1, Math.min(31, parseInt(byMonthday || "0", 10) || 0));
          recurrenceRule = { type: "monthly", interval, mode: "monthday", byMonthday: md };
        }
      }
    }

    const recurrenceRuleJson = recurrenceRule ? JSON.stringify(recurrenceRule) : null;

    // Update vs Insert
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
             hasRecurrence=?,
             recurrenceRule=?,
             recurrenceDates=?,
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
          hasRec,
          recurrenceRuleJson,
          recurrenceDatesJson,
          eventId,
        ]
      );

      if (result && typeof result.changes === "number" && result.changes === 0) {
        return res.status(404).send("Event not found (ID does not exist).");
      }

      return res.redirect(`/events/${eventId}`);
    }

    const finalSlug = await ensureUniqueSlug(baseSlug);

    const result = await run(
      `INSERT INTO events (
        city, slug, title, description, eventDetails, goodToKnow,
        ticketUrl, ticketLabel,
        startDateTime, endDateTime, location, organizer,
        imageUrl, categories,
        hasRecurrence, recurrenceRule, recurrenceDates,
        updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
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
        hasRec,
        recurrenceRuleJson,
        recurrenceDatesJson,
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
