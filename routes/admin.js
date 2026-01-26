const express = require("express");
const router = express.Router();
const { run, all, get } = require("../db");



// Convert datetime-local (no timezone) into ISO with your local timezone offset
function toLocalISOWithOffset(dtLocal) {
  // dtLocal example: "2026-01-30T18:00"
  const d = new Date(dtLocal);
  if (isNaN(d.getTime())) return null;

  const pad = (n) => String(n).padStart(2, "0");

  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = "00";

  // timezone offset in minutes, convert to ±HH:MM
  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offH = pad(Math.floor(abs / 60));
  const offM = pad(abs % 60);

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offH}:${offM}`;
}

// GET /admin -> shows a simple HTML form
router.get("/", async (req, res) => { const editId = req.query.edit ? parseInt(req.query.edit, 10) : null;
let editEvent = null;

if (editId) {
  editEvent = await get(
    "SELECT * FROM events WHERE id = ?",
    [editId]
  );
}
const events = await all(
  "SELECT id, title, startDateTime, location FROM events ORDER BY startDateTime DESC LIMIT 20"
);


  res.send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>OpenCircle Admin</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; max-width: 720px; margin: 0 auto; }
          h1 { margin: 0 0 12px; }
          p { margin: 0 0 16px; color: #444; }
          label { display: block; margin: 12px 0 6px; font-weight: 600; }
          input, textarea { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 8px; }
          textarea { min-height: 120px; }
          button { margin-top: 16px; padding: 12px 14px; border: 0; border-radius: 10px; cursor: pointer; }
          .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
          .note { font-size: 12px; color: #666; margin-top: 8px; }
        </style>
      </head>
      <body>
        <h1>OpenCircle Admin</h1>
        <p>Add an event to the API (stored in SQLite).</p>
        <p><a href="/events" target="_blank">View all events (JSON)</a></p>

        <form method="POST" action="/admin/events">
          <label>City</label>
          <input name="city" value="Enumclaw" />

          <label>Title</label>
          <input name="title" required />

          <label>Description</label>
          <textarea name="description" required></textarea>

          <div class="row">
            <div>
              <label>Start Date/Time</label>
              <input id="startDateTime" type="datetime-local" name="startDateTime" required />
            </div>
            <div>
              <label>End Date/Time</label>
              <input id="endDateTime" type="datetime-local" name="endDateTime" required />
            </div>
          </div>

          <label>Location</label>
          <input name="location" required />

          <label>Organizer</label>
          <input name="organizer" required />

          <button type="submit">Save Event</button>
          <div class="note">Dates are saved with your local timezone automatically.</div>
        </form>
<hr style="margin: 24px 0;" />

<h2 style="margin: 0 0 12px;">Existing Events (latest 20)</h2>

<div style="display: grid; gap: 10px;">
  ${
    events.length
      ? events
          .map(
            (e) => `
              <div style="border: 1px solid #ddd; border-radius: 10px; padding: 12px;">
                <div style="font-weight: 700; margin-bottom: 4px;">
                  #${e.id} — ${e.title}
                </div>
                <div style="color: #444; font-size: 14px;">
                  <div><strong>Start:</strong> ${e.startDateTime}</div>
                  <div><strong>Location:</strong> ${e.location}</div>
                </div>
                <div style="margin-top: 10px; display: flex; gap: 10px; align-items: center;">
  <a href="/events/${e.id}" target="_blank">View JSON</a>
              <a href="/admin?edit=${e.id}">Edit</a>


  <form method="POST" action="/admin/events/${e.id}/delete" style="margin:0;">
    <button type="submit" onclick="return confirm('Delete event #${e.id}?');">
      Delete
    </button>
  </form>
</div>

              </div>
            `
          )
          .join("")
      : `<div style="color:#666;">No events yet.</div>`
  }
</div>

        <script>
          const startEl = document.getElementById("startDateTime");
          const endEl = document.getElementById("endDateTime");

          startEl.addEventListener("change", () => {
            if (!startEl.value) return;

            // If end time is empty, set it to +2 hours
            if (!endEl.value) {
              const d = new Date(startEl.value);
              d.setHours(d.getHours() + 2);

              // Convert back to "YYYY-MM-DDTHH:MM" for datetime-local
              const pad = (n) => String(n).padStart(2, "0");
              const v = \`\${d.getFullYear()}-\${pad(d.getMonth() + 1)}-\${pad(d.getDate())}T\${pad(d.getHours())}:\${pad(d.getMinutes())}\`;

              endEl.value = v;
            }
          });
        </script>
      </body>
    </html>
  `);
});

// POST /admin/events -> receives the form and inserts into DB
router.post("/events", async (req, res) => {
  try {
    let { city = "Enumclaw", title, description, startDateTime, endDateTime, location, organizer } = req.body;

    // Convert datetime-local values to ISO with timezone offset
    startDateTime = toLocalISOWithOffset(startDateTime);
    endDateTime = toLocalISOWithOffset(endDateTime);

    if (!title || !description || !startDateTime || !endDateTime || !location || !organizer) {
      return res.status(400).send("Missing required fields.");
    }

    // Validate: end must be after start
    const startMs = Date.parse(startDateTime);
    const endMs = Date.parse(endDateTime);

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return res.status(400).send("Invalid date/time.");
    }

    if (endMs <= startMs) {
      return res.status(400).send("End time must be after start time.");
    }

    const result = await run(
      `INSERT INTO events (city, title, description, startDateTime, endDateTime, location, organizer, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [city, title, description, startDateTime, endDateTime, location, organizer]
    );

    // Redirect to the JSON for the newly created event
    res.redirect(`/events/${result.lastID}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error.");
  }
});
// POST /admin/events/:id/delete -> deletes an event
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
