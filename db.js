const path = require("path");
const sqlite3 = require("sqlite3").verbose();

// This creates (or opens) a file called opencircle.sqlite
const DB_PATH = path.join(__dirname, "opencircle.sqlite");
const db = new sqlite3.Database(DB_PATH);

// Create the events table (only runs once)
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL DEFAULT 'Enumclaw',
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      startDateTime TEXT NOT NULL,
      endDateTime TEXT NOT NULL,
      location TEXT NOT NULL,
      organizer TEXT NOT NULL,
      createdAt TEXT NOT NULL DEFAULT (datetime('now')),
      updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
});

// Helper functions so we can use async/await
function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

module.exports = { all, get, run };
