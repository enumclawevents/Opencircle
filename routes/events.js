// routes/events.js
const express = require("express");
const router = express.Router();
const { all, get, run } = require("../db");

/**
 * SQLite sorting/filtering helper:
 * Your DB stores ISO like "2026-02-06T16:00:00-08:00"
 * SQLite date funcs can choke on the "T" + offset.
 *
 * This normalizes to "YYYY-MM-DD HH:MM:SS" (drops offset) so ORDER BY / filtering works.
 * (We keep your stored value untouched; this is only for comparisons/sorting.)
 */
const SQL_DT = (col) => `datetime(replace(substr(${col},1,19),'T',' '))`;

// GET /events?city=Enumclaw&includePast=1
// Returns a list of events as JSON
router.get("/", async (req, res) => {
  try {
    const city = String(req.query.city || "Enumclaw");
    const includePast =
      String(req.query.includePast || "0") === "1" ||
      String(req.query.includePast || "").toLowerCase() === "true";

    // Default behavior: show EVERYTHING (no disappearing)
    // If you want "upcoming only" by default instead, flip the condition below.
    const where = [`LOWER(city) = LOWER(?)`];
    const params = [city];

    // OPTIONAL: uncomment if you want upcoming-only by default
    // if (!includePast) {
    //   where.push(`${SQL_DT("endDateTime")} >= datetime('now')`);
    // }

    const rows = await all(
      `
      SELECT *
      FROM events
      WHERE ${where.join(" AND ")}
      ORDER BY ${SQL_DT("startDateTime")} ASC
      `,
      params
    );

    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /events/:id
// Returns one event by ID
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const row = await get("SELECT * FROM events WHERE id = ?", [id]);
    if (!row) return res.status(404).json({ error: "Event not found" });

    res.json({ data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /events
// Creates a new event
router.post("/", async (req, res) => {
  try {
    const {
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
    } = req.body;

    if (!title || !description || !startDateTime || !endDateTime || !location || !organizer) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const result = await run(
      `
      INSERT INTO events (
        city,
        title,
        description,
        eventDetails,
        goodToKnow,
        startDateTime,
        endDateTime,
        location,
        organizer,
        imageUrl,
        updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      `,
      [
        city,
        title,
        description,
        eventDetails || null,
        goodToKnow || null,
        startDateTime,
        endDateTime,
        location,
        organizer,
        imageUrl || null,
      ]
    );

    const created = await get("SELECT * FROM events WHERE id = ?", [result.lastID]);
    res.status(201).json({ data: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /events/:id
// Updates an existing event
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const existing = await get("SELECT * FROM events WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Event not found" });

    const patch = req.body || {};

    const updated = {
      city: patch.city ?? existing.city,
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      eventDetails: patch.eventDetails ?? existing.eventDetails,
      goodToKnow: patch.goodToKnow ?? existing.goodToKnow,
      startDateTime: patch.startDateTime ?? existing.startDateTime,
      endDateTime: patch.endDateTime ?? existing.endDateTime,
      location: patch.location ?? existing.location,
      organizer: patch.organizer ?? existing.organizer,
      imageUrl: patch.imageUrl ?? existing.imageUrl,
    };

    await run(
      `
      UPDATE events
      SET
        city=?,
        title=?,
        description=?,
        eventDetails=?,
        goodToKnow=?,
        startDateTime=?,
        endDateTime=?,
        location=?,
        organizer=?,
        imageUrl=?,
        updatedAt=datetime('now')
      WHERE id=?
      `,
      [
        updated.city,
        updated.title,
        updated.description,
        updated.eventDetails || null,
        updated.goodToKnow || null,
        updated.startDateTime,
        updated.endDateTime,
        updated.location,
        updated.organizer,
        updated.imageUrl || null,
        id,
      ]
    );

    const row = await get("SELECT * FROM events WHERE id = ?", [id]);
    res.json({ data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /events/:id
// Deletes an event
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const existing = await get("SELECT * FROM events WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Event not found" });

    await run("DELETE FROM events WHERE id = ?", [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
