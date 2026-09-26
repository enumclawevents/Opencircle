"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");

function execSql(filename, sql) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename);
    db.exec(sql, (error) => {
      db.close();
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      if ((await fetch(`${baseUrl}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test API did not start.");
}

function isoAt(baseMs, days, hour = 12) {
  const date = new Date(baseMs + days * 86400 * 1000);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

test("events API uses date-range overlap and keeps ongoing events out of past results", async (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-events-dates-"));
  const dbPath = path.join(testDir, "opencircle.db");
  const port = 33000 + Math.floor(Math.random() * 1000);
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
  const now = Date.now();
  const rangeStart = isoAt(now, 10, 0);
  const rangeEnd = isoAt(now, 12, 23);
  const values = [
    ["inside", "Range Inside", 10, 11],
    ["ends-inside", "Range Ends Inside", 9, 10],
    ["starts-inside", "Range Starts Inside", 12, 13],
    ["spans-range", "Range Spans Entirely", 9, 13],
    ["outside", "Range Outside", 14, 15],
    ["no-end", "Range No End", 11, null],
    ["past", "Past Event", -3, -2],
    ["ongoing", "Ongoing Event", -1, 1],
    ["future", "Future Event", 2, 2],
    ["future-tie", "Future Event Same Start", 2, 2],
    ["overnight", "Overnight Event", 4, 5],
    ["bad-end", "Invalid Legacy End", 3, 2],
  ];
  const escape = (value) => String(value).replace(/'/g, "''");
  const rows = values.map(([slug, title, start, end]) => `(
    'Community A', '${slug}', '${escape(title)}',
    '${slug === "overnight" ? isoAt(now, start, 23) : isoAt(now, start)}', ${end === null ? "NULL" : `'${slug === "overnight" ? isoAt(now, end, 1) : isoAt(now, end)}'`},
    ${slug === "future" ? 1 : 0}, ${slug === "ongoing" ? "NULL" : `'Organizer & Co.'`},
    ${slug === "no-end" ? "NULL" : "'Community Hall'"},
    ${slug === "future" ? "'[\"Music\",\"Family Events\"]'" : "'[]'"}
  )`).join(",");
  await execSql(dbPath, `
    INSERT INTO events (city, slug, title, startDateTime, endDateTime, featured, organizer, location, categories)
    VALUES ${rows};
    INSERT INTO events (city, slug, title, startDateTime, endDateTime, categories)
    VALUES ('Community B', 'other-community', 'Other Community Music', '${isoAt(now, 10)}', '${isoAt(now, 11)}', '["Music"]');
  `);

  const request = async (query) => {
    const response = await fetch(`${baseUrl}/events?city=Community%20A&windowDays=3650&expand=0&limit=100&${query}`);
    assert.equal(response.status, 200);
    return response.json();
  };
  const overlap = await request(`from=${encodeURIComponent(rangeStart)}&to=${encodeURIComponent(rangeEnd)}`);
  const overlapTitles = new Set(overlap.data.map((event) => event.title));
  for (const expected of ["Range Inside", "Range Ends Inside", "Range Starts Inside", "Range Spans Entirely", "Range No End"]) {
    assert.ok(overlapTitles.has(expected), expected);
  }
  assert.ok(!overlapTitles.has("Range Outside"));
  assert.ok(!overlapTitles.has("Other Community Music"));

  const upcoming = await request("status=upcoming");
  assert.ok(upcoming.data.some((event) => event.title === "Ongoing Event"));
  assert.ok(upcoming.data.some((event) => event.title === "Future Event"));
  const past = await request("status=past");
  assert.ok(past.data.some((event) => event.title === "Past Event"));
  assert.ok(!past.data.some((event) => event.title === "Ongoing Event"));
  assert.ok(!past.data.some((event) => event.title === "Invalid Legacy End"));

  const featured = await request("featured=1");
  assert.deepEqual(featured.data.map((event) => event.title), ["Future Event"]);
  const chronological = await request("sort=soonest");
  const futureIndex = chronological.data.findIndex((event) => event.title === "Future Event");
  const tiedFutureIndex = chronological.data.findIndex((event) => event.title === "Future Event Same Start");
  assert.ok(futureIndex >= 0 && tiedFutureIndex > futureIndex);

  const invalidSort = await fetch(`${baseUrl}/events?city=Community%20A&sort=unknown`);
  const invalidRange = await fetch(`${baseUrl}/events?city=Community%20A&from=not-a-date`);
  const invalidFeatured = await fetch(`${baseUrl}/events?city=Community%20A&featured=yes`);
  for (const response of [invalidSort, invalidRange, invalidFeatured]) {
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.deepEqual(Object.keys(payload).sort(), ["data", "error", "meta"]);
    assert.deepEqual(payload.data, []);
  }
});
