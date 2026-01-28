// routes/admin.js
"use strict";

const express = require("express");
const router = express.Router();
const { run, all, get } = require("../db");

// Fixed category list
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
  else if (typeof input === "string") arr = [input];

  const out = [];
  for (const c of arr) {
    if (ALLOWED_CATEGORIES.includes(c) && !out.includes(c)) {
      out.push(c);
      if (out.length === 3) break;
    }
  }
  return out;
}

function parseStoredCategories(stored) {
  if (!stored) return [];
  try {
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(stored)
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }
}

// Admin page
router.get("/", async (req, res) => {
  const events = await all(
    "SELECT id, title, startDateTime FROM events ORDER BY startDateTime DESC LIMIT 20"
  );

  const editId = req.query.edit ? Number(req.query.edit) : null;
  const editEvent = editId ? await get("SELECT * FROM events WHERE id = ?", [editId]) : null;
  const selected = parseStoredCategories(editEvent?.categories);

  res.send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>OpenCircle Admin</title>
  <link rel="icon" href="/assets/brand/favicon.ico">
  <style>
    body { font-family: Arial, sans-serif; padding: 24px; max-width: 900px; margin: auto; }
    label { font-weight: 600; margin-top: 14px; display:block; }
    input, textarea { width:100%; padding:10px; border-radius:8px; border:1px solid #ccc; }
    button { margin-top:16px; padding:10px 14px; border-radius:8px; border:0; cursor:pointer; }
    .grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; }
    .cats { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-top:8px; }
    .note { font-size:12px; color:#666; margin-top:6px; }
  </style>
</head>
<body>

<img src="/assets/brand/oc-logo.svg" alt="OpenCircle" style="height:56px">

<form method="POST" action="/admin/events">
  ${editEvent ? `<input type="hidden" name="id" value="${editEvent.id}">` : ""}

  <label>City</label>
  <input name="city" value="${editEvent?.city || "Enumclaw"}">

  <label>Categories (pick up to 3)</label>
  <div class="cats">
    ${ALLOWED_CATEGORIES.map(c => `
      <label>
        <input type="checkbox" name="categories" value="${c}" ${selected.includes(c) ? "checked" : ""}>
        ${c}
      </label>
    `).join("")}
  </div>
  <div class="note">Only these 12 categories are allowed.</div>

  <label>Title</label>
  <input name="title" value="${editEvent?.title || ""}" required>

  <label>Description</label>
  <textarea name="description" required>${editEvent?.description || ""}</textarea>

  <label>Start Date/Time</label>
  <input type="datetime-local" name="startDateTime" required>

  <label>End Date/Time</label>
  <input type="datetime-local" name="endDateTime" required>

  <label>Location</label>
  <input name="location" value="${editEvent?.location || ""}" required>

  <label>Organizer</label>
  <input name="organizer" value="${editEvent?.organizer || ""}" required>

  <button type="submit">${editEvent ? "Update Event" : "Save Event"}</button>
</form>

<hr>

<h3>Existing Events</h3>
${events.map(e => `<div>#${e.id} — ${e.title}</div>`).join("")}

</body>
</html>
`);
});

// Save event
router.post("/events", async (req, res) => {
  const {
    id,
    city,
    title,
    description,
    startDateTime,
    endDateTime,
    location,
    organizer,
    categories
  } = req.body;

  const cats = JSON.stringify(normalizeCategories(categories));

  if (id) {
    await run(
      `UPDATE events
       SET city=?, title=?, description=?, startDateTime=?, endDateTime=?,
           location=?, organizer=?, categories=?, updatedAt=datetime('now')
       WHERE id=?`,
      [city, title, description, startDateTime, endDateTime, location, organizer, cats, id]
    );
    return res.redirect(`/events/${id}`);
  }

  const result = await run(
    `INSERT INTO events
     (city,title,description,startDateTime,endDateTime,location,organizer,categories,updatedAt)
     VALUES (?,?,?,?,?,?,?,?,datetime('now'))`,
    [city, title, description, startDateTime, endDateTime, location, organizer, cats]
  );

  res.redirect(`/events/${result.lastID}`);
});

module.exports = router;
