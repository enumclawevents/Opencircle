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

// ---------- INIT / MIGRATIONS ----------
async function init() {
  // Base events table (canonical schema)
  await run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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

      categories TEXT, -- JSON array of strings

      -- Recurrence (canonical names used by admin.js + events.js)
      hasRecurrence INTEGER DEFAULT 0,
      recurrenceRule TEXT,     -- JSON rule object {type, interval,...}
      recurrenceDates TEXT,    -- JSON array of "YYYY-MM-DD" for custom dates

      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);

  // ---- SAFE MIGRATIONS (NO DATA LOSS) ----
  // Add any missing columns if table existed previously.
  const migrations = [
    `ALTER TABLE events ADD COLUMN eventDetails TEXT`,
    `ALTER TABLE events ADD COLUMN goodToKnow TEXT`,
    `ALTER TABLE events ADD COLUMN ticketUrl TEXT`,
    `ALTER TABLE events ADD COLUMN ticketLabel TEXT`,
    `ALTER TABLE events ADD COLUMN imageUrl TEXT`,
    `ALTER TABLE events ADD COLUMN categories TEXT`,

    // Recurrence (canonical)
    `ALTER TABLE events ADD COLUMN hasRecurrence INTEGER DEFAULT 0`,
    `ALTER TABLE events ADD COLUMN recurrenceRule TEXT`,
    `ALTER TABLE events ADD COLUMN recurrenceDates TEXT`,
  ];

  for (const sql of migrations) {
    try {
      await run(sql);
    } catch (_) {
      // Column already exists — ignore
    }
  }

  // ---- OPTIONAL COMPAT MIGRATION ----
  // If you previously used older column names, copy them forward once.
  // These will no-op if the old columns don't exist.
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

  console.log("[DB] Initialized & migrated");
}

init().catch((err) => {
  console.error("[DB] Init failed:", err);
});

module.exports = { db, run, get, all };
