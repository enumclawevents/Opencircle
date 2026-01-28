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
    return String(stored).split(",").map((x) => x.trim()).filter(Boolean);
  }
}

// Convert datetime-local (no timezone) into ISO with your local timezone offset
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
    year + "-" + month + "-" + day +
    "T" + hours + ":" + minutes + ":" + seconds +
    sign + offH + ":" + offM
  );
}

// Convert ISO-with-offset to datetime-local value for the form
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
    <div style="margin-top: 6px; border: 1px solid #ddd; border-radius: 10px; padding: 12px;">
      <div style="font-weight: 700; margin-bottom: 8px;">Categories (pick up to 3)</div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
        ${ALLOWED_CATEGORIES.map((c) => {
          const checked = selectedCats.includes(c) ? "checked" : "";
          return `
            <label style="display:flex; gap:8px; align-items:center; margin:0; font-weight: 400;">
              <input type="checkbox" name="categories" value="${c}" ${checked} />
              <span>${c}</span>
            </label>
          `;
        }).join("")}
      </div>
      <div class="note">Only these 12 categories are allowed. Max 3 per event.</div>
    </div>
  `;

  const listHtml = events.length
    ? events.map((e) => {
        return `
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
              <form method="POST" action="/admin/events/${e.id}/delete" style="margin:0;"
                onsubmit="return confirm('Delete event #${e.id}?');">
                <button type="submit">Delete</button>
              </form>
            </div>
          </div>
        `;
      }).join("")
    : `<div style="color:#666;">No events yet.</div>`;

  res.send(`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>OpenCircle Admin</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 24px; max-width: 820px; margin: 0 auto; }
          h1 { margin: 0 0 12px; }
          h2 { margin: 0 0 12px; }
          p { margin: 0 0 16px; color: #444; }
          label { display: block; margin: 12px 0 6px; font-weight: 600; }
          input, textarea { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 8px; }
          textarea { min-height: 120px; resize: vertical; }
          button { margin-top: 16px; padding: 10px 12px; border: 0; border-radius: 10px; cursor: pointer; }
          .row { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
          .note { font-size: 12px; color: #666; margin-top: 8px; }
          a { color: #0b6; }
        </style>
      </head>
      <body>
        <h1>OpenCircle Admin</h1>
        <p>Add or edit an event (stored in SQLite).</p>
        <p><a href="/events" target="_blank">View all events (JSON)</a></p>

        <form method="POST" action="/admin/events">
          ${editEvent ? `<input type="hidden" name="id" value="${editEvent.id}" />` : ""}

          <label>City</label>
          <input name="city" value="${editEvent?.city || "Enumclaw"}" />

          ${categoriesHtml}

          <label>Title</label>
          <input name="title" value="${editEvent?.title || ""}" required />

          <label>Description</label>
          <textarea name="description" required>${editEvent?.description || ""}</textarea>

          <label>Event Details</label>
          <textarea name="eventDetails">${editEvent?.eventDetails || ""}</textarea>

          <label>Good to Know</label>
          <textarea name="goodToKnow">${editEvent?.goodToKnow || ""}</textarea>

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

          <label>Image URL (flyer)</label>
          <input name="imageUrl" value="${editEvent?.imageUrl || ""}" placeholder="https://..." />

          <label>Ticket Button Text</label>
          <input name="ticketLabel" value="${editEvent?.ticketLabel || "Tickets"}" placeholder="Tickets / Reserve / Buy Tickets..." />

          <label>Ticket Link (URL)</label>
          <input name="ticketUrl" value="${editEvent?.ticketUrl || ""}" placeholder="https://..." />
          <div class="note">If provided, a ticket button will show on the event page.</div>

          <label>Location</label>
          <input name="location" value="${editEvent?.location || ""}" required />

          <label>Organizer</label>
          <input name="organizer" value="${editEvent?.organizer || ""}" required />

          <button type="submit">${editEvent ? "Update Event" : "Save Event"}</button>
          ${editEvent ? `<a href="/admin" style="margin-left:10px;">Cancel</a>` : ""}

          <div class="note">Dates are saved with your local timezone automatically.</div>
        </form>

        <hr style="margin: 24px 0;" />

        <h2>Existing Events (latest 20)</h2>
        <div style="display: grid; gap: 10px;">
          ${listHtml}
        </div>

        <script>
          // Auto-fill end time +2 hours
          const startEl = document.getElementById("startDateTime");
          const endEl = document.getElementById("endDateTime");

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

          // Enforce max 3 categories
          const boxes = Array.from(document.querySelectorAll('input[type="checkbox"][name="categories"]'));
          function enforceMax() {
            const checked = boxes.filter(b => b.checked);
            if (checked.length >= 3) {
              boxes.forEach(b => { if (!b.checked) b.disabled = true; });
            } else {
              boxes.forEach(b => { b.disabled = false; });
            }
          }
          boxes.forEach(b => b.addEventListener("change", enforceMax));
          enforceMax();
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

    // If an ID is present, update. Otherwise insert.
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
