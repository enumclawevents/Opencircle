"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");
const { hashPassword } = require("../lib/auth");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function execSql(filename, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename);
    db.run(sql, params, (error) => {
      db.close();
      if (error) reject(error);
      else resolve();
    });
  });
}

function getSql(filename, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename);
    db.get(sql, params, (error, row) => {
      db.close();
      if (error) reject(error);
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

async function signIn(baseUrl, email, password) {
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: email, password }).toString(),
  });
  assert.equal(response.status, 302);
  const cookie = response.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie.split(";", 1)[0];
}

test("dashboard aggregation and personalization remain scoped to the authenticated role", async (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-dashboard-role-"));
  const dbPath = path.join(testDir, "opencircle.db");
  const port = 35000 + Math.floor(Math.random() * 1000);
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
  const password = "Role test password 1!";
  const users = [
    ["developer@example.test", "developer", "developer", "Enumclaw", JSON.stringify({ cityAccess: ["Enumclaw"] }), null],
    ["organizer@example.test", "my-organizer", "organizer", "Enumclaw", JSON.stringify({ cityAccess: ["Enumclaw"] }), JSON.stringify({ messages: true, weeklyReports: true })],
  ];
  for (const [email, username, role, city, permissionsJson, notificationPreferencesJson] of users) {
    await execSql(
      dbPath,
      "INSERT INTO users (email, username, passwordHash, role, city, permissionsJson, notificationPreferencesJson) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [email, username, hashPassword(password), role, city, permissionsJson, notificationPreferencesJson]
    );
  }

  const recent = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  await execSql(
    dbPath,
    "INSERT INTO events (city, slug, title, organizer, location, categories, startDateTime, endDateTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["Enumclaw", "organizer-event", "Organizer Event", "my-organizer", "Town Hall", JSON.stringify(["Arts"]), recent, recent]
  );
  await execSql(
    dbPath,
    "INSERT INTO events (city, slug, title, organizer, location, categories, startDateTime, endDateTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["Enumclaw", "other-event", "Other Event", "another-organizer", "Town Hall", JSON.stringify(["Music"]), recent, recent]
  );
  await execSql(
    dbPath,
    "INSERT INTO events (city, slug, title, organizer, location, categories, startDateTime, endDateTime) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["Plateau Regional", "outside-event", "Outside Event", "another-organizer", "Plateau Hall", JSON.stringify(["Sports"]), recent, recent]
  );
  await execSql(
    dbPath,
    "CREATE TABLE event_views (id INTEGER PRIMARY KEY, eventId INTEGER NOT NULL, occurrenceDate TEXT, viewedAt TEXT NOT NULL, ipHash TEXT)"
  );
  const viewedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
  await execSql(
    dbPath,
    "INSERT INTO event_views (eventId, occurrenceDate, viewedAt, ipHash) SELECT id, ?, ?, ? FROM events WHERE slug = ?",
    [recent.slice(0, 10), viewedAt, "organizer-viewer", "organizer-event"]
  );

  const developerCookie = await signIn(baseUrl, "developer@example.test", password);
  const developerResponse = await fetch(`${baseUrl}/admin/dashboard-summary?range=30d&dashboardScope=Plateau%20Regional`, {
    headers: { cookie: developerCookie, accept: "application/json" },
  });
  assert.equal(developerResponse.status, 200);
  const developerSummary = await developerResponse.json();
  assert.equal(developerSummary.role, "developer");
  assert.deepEqual(developerSummary.scope.cities, ["Enumclaw"]);
  assert.equal(developerSummary.communities.reduce((total, community) => total + community.publishedEvents, 0), 2);

  const organizerCookie = await signIn(baseUrl, "organizer@example.test", password);
  const organizerResponse = await fetch(`${baseUrl}/admin/dashboard-summary?range=30d`, {
    headers: { cookie: organizerCookie, accept: "application/json" },
  });
  assert.equal(organizerResponse.status, 200);
  const organizerSummary = await organizerResponse.json();
  assert.equal(organizerSummary.role, "organizer");
  assert.equal(organizerSummary.scope.organizerOnly, true);
  assert.equal(organizerSummary.communities.reduce((total, community) => total + community.publishedEvents, 0), 1);
  assert.deepEqual(organizerSummary.insights.categoryDistribution.map((category) => category.name), ["Arts"]);
  assert.equal(organizerSummary.insights.categoryAssignmentTotal, 1);
  assert.equal(organizerSummary.insights.weekdayViews.length, 7);
  assert.equal(organizerSummary.insights.weekdayViews.reduce((total, views) => total + views, 0), 1);

  const saveResponse = await fetch(`${baseUrl}/admin/preferences/dashboard`, {
    method: "POST",
    redirect: "manual",
    headers: { cookie: organizerCookie, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      dashboard_show_attention: "1",
      dashboard_order_attention: "3",
      dashboard_order_highlights: "1",
      dashboard_order_performance: "2",
    }).toString(),
  });
  assert.equal(saveResponse.status, 302);
  assert.equal(saveResponse.headers.get("location"), "/admin/preferences?notice=dashboard_saved");
  const stored = await getSql(dbPath, "SELECT notificationPreferencesJson FROM users WHERE email = ?", ["organizer@example.test"]);
  const preferences = JSON.parse(stored.notificationPreferencesJson);
  assert.equal(preferences.messages, true);
  assert.equal(preferences.weeklyReports, true);
  assert.deepEqual(preferences.dashboard.visible, { attention: true, highlights: false, performance: false });
  assert.deepEqual(preferences.dashboard.order, ["highlights", "performance", "attention"]);
});
