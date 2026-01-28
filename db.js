// db.js
"use strict";

const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DB_PATH = process.env.DB_PATH || path.join(__dirname, "data.sqlite");

const db = new sqlite3.Database(DB_PATH);

// Ensure table exists (NO DELETES)
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT,
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
      categories TEXT,
      updatedAt TEXT
    )
  `);
});

// Helpers
function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
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

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

module.exports = { db, run, get, all };
