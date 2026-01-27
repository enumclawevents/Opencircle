const express = require("express");
const router = express.Router();
const { all, get, run } = require("../db");

// GET /events?city=Enumclaw
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
router.post("/", async (req, res) => {
  try {
    const {
      city = "Enumclaw",
      title,
      description,
      eventDetails,
      goodToKnow,
      ticketUrl,
      ticketLabel,
      startDateTime,
      endDateTime,
      location,
      organizer,
      imageUrl
    } = req.body;

    if (!title || !description || !startDateTime || !endDateTime || !location || !organizer) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (ticketUrl && !/^https?:\/\//i.test(ticketUrl)) {
      return res.status(400).json({ error: "ticketUrl must start with http:// or https://" });
    }

    const finalTicketLabel =
      (ticketLabel && String(ticketLabel).trim()) ? String(ticketLabel).trim() : "Tickets";

    const result = await run(
      `INSERT INTO events (
        city, title, description, eventDetails, goodToKnow,
        ticketUrl, ticketLabel,
        startDateTime, endDateTime, location, organizer,
        imageUrl, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
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
        imageUrl || null
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
router.put("/:id", async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).json({ error: "Invalid ID" });

    const existing = await get("SELECT * FROM events WHERE id = ?", [id]);
    if (!existing) return res.status(404).json({ error: "Event not found" });

    const patch = req.body;

    const updated = {
      city: patch.city ?? existing.city,
      title: patch.title ?? existing.title,
      description: patch.description ?? existing.description,
      eventDetails: patch.eventDetails ?? existing.eventDetails,
      goodToKnow: patch.goodToKnow ?? existing.goodToKnow,
      ticketUrl: patch.ticketUrl ?? existing.ticketUrl,
      ticketLabel: patch.ticketLabel ?? existing.ticketLabel,
      startDateTime: patch.startDateTime ?? existing.startDateTime,
      endDateTime: patch.endDateTime ?? existing.endDateTime,
      location: patch.location ?? existing.location,
      organizer: patch.organizer ?? existing.organizer,
      imageUrl: patch.imageUrl ?? existing.imageUrl
    };

    if (updated.ticketUrl && !/^https?:\/\//i.test(updated.ticketUrl)) {
      return res.status(400).json({ error: "ticketUrl must start with http:// or https://" });
    }

    const finalTicketLabel =
      (updated.ticketLabel && String(updated.ticketLabel).trim())
        ? String(updated.ticketLabel).trim()
        : "Tickets";

    await run(
      `UPDATE events
       SET city=?, title=?, description=?, eventDetails=?, goodToKnow=?,
           ticketUrl=?, ticketLabel=?,
           startDateTime=?, endDateTime=?, location=?, organizer=?,
           imageUrl=?, updatedAt=datetime('now')
       WHERE id=?`,
      [
        updated.city,
        updated.title,
        updated.description,
        updated.eventDetails || null,
        updated.goodToKnow || null,
        updated.ticketUrl || null,
        finalTicketLabel,
        updated.startDateTime,
        updated.endDateTime,
        updated.location,
        updated.organizer,
        updated.imageUrl || null,
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
