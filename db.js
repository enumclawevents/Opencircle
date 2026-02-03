'use strict';

// db.js (sqlite3-based)
// - Uses sqlite3 (already in your package.json)
// - Provides the same exported API you were using with better-sqlite3
// - Adds best-practice soft-archive fields: archived, archived_at, archived_reason
// - Includes safe migrations on startup

const path = require('path');
const sqlite3 = require('sqlite3');

// Prefer a persistent disk on Render if present
const defaultDbPath = process.env.RENDER_DISK_PATH
  ? path.join(process.env.RENDER_DISK_PATH, 'opencircle.db')
  : './opencircle.db';

const dbPath = process.env.DB_PATH || defaultDbPath;

// Create a single shared connection
// NOTE: sqlite3 verbose() is optional; leaving it off keeps logs clean.
const db = new sqlite3.Database(path.resolve(dbPath));

// Promisified helpers
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
      resolve(rows || []);
    });
  });
}

async function initializeDatabase() {
  // WAL improves concurrency and is safe for typical use
  try {
    await run("PRAGMA journal_mode = WAL");
  } catch (_) {}

  // Base schema (new DB)
  await run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL,
      slug TEXT,
      title TEXT NOT NULL,
      description TEXT,
      start_datetime TEXT NOT NULL,
      end_datetime TEXT,
      location TEXT,
      organizer TEXT,

      archived INTEGER NOT NULL DEFAULT 0,
      archived_at TEXT,
      archived_reason TEXT,

      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  await run(`CREATE INDEX IF NOT EXISTS idx_events_city ON events(city)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_events_start_datetime ON events(start_datetime)`);
  await run(`CREATE INDEX IF NOT EXISTS idx_events_city_start ON events(city, start_datetime)`);

  await run(`CREATE INDEX IF NOT EXISTS idx_events_slug ON events(slug)`);

  // Safe migrations for older DBs (ignore "duplicate column" errors)
  async function tryAlter(sql) {
    try {
      await run(sql);
    } catch (e) {
      // Ignore if column already exists
      const msg = String(e && e.message ? e.message : '');
      if (!/duplicate column name/i.test(msg)) {
        // Also ignore if SQLite says "already exists" for index
        if (!/already exists/i.test(msg)) throw e;
      }
    }
  }

  await tryAlter(`ALTER TABLE events ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
  await tryAlter(`ALTER TABLE events ADD COLUMN archived_at TEXT`);
  await tryAlter(`ALTER TABLE events ADD COLUMN slug TEXT`);

  await tryAlter(`ALTER TABLE events ADD COLUMN archived_reason TEXT`);

  await run(`CREATE INDEX IF NOT EXISTS idx_events_archived ON events(archived)`);

  console.log('Database initialized successfully:', path.resolve(dbPath));
}

/**
 * archived: "0" (default active only) | "1" (archived only) | "all" (both)
 */
async function getEvents({ city = 'Enumclaw', start, end, limit = 50, offset = 0, archived = '0' }) {
  const params = [city];
  let where = 'WHERE city = ?';

  const arch = String(archived);
  if (arch === '0') where += ' AND archived = 0';
  else if (arch === '1') where += ' AND archived = 1';

  if (start) {
    where += ' AND start_datetime >= ?';
    params.push(start);
  }
  if (end) {
    where += ' AND start_datetime <= ?';
    params.push(end);
  }

  const listSql = `
    SELECT id, title, description, start_datetime, end_datetime, location, organizer, archived
    FROM events
    ${where}
    ORDER BY start_datetime ASC
    LIMIT ? OFFSET ?
  `;

  const listParams = [...params, limit, offset];
  const events = await all(listSql, listParams);

  const countSql = `SELECT COUNT(*) AS count FROM events ${where}`;
  const countRow = await get(countSql, params);

  return { city, count: events.length, total: Number(countRow?.count || 0), events };
}

async function getEventById(id) {
  return await get(
    `
      SELECT id, city, title, description, start_datetime, end_datetime, location, organizer,
             archived, archived_at, archived_reason,
             created_at, updated_at
      FROM events
      WHERE id = ?
    `,
    [id]
  );
}

async function createEvent({ city, title, description, start_datetime, end_datetime, location, organizer }) {
  const now = new Date().toISOString();
  const result = await run(
    `
      INSERT INTO events (
        city, title, description, start_datetime, end_datetime, location, organizer, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      city,
      title,
      description || null,
      start_datetime,
      end_datetime || null,
      location || null,
      organizer || null,
      now,
      now,
    ]
  );

  return await getEventById(result.lastID);
}

async function updateEvent(id, updates) {
  const existing = await getEventById(id);
  if (!existing) return null;

  const fields = ['city', 'title', 'description', 'start_datetime', 'end_datetime', 'location', 'organizer'];
  const setClauses = [];
  const params = [];

  for (const field of fields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      params.push(updates[field]);
    }
  }

  if (setClauses.length === 0) return existing;

  setClauses.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  await run(`UPDATE events SET ${setClauses.join(', ')} WHERE id = ?`, params);
  return await getEventById(id);
}

async function deleteEvent(id) {
  const existing = await getEventById(id);
  if (!existing) return false;

  await run('DELETE FROM events WHERE id = ?', [id]);
  return true;
}

async function archiveEvent(id, reason = 'manual') {
  const existing = await getEventById(id);
  if (!existing) return false;

  await run(
    `
      UPDATE events
      SET archived = 1,
          archived_at = datetime('now'),
          archived_reason = ?
      WHERE id = ?
    `,
    [String(reason).slice(0, 80), id]
  );

  return true;
}

async function unarchiveEvent(id) {
  const existing = await getEventById(id);
  if (!existing) return false;

  await run(
    `
      UPDATE events
      SET archived = 0,
          archived_at = NULL,
          archived_reason = NULL
      WHERE id = ?
    `,
    [id]
  );

  return true;
}



// ---------- Slug helpers (used by admin/router code) ----------
function slugify(str) {
  return String(str || "")
    .toLowerCase()
    .trim()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

async function ensureUniqueSlug(baseSlug, ignoreId = null) {
  const base = slugify(baseSlug) || "event";
  let candidate = base;
  let i = 2;

  while (true) {
    const row = ignoreId
      ? await get("SELECT id FROM events WHERE slug = ? AND id != ? LIMIT 1", [candidate, ignoreId])
      : await get("SELECT id FROM events WHERE slug = ? LIMIT 1", [candidate]);

    if (!row) return candidate;
    candidate = `${base}-${i++}`;
  }
}

function closeDatabase() {
  db.close();
}

module.exports = {
  initDB: initializeDatabase,
  db,
  initializeDatabase,
  // low-level helpers (handy for routes)
  run,
  get,
  all,
  slugify,
  ensureUniqueSlug,
  // high-level API
  getEvents,
  getEventById,
  createEvent,
  updateEvent,
  deleteEvent,
  archiveEvent,
  unarchiveEvent,
  closeDatabase,
};
