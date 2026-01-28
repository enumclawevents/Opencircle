// db.js
"use strict";

const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DB_FILE = process.env.DB_FILE || path.join(__dirname, "data.sqlite");
const db = new sqlite3.Database(DB_FILE);

// --- Promisified helpers ---
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
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

async function columnExists(table, col) {
  const rows = await all(`PRAGMA table_info(${table})`);
  return rows.some((r) => r && r.name === col);
}

// --- Init + auto-migrations ---
async function init() {
  // Create base table if missing (includes newest columns)
  await run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT DEFAULT 'Enumclaw',
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

      categories TEXT,             -- JSON array of strings (max 3)
      hasRecurrence INTEGER DEFAULT 0,  -- 0/1
      recurrenceRule TEXT,         -- JSON object
      recurrenceDates TEXT,        -- JSON array of YYYY-MM-DD for custom

      updatedAt TEXT
    );
  `);

  // Migrate older DBs (add missing columns safely)
  const adds = [
    ["eventDetails", "TEXT"],
    ["goodToKnow", "TEXT"],
    ["imageUrl", "TEXT"],
    ["ticketUrl", "TEXT"],
    ["ticketLabel", "TEXT"],
    ["categories", "TEXT"],
    ["hasRecurrence", "INTEGER DEFAULT 0"],
    ["recurrenceRule", "TEXT"],
    ["recurrenceDates", "TEXT"],
    ["updatedAt", "TEXT"]
  ];

  for (const [col, type] of adds) {
    // eslint-disable-next-line no-await-in-loop
    const exists = await columnExists("events", col);
    if (!exists) {
      // eslint-disable-next-line no-await-in-loop
      await run(`ALTER TABLE events ADD COLUMN ${col} ${type}`);
    }
  }
}

// Run init immediately (best-effort)
init().catch((e) => {
  console.error("DB init/migration failed:", e);
});

module.exports = { db, run, get, all };
