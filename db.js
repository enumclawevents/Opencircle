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
 * Initialize tables
 */
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      startDateTime TEXT NOT NULL,
      endDateTime TEXT NOT NULL,
      location TEXT NOT NULL,
      organizer TEXT NOT NULL,
      imageUrl TEXT,
      updatedAt TEXT
    )
  `);

  // Safe migration: add imageUrl if it didn't exist before
  db.run(
    "ALTER TABLE events ADD COLUMN imageUrl TEXT",
    (err) => {
      if (err && !err.message.includes("duplicate column")) {
        console.error("Migration error:", err.message);
      }
    }
  );
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

module.exports = {
  db,
  run,
  all,
  get,
};
