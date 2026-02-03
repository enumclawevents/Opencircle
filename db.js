const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.DB_PATH || './opencircle.db';
const db = new Database(path.resolve(dbPath));

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

/**
 * Initialize the database schema
 */
function initializeDatabase() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL,
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
    );

    CREATE INDEX IF NOT EXISTS idx_events_city ON events(city);
    CREATE INDEX IF NOT EXISTS idx_events_start_datetime ON events(start_datetime);
    CREATE INDEX IF NOT EXISTS idx_events_city_start ON events(city, start_datetime);
  `);

  // --- Safe migrations for existing DBs ---
  // These will throw if the column already exists; we intentionally ignore those errors.
  const tryExec = (sql) => {
    try { db.exec(sql); } catch (e) {}
  };

  tryExec(`ALTER TABLE events ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;`);
  tryExec(`ALTER TABLE events ADD COLUMN archived_at TEXT;`);
  tryExec(`ALTER TABLE events ADD COLUMN archived_reason TEXT;`);
  tryExec(`CREATE INDEX IF NOT EXISTS idx_events_archived ON events(archived);`);

  console.log('Database initialized successfully');
}

/**
 * Get all events with filtering, pagination, and sorting
 * archived: "0" (default active only) | "1" (archived only) | "all" (both)
 */
function getEvents({ city = 'Enumclaw', start, end, limit = 50, offset = 0, archived = '0' }) {
  let query =
    'SELECT id, title, description, start_datetime, end_datetime, location, organizer, archived FROM events WHERE city = ?';
  const params = [city];

  // archived filter: default active only
  const arch = String(archived);
  if (arch === '0') {
    query += ' AND archived = 0';
  } else if (arch === '1') {
    query += ' AND archived = 1';
  } // 'all' means no filter

  if (start) {
    query += ' AND start_datetime >= ?';
    params.push(start);
  }

  if (end) {
    query += ' AND start_datetime <= ?';
    params.push(end);
  }

  query += ' ORDER BY start_datetime ASC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const events = db.prepare(query).all(...params);

  // Get total count for the city (without pagination)
  let countQuery = 'SELECT COUNT(*) as count FROM events WHERE city = ?';
  const countParams = [city];

  if (arch === '0') {
    countQuery += ' AND archived = 0';
  } else if (arch === '1') {
    countQuery += ' AND archived = 1';
  }

  if (start) {
    countQuery += ' AND start_datetime >= ?';
    countParams.push(start);
  }

  if (end) {
    countQuery += ' AND start_datetime <= ?';
    countParams.push(end);
  }

  const { count } = db.prepare(countQuery).get(...countParams);

  return { city, count: events.length, total: count, events };
}

/**
 * Get a single event by ID
 */
function getEventById(id) {
  return db.prepare(`
    SELECT id, city, title, description, start_datetime, end_datetime, location, organizer,
           archived, archived_at, archived_reason,
           created_at, updated_at
    FROM events
    WHERE id = ?
  `).get(id);
}

/**
 * Create a new event
 */
function createEvent({ city, title, description, start_datetime, end_datetime, location, organizer }) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO events (city, title, description, start_datetime, end_datetime, location, organizer, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const result = stmt.run(
    city,
    title,
    description || null,
    start_datetime,
    end_datetime || null,
    location || null,
    organizer || null,
    now,
    now
  );

  return getEventById(result.lastInsertRowid);
}

/**
 * Update an existing event
 */
function updateEvent(id, updates) {
  const existing = getEventById(id);
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

  if (setClauses.length === 0) {
    return existing;
  }

  setClauses.push('updated_at = ?');
  params.push(new Date().toISOString());
  params.push(id);

  const query = `UPDATE events SET ${setClauses.join(', ')} WHERE id = ?`;
  db.prepare(query).run(...params);

  return getEventById(id);
}

/**
 * Delete an event by ID
 */
function deleteEvent(id) {
  const existing = getEventById(id);
  if (!existing) return false;

  db.prepare('DELETE FROM events WHERE id = ?').run(id);
  return true;
}

/**
 * Soft-archive an event by ID
 */
function archiveEvent(id, reason = 'manual') {
  const existing = getEventById(id);
  if (!existing) return false;

  db.prepare(`
    UPDATE events
    SET archived = 1,
        archived_at = datetime('now'),
        archived_reason = ?
    WHERE id = ?
  `).run(String(reason).slice(0, 80), id);

  return true;
}

/**
 * Unarchive an event by ID
 */
function unarchiveEvent(id) {
  const existing = getEventById(id);
  if (!existing) return false;

  db.prepare(`
    UPDATE events
    SET archived = 0,
        archived_at = NULL,
        archived_reason = NULL
    WHERE id = ?
  `).run(id);

  return true;
}

/**
 * Close the database connection
 */
function closeDatabase() {
  db.close();
}

module.exports = {
  db,
  initializeDatabase,
  getEvents,
  getEventById,
  createEvent,
  updateEvent,
  deleteEvent,
  archiveEvent,
  unarchiveEvent,
  closeDatabase
};
