"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");
const { categorySlug, findEventCategory } = require("../lib/admin-constants");

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

test("event category slugs normalize to the canonical display category", () => {
  assert.equal(categorySlug("Food & Drink"), "food-and-drink");
  assert.equal(categorySlug("  Arts & Culture  "), "arts-and-culture");
  assert.deepEqual(findEventCategory("food-and-drink"), {
    name: "Food & Drink",
    slug: "food-and-drink",
    description: null,
  });
  assert.equal(findEventCategory("not-a-category"), null);
});

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
  const eventIso = (offsetMs) => new Date(Date.now() + offsetMs).toISOString().replace(/\.\d{3}Z$/, "-07:00");
  const recurringStart = eventIso(24 * 60 * 60 * 1000);
  const recurringEnd = eventIso(25 * 60 * 60 * 1000);
  const recurringStartLater = eventIso(48 * 60 * 60 * 1000);
  const recurringEndLater = eventIso(49 * 60 * 60 * 1000);
  const recurringRule = JSON.stringify({
    type: "custom",
    items: [
      { date: recurringStart.slice(0, 10), start: recurringStart, end: recurringEnd },
      { date: recurringStartLater.slice(0, 10), start: recurringStartLater, end: recurringEndLater },
    ],
  }).replace(/'/g, "''");
  await execSql(dbPath, `
    INSERT INTO events (city, slug, title, organizer, location, categories, startDateTime, endDateTime)
    VALUES
      ('Enumclaw', 'music-adventure', 'Music Adventure', 'Adventure Van Expo', 'Expo Center', '["Music"]', '2026-10-01T18:00:00-07:00', '2026-10-01T20:00:00-07:00'),
      ('Enumclaw', 'music-other', 'Music Other', 'Other Organizer', 'Other Venue', '["Music"]', '2026-10-02T18:00:00-07:00', '2026-10-02T20:00:00-07:00'),
      ('Enumclaw', 'music-final', 'Music Final', 'Final Organizer', 'Final Venue', '["Music"]', '2026-10-03T18:00:00-07:00', '2026-10-03T20:00:00-07:00'),
      ('Enumclaw', 'food-adventure', 'Food Adventure', 'Adventure Van Expo', 'Expo Center', '["Food & Drink"]', '2026-10-04T18:00:00-07:00', '2026-10-04T20:00:00-07:00'),
      ('Plateau Regional', 'plateau-music', 'Plateau Music', 'Adventure Van Expo', 'Plateau Hall', '["Music"]', '2026-10-02T18:00:00-07:00', '2026-10-02T20:00:00-07:00');
    INSERT INTO events (city, slug, title, organizer, location, categories, startDateTime, endDateTime, hasRecurrence, recurrenceRule)
    VALUES ('Enumclaw', 'arts-recurring', 'Arts Recurring', 'Recurrence House', 'Recurrence Studio', '["Arts & Culture"]', '${recurringStart}', '${recurringEnd}', 1, '${recurringRule}');
  `);

  const request = async (query) => {
    const response = await fetch(`${baseUrl}/events?city=Enumclaw&status=all&windowDays=3650&expand=0&${query}`);
    assert.equal(response.status, 200);
    return response.json();
  };

  const firstMusicPage = await request("category=music&limit=2&offset=0");
  const finalMusicPage = await request("category=music&limit=2&offset=2");
  const foodSlug = await request("category=food-and-drink&limit=10");
  const foodDisplayName = await request("category=Food%20%26%20Drink&limit=10");
  const organizer = await request("organizer=Adventure%20Van%20Expo&limit=10");
  const venue = await request("venue=Expo%20Center&limit=10");
  const combined = await request("category=music&organizer=Adventure%20Van%20Expo&limit=10");
  const search = await request("q=Food%20Adventure&limit=10");
  const combinedSearch = await request("q=Music&category=music&limit=10");
  const dateRange = await request("from=2026-10-02T00%3A00%3A00-07%3A00&to=2026-10-02T23%3A59%3A59-07%3A00&limit=10");
  const emptyValidCategory = await request("category=sports-and-fitness&limit=10");
  const unknownOrganizer = await request("organizer=Does%20Not%20Exist&limit=10");
  const unknown = await fetch(`${baseUrl}/events?city=Enumclaw&category=not-a-category&limit=10`);
  const malformed = await fetch(`${baseUrl}/events?city=Enumclaw&category=music&category=food`);
  const recurring = await fetch(`${baseUrl}/events?city=Enumclaw&category=arts-and-culture&status=upcoming&expand=1&windowDays=14&limit=10`);
  const plateau = await fetch(`${baseUrl}/events?city=Plateau%20Regional&category=music&status=all&windowDays=3650&expand=0&limit=10`);

  assert.equal(firstMusicPage.meta.total, 3);
  assert.equal(finalMusicPage.meta.total, 3);
  assert.equal(firstMusicPage.data.length, 2);
  assert.equal(finalMusicPage.data.length, 1);
  assert.deepEqual(firstMusicPage.meta.category, { name: "Music", slug: "music" });
  assert.deepEqual(firstMusicPage.meta.community, { city: "Enumclaw" });
  assert.equal(firstMusicPage.meta.eventCount, 3);
  assert.ok(firstMusicPage.data.every((event) => event.categories.includes("Music")));
  assert.ok(finalMusicPage.data.every((event) => event.categories.includes("Music")));
  assert.equal(foodSlug.meta.total, 1);
  assert.equal(foodSlug.data[0].title, "Food Adventure");
  assert.equal(foodDisplayName.meta.total, 1);
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
  assert.equal(emptyValidCategory.meta.total, 0);
  assert.equal(emptyValidCategory.meta.eventCount, 0);
  assert.deepEqual(emptyValidCategory.meta.category, { name: "Sports & Fitness", slug: "sports-and-fitness" });
  assert.deepEqual(emptyValidCategory.data, []);
  assert.equal(unknownOrganizer.meta.total, 0);
  assert.equal(unknown.status, 400);
  assert.deepEqual((await unknown.json()).data, []);
  assert.equal(malformed.status, 400);
  assert.equal(recurring.status, 200);
  const recurringPayload = await recurring.json();
  assert.equal(recurringPayload.meta.total, 2);
  assert.ok(recurringPayload.data.every((event) => event.title === "Arts Recurring" && event.isOccurrence));
  assert.equal(plateau.status, 200);
  const plateauPayload = await plateau.json();
  assert.equal(plateauPayload.meta.total, 1);
  assert.ok(plateauPayload.data.every((event) => event.city === "Plateau Regional"));
});
