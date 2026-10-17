"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
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
    await wait(100);
  }
  throw new Error("Test API did not start.");
}

test("public venue detail is city scoped, preserves legacy access, and delegates paginated events", async (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-venues-public-"));
  const dbPath = path.join(testDir, "opencircle.db");
  const port = 38000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port) },
    stdio: "pipe",
  });
  t.after(() => {
    server.kill();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl);
  // Initializes the additive venue schema before fixture insertion.
  assert.equal((await fetch(`${baseUrl}/venues`)).status, 200);

  const now = Date.now();
  const eventIso = (offsetMs) => new Date(now + offsetMs).toISOString().replace(/\.\d{3}Z$/, "-07:00");
  const startOne = eventIso(2 * 86400000);
  const endOne = eventIso(2 * 86400000 + 7200000);
  const startTwo = eventIso(3 * 86400000);
  const endTwo = eventIso(3 * 86400000 + 7200000);
  const recurringRule = JSON.stringify({
    type: "custom",
    items: [
      { date: startOne.slice(0, 10), start: startOne, end: endOne },
      { date: startTwo.slice(0, 10), start: startTwo, end: endTwo },
    ],
  }).replace(/'/g, "''");
  const adminToken = "venue-stable-slug-test";
  const tokenHash = crypto.createHash("sha256").update(adminToken).digest("hex");

  await execSql(dbPath, `
    INSERT INTO venues (id, city, slug, name, address, website, description, imageUrl, viewCount, phoneClickCount)
    VALUES
      (1, 'Enumclaw', 'central-hall', 'Central Hall', '1 Main St', 'https://central.example', 'Enumclaw venue', 'https://example.test/enumclaw.jpg', 8, 3),
      (2, 'Buckley', 'central-hall', 'Central Hall', '2 Main St', 'https://buckley.example', 'Buckley venue', 'https://example.test/buckley.jpg', 9, 4);
    INSERT INTO events (city, slug, title, location, organizer, startDateTime, endDateTime)
    VALUES ('Enumclaw', 'central-one', 'Central one', 'Central Hall', 'OpenCircle', '${startOne}', '${endOne}');
    INSERT INTO events (city, slug, title, location, organizer, startDateTime, endDateTime, hasRecurrence, recurrenceRule)
    VALUES ('Enumclaw', 'central-recurring', 'Central recurring', 'Central Hall', 'OpenCircle', '${startOne}', '${endOne}', 1, '${recurringRule}');
    INSERT INTO events (city, slug, title, location, organizer, startDateTime, endDateTime)
    VALUES ('Buckley', 'other-community-event', 'Other community event', 'Central Hall', 'OpenCircle', '${startOne}', '${endOne}');
    INSERT INTO users (id, email, username, role, city)
    VALUES (1, 'developer@example.test', 'developer', 'developer', 'Enumclaw');
    INSERT INTO auth_sessions (tokenHash, user, role, city, exp)
    VALUES ('${tokenHash}', 'developer', 'developer', 'Enumclaw', ${Date.now() + 3600000});
  `);

  const enumclaw = await fetch(`${baseUrl}/venues/slug/central-hall?city=Enumclaw`);
  assert.equal(enumclaw.status, 200);
  const enumclawPayload = await enumclaw.json();
  assert.equal(enumclawPayload.data.id, 1);
  assert.equal(enumclawPayload.data.city, "Enumclaw");
  assert.equal(enumclawPayload.data.description, "Enumclaw venue");
  assert.equal(enumclawPayload.data.website, "https://central.example/");
  assert.equal("viewCount" in enumclawPayload.data, false);
  assert.equal("phoneClickCount" in enumclawPayload.data, false);
  assert.equal("createdByUserId" in enumclawPayload.data, false);

  const buckley = await fetch(`${baseUrl}/venues/central-hall?city=Buckley`);
  assert.equal(buckley.status, 200);
  assert.equal((await buckley.json()).data.id, 2);
  assert.equal((await fetch(`${baseUrl}/venues/slug/central-hall?city=Wilkeson`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/venues/slug/not-a-venue?city=Enumclaw`)).status, 404);
  // Existing unscoped detail URLs remain valid for old integrations.
  assert.equal((await fetch(`${baseUrl}/venues/slug/central-hall`)).status, 200);

  const firstPage = await fetch(`${baseUrl}/venues/1/events?city=Enumclaw&limit=1&windowDays=30`);
  assert.equal(firstPage.status, 200);
  const firstPagePayload = await firstPage.json();
  assert.equal(firstPagePayload.meta.total, 3);
  assert.equal(firstPagePayload.data.length, 1);
  assert.equal(firstPagePayload.meta.hasMore, true);
  assert.equal(firstPagePayload.data[0].city, "Enumclaw");
  const secondPage = await fetch(`${baseUrl}/venues/central-hall/events?city=Enumclaw&limit=2&offset=1&windowDays=30`);
  assert.equal(secondPage.status, 200);
  const secondPagePayload = await secondPage.json();
  assert.equal(secondPagePayload.meta.total, 3);
  assert.equal(secondPagePayload.data.length, 2);
  assert.ok(secondPagePayload.data.some((event) => event.isOccurrence));
  assert.equal((await fetch(`${baseUrl}/venues/1/events?city=Buckley`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/venues/1/events`)).status, 400);

  // Updating the published venue name retains its existing externally visible slug.
  const form = new URLSearchParams({
    id: "1",
    city: "Enumclaw",
    name: "Renamed Central Hall",
    venueCategory1: "Community & Civic Spaces",
    description: "Updated description",
  });
  const update = await fetch(`${baseUrl}/admin/venues`, {
    method: "POST",
    headers: {
      cookie: `oc_auth=${adminToken}`,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
    redirect: "manual",
  });
  assert.equal(update.status, 302);
  const renamed = await fetch(`${baseUrl}/venues/slug/central-hall?city=Enumclaw`);
  assert.equal(renamed.status, 200);
  assert.equal((await renamed.json()).data.name, "Renamed Central Hall");
});
