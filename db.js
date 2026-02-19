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

// Single shared connection
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

// Safe exec (ignore “already exists” type errors)
async function tryExec(sql) {
  try {
    await run(sql);
  } catch (_) {}
}

// Schema helpers
async function tableInfo(table) {
  return await all(`PRAGMA table_info(${table})`);
}
async function hasColumn(table, col) {
  const cols = await tableInfo(table);
  return cols.some((c) => c.name === col);
}

// --------------------
// initDB (server.js expects this name)
// --------------------
async function initDB() {
  // WAL for better concurrency
  await tryExec(`PRAGMA journal_mode=WAL;`);
  await tryExec(`PRAGMA synchronous=NORMAL;`);

  // Create table with the camelCase schema used by your API/admin
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
      submissionId TEXT,
      featuredUntil TEXT,
      featuredOrderId TEXT,
      featuredPurchasedAt TEXT,
      seoTitle TEXT,
      metaDescription TEXT,
      focusKeyphrase TEXT,
      imageAlt TEXT,

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

  // Pending submissions (frontend form -> approve workflow)
  await tryExec(`
    CREATE TABLE IF NOT EXISTS pending_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,

      city TEXT NOT NULL DEFAULT 'Enumclaw',
      title TEXT NOT NULL,
      description TEXT,
      eventDetails TEXT,
      goodToKnow TEXT,

      ticketUrl TEXT,
      ticketLabel TEXT,

      startDateTime TEXT NOT NULL,
      endDateTime TEXT,

      location TEXT,
      organizer TEXT,

      imageUrl TEXT,
      eventLink TEXT,
      categories TEXT,

      submissionId TEXT,
      featuredUntil TEXT,
      featuredOrderId TEXT,
      featuredPurchasedAt TEXT,
      seoTitle TEXT,
      metaDescription TEXT,
      focusKeyphrase TEXT,
      imageAlt TEXT,

      submitterEmail TEXT,
      approvalNotes TEXT,
      source TEXT,

      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    );
  `);

  // Users (for login/signup)
  await tryExec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      username TEXT UNIQUE,
      passwordHash TEXT,
      role TEXT DEFAULT 'creator',
      city TEXT DEFAULT 'Enumclaw',
      createdAt TEXT DEFAULT (datetime('now'))
    );
  `);

  // Users: safe migrations
  const addUserCol = async (name, defSql) => {
    const cols = await tableInfo("users");
    if (!cols.some((c) => c.name === name)) await tryExec(defSql);
  };
  await addUserCol("email", `ALTER TABLE users ADD COLUMN email TEXT;`);
  await addUserCol("username", `ALTER TABLE users ADD COLUMN username TEXT;`);
  await addUserCol("passwordHash", `ALTER TABLE users ADD COLUMN passwordHash TEXT;`);
  await addUserCol("role", `ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'creator';`);
  await addUserCol("city", `ALTER TABLE users ADD COLUMN city TEXT DEFAULT 'Enumclaw';`);
  await addUserCol("createdAt", `ALTER TABLE users ADD COLUMN createdAt TEXT DEFAULT (datetime('now'));`);

  // Invites (invite-only signup)
  await tryExec(`
    CREATE TABLE IF NOT EXISTS invites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT,
      tokenHash TEXT,
      role TEXT DEFAULT 'creator',
      city TEXT DEFAULT 'Enumclaw',
      expiresAt TEXT,
      usedAt TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    );
  `);

  const addInviteCol = async (name, defSql) => {
    const cols = await tableInfo("invites");
    if (!cols.some((c) => c.name === name)) await tryExec(defSql);
  };
  await addInviteCol("role", `ALTER TABLE invites ADD COLUMN role TEXT DEFAULT 'creator';`);
  await addInviteCol("city", `ALTER TABLE invites ADD COLUMN city TEXT DEFAULT 'Enumclaw';`);

  // Migrate legacy role values
  await tryExec(`UPDATE users SET role = 'creator' WHERE role = 'city_viewer' OR role IS NULL OR role = '';`);
  await tryExec(`UPDATE users SET role = 'editor' WHERE role = 'city_editor';`);
  await tryExec(`UPDATE invites SET role = 'creator' WHERE role = 'city_viewer' OR role IS NULL OR role = '';`);
  await tryExec(`UPDATE invites SET role = 'editor' WHERE role = 'city_editor';`);

  // Password resets
  await tryExec(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      userId INTEGER,
      tokenHash TEXT,
      expiresAt TEXT,
      usedAt TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    );
  `);

  // Pending submissions: safe migrations
  const addPendingCol = async (name, defSql) => {
    const cols = await tableInfo("pending_events");
    if (!cols.some((c) => c.name === name)) await tryExec(defSql);
  };

  await addPendingCol("eventLink", `ALTER TABLE pending_events ADD COLUMN eventLink TEXT;`);
  await addPendingCol("approvalNotes", `ALTER TABLE pending_events ADD COLUMN approvalNotes TEXT;`);
  await addPendingCol("submissionId", `ALTER TABLE pending_events ADD COLUMN submissionId TEXT;`);
  await addPendingCol("featuredUntil", `ALTER TABLE pending_events ADD COLUMN featuredUntil TEXT;`);
  await addPendingCol("featuredOrderId", `ALTER TABLE pending_events ADD COLUMN featuredOrderId TEXT;`);
  await addPendingCol("featuredPurchasedAt", `ALTER TABLE pending_events ADD COLUMN featuredPurchasedAt TEXT;`);
  await addPendingCol("seoTitle", `ALTER TABLE pending_events ADD COLUMN seoTitle TEXT;`);
  await addPendingCol("metaDescription", `ALTER TABLE pending_events ADD COLUMN metaDescription TEXT;`);
  await addPendingCol("focusKeyphrase", `ALTER TABLE pending_events ADD COLUMN focusKeyphrase TEXT;`);
  await addPendingCol("imageAlt", `ALTER TABLE pending_events ADD COLUMN imageAlt TEXT;`);

  // ---- Safe migrations for older DBs ----
  // If an older DB exists with snake_case columns, add camelCase columns and keep app working.
  const hasSnakeStart = await hasColumn("events", "start_datetime");
  const hasCamelStart = await hasColumn("events", "startDateTime");

  if (hasSnakeStart && !hasCamelStart) {
    await tryExec(`ALTER TABLE events ADD COLUMN startDateTime TEXT;`);
    await tryExec(`ALTER TABLE events ADD COLUMN endDateTime TEXT;`);
    await tryExec(
      `UPDATE events SET startDateTime = start_datetime WHERE startDateTime IS NULL OR startDateTime = '';`
    );
    await tryExec(
      `UPDATE events SET endDateTime = end_datetime WHERE endDateTime IS NULL OR endDateTime = '';`
    );
  }

  // Add common columns if missing
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
  await addCol("submissionId", `ALTER TABLE events ADD COLUMN submissionId TEXT;`);
  await addCol("featuredUntil", `ALTER TABLE events ADD COLUMN featuredUntil TEXT;`);
  await addCol("featuredOrderId", `ALTER TABLE events ADD COLUMN featuredOrderId TEXT;`);
  await addCol("featuredPurchasedAt", `ALTER TABLE events ADD COLUMN featuredPurchasedAt TEXT;`);
  await addCol("seoTitle", `ALTER TABLE events ADD COLUMN seoTitle TEXT;`);
  await addCol("metaDescription", `ALTER TABLE events ADD COLUMN metaDescription TEXT;`);
  await addCol("focusKeyphrase", `ALTER TABLE events ADD COLUMN focusKeyphrase TEXT;`);
  await addCol("imageAlt", `ALTER TABLE events ADD COLUMN imageAlt TEXT;`);
  await addCol("eddiesPick", `ALTER TABLE events ADD COLUMN eddiesPick INTEGER NOT NULL DEFAULT 0;`);
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

// --------------------
// Auto-archive expired events (exported)
// --------------------
// Rule order (best-practice):
// 1) expireDate (YYYY-MM-DD) if present
// 2) endDateTime if present
// 3) startDateTime fallback
async function archiveExpiredEvents() {
  const cols = await tableInfo("events");
  const hasArchived = cols.some((c) => c.name === "archived");
  if (!hasArchived) return { archived: 0 };

  const hasExpireDate = cols.some((c) => c.name === "expireDate");
  const hasEnd = cols.some((c) => c.name === "endDateTime");
  const hasStart = cols.some((c) => c.name === "startDateTime");
  const hasArchivedAt = cols.some((c) => c.name === "archived_at");
  const hasReason = cols.some((c) => c.name === "archived_reason");
  const hasFeatured = cols.some((c) => c.name === "featured");

  let where = "";
  if (hasExpireDate) {
    where =
      "expireDate IS NOT NULL AND trim(expireDate) <> '' AND date(expireDate) < date('now')";
  } else if (hasEnd) {
    where =
      "endDateTime IS NOT NULL AND trim(endDateTime) <> '' AND datetime(endDateTime) < datetime('now')";
  } else if (hasStart) {
    where = "datetime(startDateTime) < datetime('now')";
  } else {
    return { archived: 0 };
  }

  const setArchivedAt = hasArchivedAt ? ", archived_at = datetime('now')" : "";
  const setReason = hasReason ? ", archived_reason = 'expired'" : "";
  const setFeaturedOff = hasFeatured ? ", featured = 0" : "";

  const r = await run(
    `UPDATE events
     SET archived = 1${setArchivedAt}${setReason}${setFeaturedOff}
     WHERE archived = 0
       AND ${where}`
  );

  return { archived: r.changes || 0 };
}

module.exports = {
  db,
  initDB,
  run,
  get,
  all,
  slugify,
  ensureUniqueSlug,
  archiveExpiredEvents,
  DB_PATH,
};
