// routes/admin.js
"use strict";

const express = require("express");
const router = express.Router();
const { run, all, get } = require("../db");

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
  "Charity & Fundraising"
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

function parseStoredCategories(stored) {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch (_) {
    return String(stored)
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
  }
}

// Convert datetime-local (no timezone) into ISO with local timezone offset
function toLocalISOWithOffset(dtLocal) {
  if (!dtLocal) return null;
  const d = new Date(dtLocal);
  if (isNaN(d.getTime())) return null;

  const pad = (n) => String(n).padStart(2, "0");

  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = "00";

  const offsetMin = -d.getTimezoneOffset(); // local offset minutes
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offH = pad(Math.floor(abs / 60));
  const offM = pad(abs % 60);

  return (
    year + "-" + month + "-" + day +
    "T" + hours + ":" + minutes + ":" + seconds +
    sign + offH + ":" + offM
  );
}

// Convert ISO-with-offset -> datetime-local for form inputs
function toDateTimeLocalValue(isoWithOffset) {
  if (!isoWithOffset) return "";
  return String(isoWithOffset).slice(0, 16);
}

// GET /admin
router.get("/", async (req, res) => {
  const events = await all(
    "SELECT id, title, startDateTime, location FROM events ORDER BY startDateTime DESC LIMIT 20"
  );

  const editId = req.query.edit ? parseInt(req.query.edit, 10) : null;
  let editEvent = null;
  if (editId) {
    editEvent = await get("SELECT * FROM events WHERE id = ?", [editId]);
  }

  const selectedCats = parseStoredCategories(editEvent?.categories);

  const categoriesHtml = `
  <label>Categories (pick up to 3)</label>
  <select id="categoriesSelect" name="categories" multiple>
    ${ALLOWED_CATEGORIES.map((c) => {
      const selected = selectedCats.includes(c) ? "selected" : "";
      return `<option value="${c}" ${selected}>${c}</option>`;
    }).join("")}
  </select>
  <div class="note">Hold Cmd (Mac) / Ctrl (Windows) to select multiple. Max 3.</div>
`;


  const listHtml = events.length
    ? events.map((e) => {
        return `
          <div class="eventCard">
            <div class="eventTitle">#${e.id} — ${escapeHtml(e.title || "")}</div>
            <div class="eventMeta">
              <div><strong>Start:</strong> ${escapeHtml(e.startDateTime || "")}</div>
              <div><strong>Location:</strong> ${escapeHtml(e.location || "")}</div>
            </div>
            <div class="eventActions">
              <a href="/events/${e.id}" target="_blank" rel="noopener noreferrer">View JSON</a>
              <a href="/admin?edit=${e.id}">Edit</a>
              <form method="POST" action="/admin/events/${e.id}/delete" style="margin:0;"
                onsubmit="return confirm('Delete event #${e.id}?');">
                <button type="submit" class="danger">Delete</button>
              </form>
            </div>
          </div>
        `;
      }).join("")
    : `<div class="muted">No events yet.</div>`;

  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>OpenCircle Admin</title>
  <link rel="icon" href="/assets/brand/favicon.ico" />
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; max-width: 920px; margin: 0 auto; }
    .brand { display:flex; align-items:center; gap:14px; margin-bottom: 14px; }
    .brand img { height: 56px; width:auto; display:block; }
    h1 { margin: 0; font-size: 22px; }
    p { margin: 8px 0 14px; color:#444; }
    a { color:#0b6; }
    label { display:block; margin: 12px 0 6px; font-weight: 700; }
    input, textarea {
      width:100%;
      padding: 10px;
      border: 1px solid #ccc;
      border-radius: 10px;
      box-sizing: border-box;
      font-size: 14px;
    }
    textarea { min-height: 110px; resize: vertical; }
    .row { display:grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .note { font-size: 12px; color:#666; margin-top: 8px; }
    button {
      margin-top: 16px;
      padding: 10px 14px;
      border: 0;
      border-radius: 10px;
      cursor: pointer;
      background: #3fabd1;
      color: #fff;
      font-weight: 700;
    }
    button.danger { background: #d9534f; }
    .muted { color:#666; }

    select {
  width: 100%;
  padding: 10px;
  border: 1px solid #ccc;
  border-radius: 10px;
  box-sizing: border-box;
  font-size: 14px;
  background: #fff;
}

select[multiple]{
  min-height: 140px;
}


    .catsWrap {
      margin-top: 6px;
      border: 1px solid #ddd;
      border-radius: 12px;
      padding: 12px;
    }
    .catsTitle { font-weight: 800; margin-bottom: 10px; }
    .catsGrid { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .catItem { display:flex; gap:10px; align-items:center; margin:0; font-weight: 400; }
    .catItem input { width:auto; }

    .eventCard {
      border: 1px solid #ddd;
      border-radius: 12px;
      padding: 12px;
      background: #fff;
    }
    .eventTitle { font-weight: 800; margin-bottom: 6px; }
    .eventMeta { color:#444; font-size: 14px; display:grid; gap:4px; }
    .eventActions { margin-top: 10px; display:flex; gap: 12px; align-items:center; flex-wrap: wrap; }
    hr { margin: 24px 0; border:0; border-top: 1px solid #eee; }

    @media (max-width: 720px){
      .row { grid-template-columns: 1fr; }
      .catsGrid { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>

  <div class="brand">
    <img src="/assets/brand/oc-logo.svg" alt="OpenCircle API" />
    <div>
      <h1>OpenCircle Admin</h1>
      <p>Add or edit an event (stored in SQLite).</p>
      <p><a href="/events" target="_blank" rel="noopener noreferrer">View all events (JSON)</a></p>
    </div>
  </div>

  <form method="POST" action="/admin/events">
    ${editEvent ? `<input type="hidden" name="id" value="${editEvent.id}" />` : ""}

    <label>City</label>
    <input name="city" value="${escapeAttr(editEvent?.city || "Enumclaw")}" />

    ${categoriesHtml}

    <label>Title</label>
    <input name="title" value="${escapeAttr(editEvent?.title || "")}" required />

    <label>Description</label>
    <textarea name="description" required>${escapeTextarea(editEvent?.description || "")}</textarea>

    <label>Event Details</label>
    <textarea name="eventDetails">${escapeTextarea(editEvent?.eventDetails || "")}</textarea>

    <label>Good to Know</label>
    <textarea name="goodToKnow">${escapeTextarea(editEvent?.goodToKnow || "")}</textarea>

    <div class="row">
      <div>
        <label>Start Date/Time</label>
        <input id="startDateTime" type="datetime-local" name="startDateTime"
          value="${escapeAttr(toDateTimeLocalValue(editEvent?.startDateTime))}" required />
      </div>
      <div>
        <label>End Date/Time</label>
        <input id="endDateTime" type="datetime-local" name="endDateTime"
          value="${escapeAttr(toDateTimeLocalValue(editEvent?.endDateTime))}" required />
      </div>
    </div>

    <label>Image URL (flyer)</label>
    <input name="imageUrl" value="${escapeAttr(editEvent?.imageUrl || "")}" placeholder="https://..." />

    <label>Ticket Button Text</label>
    <input name="ticketLabel" value="${escapeAttr(editEvent?.ticketLabel || "Tickets")}" placeholder="Tickets / Reserve / Buy Tickets..." />

    <label>Ticket Link (URL)</label>
    <input name="ticketUrl" value="${escapeAttr(editEvent?.ticketUrl || "")}" placeholder="https://..." />
    <div class="note">If provided, a ticket button will show on the event page.</div>

    <label>Location</label>
    <input name="location" value="${escapeAttr(editEvent?.location || "")}" required />

    <label>Organizer</label>
    <input name="organizer" value="${escapeAttr(editEvent?.organizer || "")}" required />

    <button type="submit">${editEvent ? "Update Event" : "Save Event"}</button>
    ${editEvent ? `<a href="/admin" style="margin-left:10px;">Cancel</a>` : ""}

    <div class="note">Dates are saved with your local timezone automatically.</div>
  </form>

  <hr />

  <h2>Existing Events (latest 20)</h2>
  <div style="display:grid; gap:10px;">
    ${listHtml}
  </div>

  <script>
    // Auto-fill end time +2 hours
    const startEl = document.getElementById("startDateTime");
    const endEl = document.getElementById("endDateTime");

    function pad(n){ return String(n).padStart(2, "0"); }

    startEl.addEventListener("change", () => {
      if (!startEl.value) return;
      if (!endEl.value) {
        const d = new Date(startEl.value);
        d.setHours(d.getHours() + 2);
        endEl.value =
          d.getFullYear() + "-" +
          pad(d.getMonth() + 1) + "-" +
          pad(d.getDate()) + "T" +
          pad(d.getHours()) + ":" +
          pad(d.getMinutes());
      }
    });

// Enforce max 3 categories for <select multiple>
  const catSelect = document.getElementById("categoriesSelect");
  if (catSelect) {
    const MAX = 3;

    catSelect.addEventListener("change", () => {
      const selected = Array.from(catSelect.selectedOptions);

      if (selected.length > MAX) {
        // Unselect the last option the user just selected
        // (best effort: revert to first MAX)
        selected.slice(MAX).forEach(opt => (opt.selected = false));
      }
    });
  }
</script>

</body>
</html>
  `);
});

// POST /admin/events -> create OR update
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
      categories
    } = req.body;

    // Convert datetime-local values to ISO with timezone offset
    startDateTime = toLocalISOWithOffset(startDateTime);
    endDateTime = toLocalISOWithOffset(endDateTime);

    if (!title || !description || !startDateTime || !endDateTime || !location || !organizer) {
      return res.status(400).send("Missing required fields.");
    }

    if (ticketUrl && !/^https?:\/\//i.test(ticketUrl)) {
      return res.status(400).send("Ticket link must start with http:// or https://");
    }

    const finalTicketLabel =
      (ticketLabel && String(ticketLabel).trim()) ? String(ticketLabel).trim() : "Tickets";

    // Validate: end must be after start
    const startMs = Date.parse(startDateTime);
    const endMs = Date.parse(endDateTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return res.status(400).send("Invalid date/time.");
    }
    if (endMs <= startMs) {
      return res.status(400).send("End time must be after start time.");
    }

    const cats = normalizeCategories(categories);
    const catsJson = JSON.stringify(cats);

    if (id !== undefined && id !== null && String(id).trim() !== "") {
      const eventId = parseInt(String(id).trim(), 10);
      if (Number.isNaN(eventId)) return res.status(400).send("Invalid ID.");

      const result = await run(
        `UPDATE events
         SET city=?,
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
             updatedAt=datetime('now')
         WHERE id=?`,
        [
          city,
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
          eventId
        ]
      );

      if (result && typeof result.changes === "number" && result.changes === 0) {
        return res.status(404).send("Event not found (ID does not exist).");
      }

      return res.redirect(`/events/${eventId}`);
    }

    const result = await run(
      `INSERT INTO events (
        city, title, description, eventDetails, goodToKnow,
        ticketUrl, ticketLabel,
        startDateTime, endDateTime, location, organizer,
        imageUrl, categories, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [
        city,
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
        catsJson
      ]
    );

    return res.redirect(`/events/${result.lastID}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

// POST /admin/events/:id/delete
router.post("/events/:id/delete", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    await run("DELETE FROM events WHERE id = ?", [id]);
    return res.redirect("/admin");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

// ---- Safe HTML escaping helpers ----
function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
function escapeAttr(s) {
  return escapeHtml(s).replace(/`/g, "&#096;");
}
function escapeTextarea(s) {
  // textarea doesn't need quotes escaped, but still prevent </textarea> injection
  return String(s || "").replace(/<\/textarea/gi, "&lt;/textarea");
}

module.exports = router;
