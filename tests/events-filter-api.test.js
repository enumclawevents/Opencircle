"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execSql(filename, sql) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename);
    db.exec(sql, (err) => {
      db.close();
      if (err) reject(err);
      else resolve();
    });
  });
}

async function waitForHealth(baseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError || new Error("Test API did not start.");
}

test("events API applies category, organizer, combinations, and pagination before paging", async (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-events-filter-"));
  const dbPath = path.join(testDir, "opencircle.db");
  const port = 32000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port) },
    stdio: "ignore",
  });

  t.after(() => {
    server.kill();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl);
  await execSql(dbPath, `
    INSERT INTO events (city, slug, title, organizer, location, categories, startDateTime, endDateTime)
    VALUES
      ('Enumclaw', 'music-adventure', 'Music Adventure', 'Adventure Van Expo', 'Expo Center', '["Music"]', '2026-10-01T18:00:00-07:00', '2026-10-01T20:00:00-07:00'),
      ('Enumclaw', 'music-other', 'Music Other', 'Other Organizer', 'Other Venue', '["Music"]', '2026-10-02T18:00:00-07:00', '2026-10-02T20:00:00-07:00'),
      ('Enumclaw', 'music-final', 'Music Final', 'Final Organizer', 'Final Venue', '["Music"]', '2026-10-03T18:00:00-07:00', '2026-10-03T20:00:00-07:00'),
      ('Enumclaw', 'food-adventure', 'Food Adventure', 'Adventure Van Expo', 'Expo Center', '["Food & Drink"]', '2026-10-04T18:00:00-07:00', '2026-10-04T20:00:00-07:00'),
      ('Plateau Regional', 'plateau-music', 'Plateau Music', 'Adventure Van Expo', 'Plateau Hall', '["Music"]', '2026-10-02T18:00:00-07:00', '2026-10-02T20:00:00-07:00');
  `);

  const request = async (query) => {
    const response = await fetch(`${baseUrl}/events?city=Enumclaw&status=all&windowDays=3650&expand=0&${query}`);
    assert.equal(response.status, 200);
    return response.json();
  };

  const firstMusicPage = await request("category=music&limit=2&offset=0");
  const finalMusicPage = await request("category=music&limit=2&offset=2");
  const foodSlug = await request("category=food-and-drink&limit=10");
  const organizer = await request("organizer=Adventure%20Van%20Expo&limit=10");
  const venue = await request("venue=Expo%20Center&limit=10");
  const combined = await request("category=music&organizer=Adventure%20Van%20Expo&limit=10");
  const search = await request("q=Food%20Adventure&limit=10");
  const combinedSearch = await request("q=Music&category=music&limit=10");
  const dateRange = await request("from=2026-10-02T00%3A00%3A00-07%3A00&to=2026-10-02T23%3A59%3A59-07%3A00&limit=10");
  const unknown = await request("category=not-a-category&limit=10");
  const unknownOrganizer = await request("organizer=Does%20Not%20Exist&limit=10");
  const malformed = await fetch(`${baseUrl}/events?city=Enumclaw&category=music&category=food`);

  assert.equal(firstMusicPage.meta.total, 3);
  assert.equal(finalMusicPage.meta.total, 3);
  assert.equal(firstMusicPage.data.length, 2);
  assert.equal(finalMusicPage.data.length, 1);
  assert.ok(firstMusicPage.data.every((event) => event.categories.includes("Music")));
  assert.ok(finalMusicPage.data.every((event) => event.categories.includes("Music")));
  assert.equal(foodSlug.meta.total, 1);
  assert.equal(foodSlug.data[0].title, "Food Adventure");
  assert.equal(organizer.meta.total, 2);
  assert.ok(organizer.data.every((event) => event.organizer === "Adventure Van Expo"));
  assert.equal(venue.meta.total, 2);
  assert.ok(venue.data.every((event) => event.location === "Expo Center"));
  assert.equal(combined.meta.total, 1);
  assert.equal(combined.data[0].title, "Music Adventure");
  assert.equal(search.meta.total, 1);
  assert.equal(search.data[0].title, "Food Adventure");
  assert.equal(combinedSearch.meta.total, 3);
  assert.equal(dateRange.meta.total, 1);
  assert.equal(dateRange.data[0].title, "Music Other");
  assert.equal(unknown.meta.total, 0);
  assert.deepEqual(unknown.data, []);
  assert.equal(unknownOrganizer.meta.total, 0);
  assert.equal(malformed.status, 400);
});
