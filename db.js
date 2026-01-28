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
  // Base events table
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

      categories TEXT, -- JSON array

      -- Recurrence
      hasOccurrences INTEGER DEFAULT 0,
      recurrenceType TEXT,     -- none | weekly | monthly | custom
      recurrenceRule TEXT,     -- JSON (weekly/monthly rules)
      customDates TEXT,        -- JSON array of ISO strings

      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);

  // ---- SAFE MIGRATIONS (NO DATA LOSS) ----
  const migrations = [
    `ALTER TABLE events ADD COLUMN categories TEXT`,
    `ALTER TABLE events ADD COLUMN eventDetails TEXT`,
    `ALTER TABLE events ADD COLUMN goodToKnow TEXT`,
    `ALTER TABLE events ADD COLUMN ticketUrl TEXT`,
    `ALTER TABLE events ADD COLUMN ticketLabel TEXT`,
    `ALTER TABLE events ADD COLUMN imageUrl TEXT`,

    // Recurrence columns
    `ALTER TABLE events ADD COLUMN hasOccurrences INTEGER DEFAULT 0`,
    `ALTER TABLE events ADD COLUMN recurrenceType TEXT`,
    `ALTER TABLE events ADD COLUMN recurrenceRule TEXT`,
    `ALTER TABLE events ADD COLUMN customDates TEXT`,
  ];

  for (const sql of migrations) {
    try {
      await run(sql);
    } catch (_) {
      // column already exists — ignore
    }
  }

  console.log("[DB] Initialized & migrated");
}

// Run init immediately
init().catch((err) => {
  console.error("[DB] Init failed:", err);
});

module.exports = {
  db,
  run,
  get,
  all,
};
