"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");
const { hashPassword } = require("../lib/auth");

function sql(filename, statement, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename);
    db.all(statement, params, (error, rows) => { db.close(); error ? reject(error) : resolve(rows); });
  });
}

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Test API did not start.");
}

async function signIn(baseUrl, email, password) {
  const response = await fetch(`${baseUrl}/login`, {
    method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: email, password }).toString(),
  });
  assert.equal(response.status, 302);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

function eventForm(overrides = {}) {
  return new URLSearchParams({
    city: "Enumclaw", title: "Lifecycle Event", description: "Original description", location: "Town Hall", organizer: "Arts Council",
    startDateTime: "2027-01-10T18:00", endDateTime: "2027-01-10T20:00", forceDuplicateSave: "1",
    ...overrides,
  }).toString();
}

test("event revisions, lifecycle transitions, tombstones, and city cursor feeds are additive", async (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-lifecycle-changes-"));
  const dbPath = path.join(testDir, "opencircle.db");
  const port = 38000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."), env: { ...process.env, DB_PATH: dbPath, PORT: String(port) }, stdio: "ignore",
  });
  t.after(() => { server.kill(); fs.rmSync(testDir, { recursive: true, force: true }); });
  await waitForHealth(baseUrl);

  const password = "lifecycle test password";
  await sql(dbPath, "INSERT INTO users (email, username, passwordHash, role, city) VALUES (?, ?, ?, ?, ?)", ["developer@example.test", "developer", hashPassword(password), "developer", "Enumclaw"]);
  const cookie = await signIn(baseUrl, "developer@example.test", password);

  const create = await fetch(`${baseUrl}/admin/events`, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: eventForm(),
  });
  assert.equal(create.status, 302);
  let rows = await sql(dbPath, "SELECT id, revision, lifecycleState, publishedAt FROM events WHERE slug = 'lifecycle-event'");
  assert.equal(rows.length, 1);
  const eventId = rows[0].id;
  assert.equal(rows[0].revision, 1);
  assert.equal(rows[0].lifecycleState, "scheduled");
  assert.ok(rows[0].publishedAt);
  assert.equal((await sql(dbPath, "SELECT COUNT(*) AS count FROM event_changes WHERE eventId = ?", [eventId]))[0].count, 1);

  const noOp = await fetch(`${baseUrl}/admin/events`, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: eventForm({ id: String(eventId) }),
  });
  assert.equal(noOp.status, 302);
  assert.equal((await sql(dbPath, "SELECT revision FROM events WHERE id = ?", [eventId]))[0].revision, 1);
  assert.equal((await sql(dbPath, "SELECT COUNT(*) AS count FROM event_changes WHERE eventId = ?", [eventId]))[0].count, 1);

  const updated = await fetch(`${baseUrl}/admin/events`, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: eventForm({ id: String(eventId), description: "Updated description" }),
  });
  assert.equal(updated.status, 302);
  assert.equal((await sql(dbPath, "SELECT revision FROM events WHERE id = ?", [eventId]))[0].revision, 2);

  const cancelled = await fetch(`${baseUrl}/admin/events/${eventId}/lifecycle`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ state: "cancelled", reason: "Weather closure" }),
  });
  assert.equal(cancelled.status, 200);
  assert.deepEqual(await cancelled.json(), { ok: true, changed: true, eventId, revision: 3, state: "cancelled" });
  const detail = await fetch(`${baseUrl}/events/${eventId}`);
  assert.equal(detail.status, 200);
  const lifecycle = (await detail.json()).data.lifecycle;
  assert.equal(lifecycle.state, "cancelled");
  assert.equal(lifecycle.revision, 3);
  assert.equal(lifecycle.reason, "Weather closure");
  assert.equal(lifecycle.label, "Cancelled");
  assert.equal(lifecycle.notice, "This event has been cancelled.");
  assert.equal((await (await fetch(`${baseUrl}/events/${eventId}`)).json()).data.structuredData.eventStatus, "https://schema.org/EventCancelled");

  const invalidTransition = await fetch(`${baseUrl}/admin/events/${eventId}/lifecycle`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ state: "rescheduled" }),
  });
  assert.equal(invalidTransition.status, 409);

  const rescheduleCreate = await fetch(`${baseUrl}/admin/events`, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: eventForm({ title: "Reschedule Event", description: "Ready to move", startDateTime: "2027-01-12T18:00", endDateTime: "2027-01-12T20:00" }),
  });
  assert.equal(rescheduleCreate.status, 302);
  const rescheduleId = (await sql(dbPath, "SELECT id FROM events WHERE slug = 'reschedule-event'"))[0].id;
  const rescheduled = await fetch(`${baseUrl}/admin/events`, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: eventForm({ id: String(rescheduleId), title: "Reschedule Event", description: "Ready to move", startDateTime: "2027-01-19T18:00", endDateTime: "2027-01-19T20:00", lifecycleAction: "rescheduled", lifecycleReason: "Moved one week" }),
  });
  assert.equal(rescheduled.status, 302);
  const rescheduledRow = (await sql(dbPath, "SELECT lifecycleState, lifecycleReason, revision, startDateTime FROM events WHERE id = ?", [rescheduleId]))[0];
  assert.equal(rescheduledRow.lifecycleState, "rescheduled");
  assert.equal(rescheduledRow.lifecycleReason, "Moved one week");
  assert.equal(rescheduledRow.revision, 2);
  assert.match(rescheduledRow.startDateTime, /^2027-01-19T18:00/);
  assert.deepEqual((await sql(dbPath, "SELECT changeType FROM event_changes WHERE eventId = ? ORDER BY id DESC LIMIT 1", [rescheduleId]))[0], { changeType: "lifecycle" });

  const recurringCreate = await fetch(`${baseUrl}/admin/events`, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: eventForm({ title: "Recurring Lifecycle Event", description: "Series", startDateTime: "2027-01-13T18:00", endDateTime: "2027-01-13T20:00", hasRecurrence: "1", recurrenceType: "weekly", weeklyByDay: "WE" }),
  });
  assert.equal(recurringCreate.status, 302);
  const recurringId = (await sql(dbPath, "SELECT id FROM events WHERE slug = 'recurring-lifecycle-event'"))[0].id;
  const missingSeriesConfirmation = await fetch(`${baseUrl}/admin/events`, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: eventForm({ id: String(recurringId), title: "Recurring Lifecycle Event", description: "Series", startDateTime: "2027-01-20T18:00", endDateTime: "2027-01-20T20:00", hasRecurrence: "1", recurrenceType: "weekly", weeklyByDay: "WE", lifecycleAction: "rescheduled" }),
  });
  assert.equal(missingSeriesConfirmation.status, 400);

  await sql(dbPath, "INSERT INTO users (email, username, passwordHash, role, city) VALUES (?, ?, ?, ?, ?)", ["organizer@example.test", "Owner Group", hashPassword(password), "organizer", "Enumclaw"]);
  const organizerCookie = await signIn(baseUrl, "organizer@example.test", password);
  await sql(dbPath, "INSERT INTO events (city, slug, title, description, location, organizer, startDateTime, endDateTime) VALUES ('Enumclaw', 'organizer-owned', 'Organizer Owned', 'Description', 'Hall', 'Owner Group', '2027-01-14T18:00:00-08:00', '2027-01-14T20:00:00-08:00')");
  await sql(dbPath, "INSERT INTO events (city, slug, title, description, location, organizer, startDateTime, endDateTime) VALUES ('Enumclaw', 'other-owned', 'Other Owned', 'Description', 'Hall', 'Another Group', '2027-01-14T18:00:00-08:00', '2027-01-14T20:00:00-08:00')");
  const organizerOwnedId = (await sql(dbPath, "SELECT id FROM events WHERE slug = 'organizer-owned'"))[0].id;
  const otherOwnedId = (await sql(dbPath, "SELECT id FROM events WHERE slug = 'other-owned'"))[0].id;
  const organizerPostpone = await fetch(`${baseUrl}/admin/events/${organizerOwnedId}/lifecycle`, {
    method: "POST", headers: { cookie: organizerCookie, "content-type": "application/json" }, body: JSON.stringify({ state: "postponed", reason: "New date pending" }),
  });
  assert.equal(organizerPostpone.status, 200);
  const organizerForbidden = await fetch(`${baseUrl}/admin/events/${otherOwnedId}/lifecycle`, {
    method: "POST", headers: { cookie: organizerCookie, "content-type": "application/json" }, body: JSON.stringify({ state: "cancelled" }),
  });
  assert.equal(organizerForbidden.status, 403);

  await sql(dbPath, "INSERT INTO events (city, slug, title, description, location, organizer, startDateTime, endDateTime) VALUES ('Buckley', 'other-city', 'Other City', 'Description', 'Hall', 'Organizer', '2027-01-11T18:00:00-08:00', '2027-01-11T20:00:00-08:00')");
  const buckleyEventId = (await sql(dbPath, "SELECT id FROM events WHERE slug = 'other-city'"))[0].id;
  await sql(dbPath, "INSERT INTO event_changes (eventId, city, revision, changeType) VALUES (?, 'Buckley', 1, 'created')", [buckleyEventId]);
  const feed = await fetch(`${baseUrl}/events/changes?city=Enumclaw&after=0&limit=2`);
  assert.equal(feed.status, 200);
  const firstPage = await feed.json();
  assert.equal(firstPage.data.length, 2);
  assert.equal(firstPage.meta.hasMore, true);
  assert.ok(firstPage.data.every((item) => item.eventId === eventId && item.lifecycleState !== "deleted"));
  const cityChanges = firstPage.data.slice();
  let pageMeta = firstPage.meta;
  while (pageMeta.hasMore) {
    const page = await fetch(`${baseUrl}/events/changes?city=Enumclaw&after=${pageMeta.nextCursor}&limit=2`);
    assert.equal(page.status, 200);
    const payload = await page.json();
    cityChanges.push(...payload.data);
    pageMeta = payload.meta;
  }
  assert.ok(cityChanges.some((item) => item.eventId === eventId && item.lifecycleState === "cancelled"));
  assert.ok(cityChanges.some((item) => item.eventId === rescheduleId && item.lifecycleState === "rescheduled"));
  const buckleyFeed = await fetch(`${baseUrl}/events/changes?city=Buckley&after=0`);
  const buckleyPayload = await buckleyFeed.json();
  assert.equal(buckleyPayload.data.length, 1);
  assert.equal(buckleyPayload.data[0].eventId, buckleyEventId);

  const deleted = await fetch(`${baseUrl}/admin/events/${eventId}/delete`, { method: "POST", redirect: "manual", headers: { cookie } });
  assert.equal(deleted.status, 302);
  const tombstone = await fetch(`${baseUrl}/events/changes?city=Enumclaw&after=${pageMeta.cursor}&limit=10`);
  const tombstonePayload = await tombstone.json();
  assert.equal(tombstonePayload.data.length, 1);
  assert.deepEqual(tombstonePayload.data[0].availability, "deleted");
  assert.equal(tombstonePayload.data[0].slug, null);
  assert.equal(tombstonePayload.data[0].revision, 4);

  await sql(dbPath, "INSERT INTO events (city, slug, title, description, location, organizer, startDateTime, endDateTime) VALUES ('Enumclaw', 'archive-event', 'Archive Event', 'Description', 'Hall', 'Organizer', '2027-01-12T18:00:00-08:00', '2027-01-12T20:00:00-08:00')");
  const archiveId = (await sql(dbPath, "SELECT id FROM events WHERE slug = 'archive-event'"))[0].id;
  const archived = await fetch(`${baseUrl}/admin/events/${archiveId}/archive`, { method: "POST", redirect: "manual", headers: { cookie } });
  assert.equal(archived.status, 302);
  const archivedRow = (await sql(dbPath, "SELECT archived, lifecycleState, revision FROM events WHERE id = ?", [archiveId]))[0];
  assert.deepEqual(archivedRow, { archived: 1, lifecycleState: "archived", revision: 2 });
  const archiveChange = (await sql(dbPath, "SELECT changeType, revision FROM event_changes WHERE eventId = ?", [archiveId]))[0];
  assert.deepEqual(archiveChange, { changeType: "archived", revision: 2 });
});
