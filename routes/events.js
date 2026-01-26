const express = require("express");
const router = express.Router();
const { all, get, run } = require("../db");

// GET /events?city=Enumclaw
// This returns a list of events as JSON
router.get("/", async (req, res) => {
  try {
    const city = req.query.city || "Enumclaw";

    const rows = await all(
      "SELECT * FROM events WHERE LOWER(city) = LOWER(?) ORDER BY startDateTime ASC",
      [city]
    );

    res.json({ data: rows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /events/:id
// This returns one event by ID
router.get("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const row = await get("SELECT * FROM events WHERE id = ?", [id]);

    if (!row) return res.status(404).json({ error: "Event not found" });

    res.json({ data: row });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /events
// This creates a new event
router.post("/", async (req, res) => {
  try {
    const {
      city = "Enumclaw",
      title,
      description,
      startDateTime,
      endDateTime,
      location,
      organizer
    } = req.body;

    // Basic validation (required fields)
    if (!title || !description || !startDateTime || !endDateTime || !location || !organizer) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    const result = await run(
      `INSERT INTO events (city, title, description, startDateTime, endDateTime, location, organizer, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
      [city, title, description, startDateTime, endDateTime, location, organizer]
    );

    const created = await get("SELECT * FROM events WHERE id = ?", [result.lastID]);

    res.status(201).json({ data: created });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

// PUT /events/:id
// This updates an existing event
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

    const existing = await get("SELECT * FROM events WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Event not found" });

    const patch = req.body;

    const updated = {
      city: patch.city ?? existing.city,
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      startDateTime: patch.startDateTime ?? existing.startDateTime,
      endDateTime: patch.endDateTime ?? existing.endDateTime,
      location: patch.location ?? existing.location,
      organizer: patch.organizer ?? existing.organizer
    };

    await run(
      `UPDATE events
       SET city=?, title=?, description=?, startDateTime=?, endDateTime=?, location=?, organizer=?, updatedAt=datetime('now')
       WHERE id=?`,
      [
        updated.city,
        updated.title,
        updated.description,
        updated.startDateTime,
        updated.endDateTime,
        updated.location,
        updated.organizer,
        id
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
// This deletes an event
router.delete("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);

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
