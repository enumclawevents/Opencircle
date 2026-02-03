"use strict";

const path = require("path");
const fs = require("fs");
const sqlite3 = require("sqlite3");

// --------------------
// DB location (prefer Render disk)
// --------------------
const DB_PATH =
  process.env.DB_PATH ||
  (process.env.RENDER_DISK_PATH
    ? path.join(process.env.RENDER_DISK_PATH, "opencircle.db")
    : path.join(process.cwd(), "opencircle.db"));

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

// single shared connection
const db = new sqlite3.Database(DB_PATH);

// Promisified helpers
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
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
      resolve(rows || []);
    });
  });
}

// Basic slugify
function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .trim()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Ensure slug unique (excluding optional eventId)
async function ensureUniqueSlug(baseSlug, eventId) {
  let slug = baseSlug || "event";
  let n = 2;

  while (true) {
    const row = await get(
      `SELECT id FROM events WHERE slug = ? ${eventId ? "AND id <> ?" : ""} LIMIT 1`,
      eventId ? [slug, eventId] : [slug]
    );
    if (!row) return slug;
    slug = `${baseSlug}-${n++}`;
  }
}

// Schema helpers
async function tableInfo(table) {
  return await all(`PRAGMA table_info(${table})`);
}
async function hasColumn(table, col) {
  const cols = await tableInfo(table);
  return cols.some((c) => c.name === col);
}
async function tryExec(sql) {
  try {
    await run(sql);
  } catch (_) {}
}

// --------------------
// initDB (server.js expects this name)
// --------------------
async function initDB() {
  // WAL for better concurrency
  await tryExec(`PRAGMA journal_mode=WAL;`);
  await tryExec(`PRAGMA synchronous=NORMAL;`);

  // Create table with the *camelCase* schema used by your API/admin
  await tryExec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      city TEXT NOT NULL DEFAULT 'Enumclaw',
      slug TEXT,

      title TEXT NOT NULL,
      description TEXT,
      eventDetails TEXT,
      goodToKnow TEXT,

      ticketUrl TEXT,
      ticketLabel TEXT,

      startDateTime TEXT NOT NULL,
      endDateTime TEXT,
      expireDate TEXT,

      location TEXT,
      organizer TEXT,
      host TEXT,

      imageUrl TEXT,
      featured INTEGER NOT NULL DEFAULT 0,

      categories TEXT,
      tags TEXT,

      -- Recurrence
      hasRecurrence INTEGER NOT NULL DEFAULT 0,
      recurrenceRule TEXT,
      recurrenceDates TEXT,
      recurrenceStartDate TEXT,
      recurrenceUntilDate TEXT,

      -- Analytics
      viewCount INTEGER NOT NULL DEFAULT 0,
      uniqueViewCount INTEGER NOT NULL DEFAULT 0,
      lastViewedAt TEXT,
      goingCount INTEGER NOT NULL DEFAULT 0,
      interestedCount INTEGER NOT NULL DEFAULT 0,

      -- Archive (soft delete)
      archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      archived_reason TEXT,

      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    );
  `);

  // ---- Safe migrations for older DBs ----
  // If an older DB exists with snake_case columns, add camelCase columns and keep app working.
  const hasSnakeStart = await hasColumn("events", "start_datetime");
  const hasCamelStart = await hasColumn("events", "startDateTime");

  if (hasSnakeStart && !hasCamelStart) {
    await tryExec(`ALTER TABLE events ADD COLUMN startDateTime TEXT;`);
    await tryExec(`ALTER TABLE events ADD COLUMN endDateTime TEXT;`);
    // copy data where possible
    await tryExec(`UPDATE events SET startDateTime = start_datetime WHERE startDateTime IS NULL OR startDateTime = '';`);
    await tryExec(`UPDATE events SET endDateTime = end_datetime WHERE endDateTime IS NULL OR endDateTime = '';`);
  }

  // Add common columns if missing (idempotent-ish)
  const addCol = async (name, defSql) => {
    if (!(await hasColumn("events", name))) await tryExec(defSql);
  };

  await addCol("slug", `ALTER TABLE events ADD COLUMN slug TEXT;`);
  await addCol("eventDetails", `ALTER TABLE events ADD COLUMN eventDetails TEXT;`);
  await addCol("goodToKnow", `ALTER TABLE events ADD COLUMN goodToKnow TEXT;`);
  await addCol("ticketUrl", `ALTER TABLE events ADD COLUMN ticketUrl TEXT;`);
  await addCol("ticketLabel", `ALTER TABLE events ADD COLUMN ticketLabel TEXT;`);
  await addCol("expireDate", `ALTER TABLE events ADD COLUMN expireDate TEXT;`);
  await addCol("host", `ALTER TABLE events ADD COLUMN host TEXT;`);
  await addCol("imageUrl", `ALTER TABLE events ADD COLUMN imageUrl TEXT;`);
  await addCol("featured", `ALTER TABLE events ADD COLUMN featured INTEGER NOT NULL DEFAULT 0;`);
  await addCol("categories", `ALTER TABLE events ADD COLUMN categories TEXT;`);
  await addCol("tags", `ALTER TABLE events ADD COLUMN tags TEXT;`);

  await addCol("hasRecurrence", `ALTER TABLE events ADD COLUMN hasRecurrence INTEGER NOT NULL DEFAULT 0;`);
  await addCol("recurrenceRule", `ALTER TABLE events ADD COLUMN recurrenceRule TEXT;`);
  await addCol("recurrenceDates", `ALTER TABLE events ADD COLUMN recurrenceDates TEXT;`);
  await addCol("recurrenceStartDate", `ALTER TABLE events ADD COLUMN recurrenceStartDate TEXT;`);
  await addCol("recurrenceUntilDate", `ALTER TABLE events ADD COLUMN recurrenceUntilDate TEXT;`);

  await addCol("viewCount", `ALTER TABLE events ADD COLUMN viewCount INTEGER NOT NULL DEFAULT 0;`);
  await addCol("uniqueViewCount", `ALTER TABLE events ADD COLUMN uniqueViewCount INTEGER NOT NULL DEFAULT 0;`);
  await addCol("lastViewedAt", `ALTER TABLE events ADD COLUMN lastViewedAt TEXT;`);
  await addCol("goingCount", `ALTER TABLE events ADD COLUMN goingCount INTEGER NOT NULL DEFAULT 0;`);
  await addCol("interestedCount", `ALTER TABLE events ADD COLUMN interestedCount INTEGER NOT NULL DEFAULT 0;`);

  // Archive cols
  await addCol("archived", `ALTER TABLE events ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`);
  await addCol("archived_at", `ALTER TABLE events ADD COLUMN archived_at TEXT;`);
  await addCol("archived_reason", `ALTER TABLE events ADD COLUMN archived_reason TEXT;`);

  await addCol("createdAt", `ALTER TABLE events ADD COLUMN createdAt TEXT DEFAULT (datetime('now'));`);
  await addCol("updatedAt", `ALTER TABLE events ADD COLUMN updatedAt TEXT DEFAULT (datetime('now'));`);

  // ---- Indexes (use camelCase) ----
  await tryExec(`CREATE INDEX IF NOT EXISTS idx_events_city ON events(city);`);
  await tryExec(`CREATE INDEX IF NOT EXISTS idx_events_startDateTime ON events(startDateTime);`);
  await tryExec(`CREATE INDEX IF NOT EXISTS idx_events_city_startDateTime ON events(city, startDateTime);`);
  await tryExec(`CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug);`);
  await tryExec(`CREATE INDEX IF NOT EXISTS idx_events_archived ON events(archived);`);

  console.log("[DB] Using:", DB_PATH);
  console.log("[DB] init ok");
}

module.exports = {
  db,
  initDB,
  run,
  get,
  all,
  slugify,
  ensureUniqueSlug,
  DB_PATH,
};
