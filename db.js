const sqlite3 = require("sqlite3").verbose();
const path = require("path");

// Use a persistent file (Render-compatible)
const DB_PATH = path.join(__dirname, "opencircle.db");

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) {
    console.error("Failed to connect to SQLite:", err.message);
  } else {
    console.log("Connected to SQLite database");
  }
});

/**
 * Helpers (promise-based)
 */
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
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

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

/**
 * Initialize tables + safe migrations
 */
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      eventDetails TEXT,
      goodToKnow TEXT,
      ticketUrl TEXT,
      ticketLabel TEXT,
      startDateTime TEXT NOT NULL,
      endDateTime TEXT NOT NULL,
      location TEXT NOT NULL,
      organizer TEXT NOT NULL,
      imageUrl TEXT,
      updatedAt TEXT
    )
  `);

  // Safe migration helper (SQLite throws if column exists)
  const safeAddColumn = (sql) => {
    db.run(sql, (err) => {
      if (err) {
        const msg = String(err.message || "").toLowerCase();
        const isDup =
          msg.includes("duplicate column") ||
          msg.includes("already exists") ||
          msg.includes("duplicate") ||
          msg.includes("exists");
        if (!isDup) console.error("Migration error:", err.message);
      }
    });
  };

  // In case DB existed before these columns
  safeAddColumn("ALTER TABLE events ADD COLUMN imageUrl TEXT");
  safeAddColumn("ALTER TABLE events ADD COLUMN eventDetails TEXT");
  safeAddColumn("ALTER TABLE events ADD COLUMN goodToKnow TEXT");
  safeAddColumn("ALTER TABLE events ADD COLUMN ticketUrl TEXT");
  safeAddColumn("ALTER TABLE events ADD COLUMN ticketLabel TEXT");
});

module.exports = {
  db,
  run,
  all,
  get,
};
