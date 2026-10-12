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

function getSql(filename, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename);
    db.get(sql, params, (err, row) => {
      db.close();
      if (err) reject(err);
      else resolve(row);
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

test("event reports are validated, persisted, and rate limited without changing event data", async (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-event-reports-"));
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
  await execSql(dbPath, `
    INSERT INTO events (city, slug, title, location, startDateTime, endDateTime)
    VALUES ('Enumclaw', 'reported-event', 'Reported Event', 'Town Hall', '2026-10-11T18:00:00-07:00', '2026-10-11T20:00:00-07:00');
  `);

  const payload = {
    reportType: "changed_details",
    message: "The organizer supplied corrected event details.",
    reporterEmail: "REPORTER@example.com",
    source: "event_page",
    eventUrl: "https://example.test/events/reported-event",
    changes: [
      { field: "location", before: "Old Hall", after: "Town Hall" },
      { field: "ticketUrl", before: null, after: "https://tickets.example.test/reported-event" },
    ],
  };
  const createdResponse = await fetch(`${baseUrl}/events/1/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(createdResponse.status, 201);
  const created = await createdResponse.json();
  assert.equal(created.ok, true);
  assert.equal(created.report.eventId, 1);
  assert.equal(created.report.status, "open");
  assert.equal(typeof created.report.id, "number");
  assert.ok(created.report.createdAt);

  const stored = await getSql(
    dbPath,
    "SELECT eventId, reportType, message, reporterEmail, source, eventUrl, changesJson, status FROM event_reports WHERE id = ?",
    [created.report.id]
  );
  assert.deepEqual(stored, {
    eventId: 1,
    reportType: "changed_details",
    message: payload.message,
    reporterEmail: "reporter@example.com",
    source: "event_page",
    eventUrl: payload.eventUrl,
    changesJson: JSON.stringify(payload.changes),
    status: "open",
  });

  const event = await getSql(dbPath, "SELECT title, city FROM events WHERE id = 1");
  assert.deepEqual(event, { title: "Reported Event", city: "Enumclaw" });

  const invalidResponse = await fetch(`${baseUrl}/events/1/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, message: "", reporterEmail: "not-an-email" }),
  });
  assert.equal(invalidResponse.status, 400);
  assert.deepEqual(await invalidResponse.json(), {
    ok: false,
    error: "validation_error",
    message: "Report description must be between 1 and 3000 characters.",
  });

  const invalidChangesResponse = await fetch(`${baseUrl}/events/1/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ...payload,
      changes: [{ field: "untrustedMetadata", before: "one", after: "two" }],
    }),
  });
  assert.equal(invalidChangesResponse.status, 400);
  assert.deepEqual(await invalidChangesResponse.json(), {
    ok: false,
    error: "validation_error",
    message: "A changed field is not supported.",
  });

  const missingEventResponse = await fetch(`${baseUrl}/events/999/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  assert.equal(missingEventResponse.status, 404);
  assert.deepEqual(await missingEventResponse.json(), {
    ok: false,
    error: "not_found",
    message: "Event not found.",
  });

  for (const message of ["One", "Two"]) {
    const response = await fetch(`${baseUrl}/events/1/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, reportType: "other", message }),
    });
    assert.equal(response.status, 201);
  }
  const rateLimited = await fetch(`${baseUrl}/events/1/reports`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...payload, reportType: "other", message: "Three" }),
  });
  assert.equal(rateLimited.status, 429);
  assert.equal(rateLimited.headers.get("retry-after"), "900");
  assert.deepEqual(await rateLimited.json(), {
    ok: false,
    error: "rate_limited",
    message: "Too many reports were submitted. Please try again later.",
  });
});
