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

// Convert ISO-with-offset to datetime-local value for the form
function toDateTimeLocalValue(isoWithOffset) {
  if (!isoWithOffset) return "";
  // "2026-01-30T18:00:00-08:00" -> "2026-01-30T18:00"
  return String(isoWithOffset).slice(0, 16);
}

// GET /admin -> shows a simple HTML form + list
router.get("/", async (req, res) => {
  const events = await all(
    "SELECT id, title, startDateTime, location FROM events ORDER BY startDateTime DESC LIMIT 20"
  );

  const editId = req.query.edit ? parseInt(req.query.edit, 10) : null;
  let editEvent = null;

  if (editId) {
    editEvent = await get("SELECT * FROM events WHERE id = ?", [editId]);
  }

  res.send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>OpenCircle Admin</title>
        git push
<style>
  :root{
    /* OpenCircle core */
    --mint: #00C08B;
    --charcoal: #323E48;

    /* Supporting shades from brand palette/system */
    --mint-90: #09A69A;
    --mint-75: #098F86;
    --charcoal-90: #25303A;
    --charcoal-75: #202A33;

    --gray: #9CA3AF;
    --danger: #C3413A;

    /* UI surfaces */
    --bg: #0F1419;
    --panel: rgba(50, 62, 72, 0.22);
    --panel-2: rgba(50, 62, 72, 0.14);
    --border: rgba(156, 163, 175, 0.20);
    --border-strong: rgba(156, 163, 175, 0.34);

    --text: rgba(255,255,255,0.92);
    --text-dim: rgba(255,255,255,0.72);
    --text-muted: rgba(255,255,255,0.56);

    --radius: 16px;
    --radius-sm: 12px;
    --shadow: 0 12px 34px rgba(0,0,0,0.35);
    --shadow-soft: 0 8px 22px rgba(0,0,0,0.22);
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; }

  body {
    margin: 0;
    padding: 28px 18px;
    font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    background:
      radial-gradient(900px 420px at 18% -10%, rgba(0, 192, 139, 0.22), transparent 55%),
      radial-gradient(680px 360px at 82% 0%, rgba(9, 166, 154, 0.16), transparent 55%),
      radial-gradient(720px 520px at 50% 120%, rgba(50, 62, 72, 0.55), transparent 55%),
      var(--bg);
    color: var(--text);
  }

  /* Container card */
  .oc-shell{
    max-width: 860px;
    margin: 0 auto;
    border: 1px solid var(--border);
    border-radius: calc(var(--radius) + 6px);
    background: linear-gradient(180deg, var(--panel), var(--panel-2));
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .oc-topbar{
    padding: 18px 20px;
    border-bottom: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
    background:
      radial-gradient(520px 220px at 15% 0%, rgba(0, 192, 139, 0.18), transparent 55%),
      rgba(0,0,0,0.18);
  }

  .oc-brand{
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  h1{
    margin: 0;
    font-weight: 600; /* Inter Semi-Bold */
    letter-spacing: -0.02em;
    font-size: 28px;
    line-height: 34px;
  }

  .oc-sub{
    margin: 0;
    font-weight: 300; /* Inter Light-ish */
    color: var(--text-dim);
    font-size: 14px;
    line-height: 20px;
  }

  .oc-actions{
    display: flex;
    align-items: center;
    gap: 10px;
    flex-wrap: wrap;
  }

  a{
    color: var(--mint);
    text-decoration: none;
    font-weight: 500;
  }
  a:hover{ text-decoration: underline; }

  .oc-content{
    padding: 20px;
  }

  /* Form layout */
  form{
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 18px;
    background: rgba(0,0,0,0.16);
    box-shadow: var(--shadow-soft);
  }

  label{
    display: block;
    margin: 14px 0 6px;
    font-weight: 600;
    color: var(--text-dim);
    font-size: 13px;
  }

  input, textarea{
    width: 100%;
    padding: 11px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: rgba(255,255,255,0.04);
    color: var(--text);
    outline: none;
    transition: border-color .15s ease, box-shadow .15s ease, transform .05s ease;
  }

  textarea{ min-height: 120px; resize: vertical; }

  input:focus, textarea:focus{
    border-color: rgba(0, 192, 139, 0.65);
    box-shadow: 0 0 0 3px rgba(0, 192, 139, 0.18);
  }

  .row{
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }
  @media (max-width: 720px){
    .row{ grid-template-columns: 1fr; }
  }

  .oc-btn{
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 11px 14px;
    border: 1px solid rgba(0, 192, 139, 0.35);
    border-radius: 999px;
    background: linear-gradient(180deg, rgba(0,192,139,0.22), rgba(0,192,139,0.12));
    color: var(--text);
    font-weight: 600;
    cursor: pointer;
    transition: transform .08s ease, border-color .15s ease, background .15s ease, box-shadow .15s ease;
  }
  .oc-btn:hover{
    border-color: rgba(0, 192, 139, 0.6);
    box-shadow: 0 10px 22px rgba(0,0,0,0.20);
  }
  .oc-btn:active{ transform: translateY(1px); }

  .oc-btn-ghost{
    border-color: var(--border);
    background: rgba(255,255,255,0.04);
    color: var(--text-dim);
  }

  .oc-btn-danger{
    border-color: rgba(195,65,58,0.45);
    background: rgba(195,65,58,0.10);
    color: rgba(255,255,255,0.88);
  }
  .oc-btn-danger:hover{
    border-color: rgba(195,65,58,0.75);
    box-shadow: 0 10px 22px rgba(0,0,0,0.20);
  }

  .note{
    margin-top: 10px;
    font-size: 12px;
    line-height: 18px;
    color: var(--text-muted);
  }

  hr{
    border: 0;
    border-top: 1px solid var(--border);
    margin: 22px 0;
  }

  /* Event cards */
  .oc-list{
    display: grid;
    gap: 10px;
  }
  .oc-card{
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 14px;
    background: rgba(0,0,0,0.14);
  }
  .oc-card-title{
    font-weight: 600;
    margin: 0 0 6px;
    letter-spacing: -0.01em;
  }
  .oc-card-meta{
    margin: 0;
    color: var(--text-dim);
    font-size: 13px;
    line-height: 18px;
  }
  .oc-card-actions{
    margin-top: 10px;
    display: flex;
    gap: 10px;
    align-items: center;
    flex-wrap: wrap;
  }

  /* Make browser calendar icon visible in dark UI */
  input[type="datetime-local"]::-webkit-calendar-picker-indicator{
    filter: invert(1) opacity(0.7);
  }
</style>

      </head>
      <body>
        <h1>OpenCircle Admin</h1>
        <p>Add an event to the API (stored in SQLite).</p>
        <p><a href="/events" target="_blank">View all events (JSON)</a></p>

        <form method="POST" action="/admin/events">
          ${editEvent ? `<input type="hidden" name="id" value="${editEvent.id}" />` : ""}

          <label>City</label>
          <input name="city" value="${editEvent?.city || "Enumclaw"}" />

          <label>Title</label>
          <input name="title" value="${editEvent?.title || ""}" required />

          <label>Description</label>
          <textarea name="description" required>${editEvent?.description || ""}</textarea>

          <div class="row">
            <div>
              <label>Start Date/Time</label>
              <input id="startDateTime" type="datetime-local" name="startDateTime"
                value="${toDateTimeLocalValue(editEvent?.startDateTime)}" required />
            </div>
            <div>
              <label>End Date/Time</label>
              <input id="endDateTime" type="datetime-local" name="endDateTime"
                value="${toDateTimeLocalValue(editEvent?.endDateTime)}" required />
            </div>
          </div>

          <label>Location</label>
          <input name="location" value="${editEvent?.location || ""}" required />

          <label>Organizer</label>
          <input name="organizer" value="${editEvent?.organizer || ""}" required />

          <button type="submit">${editEvent ? "Update Event" : "Save Event"}</button>
          ${
            editEvent
              ? `<a href="/admin" style="margin-left:10px;">Cancel</a>`
              : ""
          }
          <div class="note">Dates are saved with your local timezone automatically.</div>
        </form>

        <hr style="margin: 24px 0;" />

        <h2>Existing Events (latest 20)</h2>

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
              const v = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

              endEl.value = v;
            }
          });
        </script>
      </body>
    </html>
  `);
});

// POST /admin/events -> create OR update depending on hidden id
router.post("/events", async (req, res) => {
  try {
    let { id, city = "Enumclaw", title, description, startDateTime, endDateTime, location, organizer } = req.body;

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

    // If an ID is present, update. Otherwise insert.
    if (id) {
      const eventId = parseInt(id, 10);
      if (Number.isNaN(eventId)) return res.status(400).send("Invalid ID.");

      await run(
        `UPDATE events
         SET city=?, title=?, description=?, startDateTime=?, endDateTime=?, location=?, organizer=?, updatedAt=datetime('now')
         WHERE id=?`,
        [city, title, description, startDateTime, endDateTime, location, organizer, eventId]
      );

      return res.redirect(`/events/${eventId}`);
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
