"use strict";

const path = require("path");
const sqlite3 = require("sqlite3").verbose();

/**
 * DB PATH
 * Priority:
 * 1) Explicit DB_PATH env var (Render recommended)
 * 2) Render disk mount (RENDER_DISK_PATH)
 * 3) Local fallback (project root)
 */
const DB_PATH =
  process.env.DB_PATH ||
  (process.env.RENDER_DISK_PATH
    ? path.join(process.env.RENDER_DISK_PATH, "opencircle.db")
    : path.join(__dirname, "data.sqlite"));

console.log("[DB] Using SQLite file:", DB_PATH);

// Open database
const db = new sqlite3.Database(DB_PATH);

// ---------- PROMISIFIED HELPERS ----------
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

// ---------- SLUG HELPERS ----------
function slugify(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

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

// ---------- INIT / MIGRATIONS ----------
async function init() {
  // Canonical schema (fresh DB)
  await run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      slug TEXT,

      city TEXT,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      eventDetails TEXT,
      goodToKnow TEXT,

      startDateTime TEXT NOT NULL,
      endDateTime TEXT NOT NULL,

      location TEXT NOT NULL,
      organizer TEXT NOT NULL,

      imageUrl TEXT,
      ticketUrl TEXT,
      ticketLabel TEXT,

      categories TEXT,

      featured INTEGER DEFAULT 0,

      hasRecurrence INTEGER DEFAULT 0,
      recurrenceRule TEXT,
      recurrenceDates TEXT,
      recurrenceStartDate TEXT,
      recurrenceUntilDate TEXT,

      viewCount INTEGER NOT NULL DEFAULT 0,
      uniqueViewCount INTEGER NOT NULL DEFAULT 0,
      lastViewedAt TEXT,
      goingCount INTEGER DEFAULT 0,
      interestedCount INTEGER DEFAULT 0,

      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);

    await run(`
    CREATE TABLE IF NOT EXISTS event_views (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      eventId INTEGER NOT NULL,
      occurrenceDate TEXT,
      viewedAt TEXT NOT NULL DEFAULT (datetime('now')),
      ipHash TEXT,
      ua TEXT,
      ref TEXT,
      sid TEXT
    )
  `);

    await run(`
  CREATE TABLE IF NOT EXISTS event_view_uniques (
    eventId INTEGER NOT NULL,
    sid TEXT NOT NULL,
    firstSeenAt TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (eventId, sid)
  )
`);


  await run(`CREATE INDEX IF NOT EXISTS idx_event_views_eventId_viewedAt ON event_views(eventId, viewedAt)`);
  // Count unique views per event by sid (only when sid is present)
await run(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_event_views_event_sid_unique
  ON event_views(eventId, sid)
  WHERE sid IS NOT NULL AND sid <> ''
`);

  await run(`CREATE INDEX IF NOT EXISTS idx_event_views_eventId_occurrenceDate ON event_views(eventId, occurrenceDate)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_event_views_ipHash ON event_views(ipHash)`);



  // --- NORMALIZE LEGACY FEATURED COLUMN (Featured -> featured) ---
  try {
    await run(`ALTER TABLE events RENAME COLUMN Featured TO featured`);
    console.log("[DB] Renamed column Featured -> featured");
  } catch (_) {
    // ignore
  }

  // Safe migrations (no data loss). These run on older DBs.
  const migrations = [
    `ALTER TABLE events ADD COLUMN eventDetails TEXT`,
    `ALTER TABLE events ADD COLUMN goodToKnow TEXT`,
    `ALTER TABLE events ADD COLUMN ticketUrl TEXT`,
    `ALTER TABLE events ADD COLUMN ticketLabel TEXT`,
    `ALTER TABLE events ADD COLUMN imageUrl TEXT`,
    `ALTER TABLE events ADD COLUMN categories TEXT`,
    `ALTER TABLE events ADD COLUMN featured INTEGER DEFAULT 0`,
    `ALTER TABLE events ADD COLUMN goingCount INTEGER DEFAULT 0`,
    `ALTER TABLE events ADD COLUMN interestedCount INTEGER DEFAULT 0`,
    `ALTER TABLE events ADD COLUMN viewCount INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE events ADD COLUMN uniqueViewCount INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE events ADD COLUMN lastViewedAt TEXT`,
    `ALTER TABLE events ADD COLUMN hasRecurrence INTEGER DEFAULT 0`,
    `ALTER TABLE events ADD COLUMN recurrenceRule TEXT`,
    `ALTER TABLE events ADD COLUMN recurrenceDates TEXT`,
    `ALTER TABLE events ADD COLUMN recurrenceStartDate TEXT`,
    `ALTER TABLE events ADD COLUMN recurrenceUntilDate TEXT`,

    `ALTER TABLE events ADD COLUMN slug TEXT`,
  ];

  for (const sql of migrations) {
    try {
      await run(sql);
    } catch (_) {
      // column already exists
    }
  }

  // Optional compat migrations (ignore if legacy cols don't exist)
  try {
    await run(`
      UPDATE events
      SET hasRecurrence = COALESCE(hasRecurrence, hasOccurrences, 0)
      WHERE hasRecurrence IS NULL
    `);
  } catch (_) {}

  try {
    await run(`
      UPDATE events
      SET recurrenceDates = COALESCE(recurrenceDates, customDates)
      WHERE recurrenceDates IS NULL
    `);
  } catch (_) {}

  // Backfill slugs (once)
  try {
    const rows = await all("SELECT id, title, slug FROM events", []);
    for (const r of rows) {
      if (r.slug && String(r.slug).trim() !== "") continue;

      const base = slugify(r.title) || `event-${r.id}`;
      const unique = await ensureUniqueSlug(base);
      await run("UPDATE events SET slug = ? WHERE id = ?", [unique, r.id]);
    }
  } catch (e) {
    console.error("[DB] Slug backfill failed:", e);
  }

  console.log("[DB] Initialized & migrated");
}

// Server expects initDB() to exist and return a Promise
async function initDB() {
  return init();
}

module.exports = {
  db,
  run,
  get,
  all,
  slugify,
  ensureUniqueSlug,
  initDB,
};
