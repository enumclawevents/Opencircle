const express = require("express");
const router = express.Router();
const { all, get, run } = require("../db");

/**
 * Fixed category list (12 total)
 * Admin must choose from these; API will reject anything else.
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
  // input can be: undefined, string, array (from form or JSON)
  let arr = [];

  if (Array.isArray(input)) arr = input;
  else if (typeof input === "string" && input.trim() !== "") {
    // Could be JSON, or comma-separated, or a single value
    const s = input.trim();
    if (s.startsWith("[") && s.endsWith("]")) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) arr = parsed;
      } catch (_) {}
    }
    if (!arr.length) {
      arr = s.split(",").map((x) => x.trim()).filter(Boolean);
    }
  }

  // sanitize + unique + allowed only + max 3
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

function rowToApi(row) {
  if (!row) return row;
  let cats = [];
  if (row.categories) {
    try {
      const parsed = JSON.parse(row.categories);
      if (Array.isArray(parsed)) cats = parsed;
    } catch (_) {
      cats = String(row.categories).split(",").map((x) => x.trim()).filter(Boolean);
    }
  }
  return { ...row, categories: cats };
}

// GET /events?city=Enumclaw
router.get("/", async (req, res) => {
  try {
    const city = req.query.city || "Enumclaw";

    const rows = await all(
      "SELECT * FROM events WHERE LOWER(city) = LOWER(?) ORDER BY startDateTime ASC",
      [city]
    );

    res.json({ data: rows.map(rowToApi) });
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

    res.json({ data: rowToApi(row) });
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
      imageUrl,
      categories
    } = req.body;

    if (!title || !description || !startDateTime || !endDateTime || !location || !organizer) {
      return res.status(400).json({ error: "Missing required fields" });
    }

    if (ticketUrl && !/^https?:\/\//i.test(ticketUrl)) {
      return res.status(400).json({ error: "ticketUrl must start with http:// or https://" });
    }

    const finalTicketLabel =
      (ticketLabel && String(ticketLabel).trim()) ? String(ticketLabel).trim() : "Tickets";

    const cats = normalizeCategories(categories);
    const catsJson = JSON.stringify(cats);

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

    const created = await get("SELECT * FROM events WHERE id = ?", [result.lastID]);
    res.status(201).json({ data: rowToApi(created) });
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
      imageUrl: patch.imageUrl ?? existing.imageUrl,
      categories: patch.categories ?? existing.categories
    };

    if (updated.ticketUrl && !/^https?:\/\//i.test(updated.ticketUrl)) {
      return res.status(400).json({ error: "ticketUrl must start with http:// or https://" });
    }

    const finalTicketLabel =
      (updated.ticketLabel && String(updated.ticketLabel).trim())
        ? String(updated.ticketLabel).trim()
        : "Tickets";

    const cats = normalizeCategories(updated.categories);
    const catsJson = JSON.stringify(cats);

    await run(
      `UPDATE events
       SET city=?, title=?, description=?, eventDetails=?, goodToKnow=?,
           ticketUrl=?, ticketLabel=?,
           startDateTime=?, endDateTime=?, location=?, organizer=?,
           imageUrl=?, categories=?, updatedAt=datetime('now')
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
        catsJson,
        id
      ]
    );

    const row = await get("SELECT * FROM events WHERE id = ?", [id]);
    res.json({ data: rowToApi(row) });
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
