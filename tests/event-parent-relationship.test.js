"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");
const { hashPassword } = require("../lib/auth");

async function sql(filename, statement, params = []) {
  const db = new sqlite3.Database(filename);
  try {
    return await new Promise((resolve, reject) => {
      db.all(statement, params, (error, rows) => error ? reject(error) : resolve(rows));
    });
  } finally {
    await new Promise(resolve => db.close(resolve));
  }
}

test("published parent links survive approval, edits and concurrent requests", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-parent-event-"));
  const database = path.join(directory, "events.db");
  const port = 42000 + Math.floor(Math.random() * 1000);
  const origin = "http://127.0.0.1:" + port;
  // Start with a legacy events table that has no relationship column.
  await sql(database, `CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL, slug TEXT, title TEXT NOT NULL,
    description TEXT, startDateTime TEXT NOT NULL, endDateTime TEXT, location TEXT, organizer TEXT
  )`);
  const start = new Date(Date.now() + 3 * 86400000).toISOString();
  const end = new Date(Date.now() + 3 * 86400000 + 3600000).toISOString();
  await sql(database, `INSERT INTO events (id, city, slug, title, startDateTime, endDateTime, location)
    VALUES (100, 'Enumclaw', 'wine-walk-current', 'Wine Walk Current', ?, ?, 'Downtown'),
           (101, 'Enumclaw', 'wine-walk-older', 'Wine Walk Older', '2023-11-10T16:00:00-08:00', '2023-11-10T20:00:00-08:00', 'Downtown'),
           (102, 'Enumclaw', 'wine-walk-archived', 'Wine Walk Archived', ?, ?, 'Downtown')`, [start, end, start, end]);
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DB_PATH: database, PORT: String(port), NODE_ENV: "test" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  server.stderr.on("data", data => { errors += data; });
  t.after(() => {
    server.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 50; attempt++) {
    try {
      if ((await fetch(origin + "/health")).ok) { ready = true; break; }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, errors);
  await sql(database, "UPDATE events SET archived = 1 WHERE id = 102");

  async function detail(key) {
    const response = await fetch(origin + "/events/" + key);
    assert.equal(response.status, 200, errors);
    return (await response.json()).data;
  }
  const options = async (q, eventId) => {
    const query = new URLSearchParams({ q, city: "Enumclaw" });
    if (eventId) query.set("eventId", eventId);
    const response = await fetch(origin + "/events/parent-options?" + query);
    assert.equal(response.status, 200, errors);
    return (await response.json()).data;
  };

  const oldEvent = await detail(100);
  assert.equal(oldEvent.parentEvent, null);
  assert.deepEqual(oldEvent.linkedEvents, []);
  const choices = await options("wine walk");
  assert.deepEqual(choices.map(event => event.id), [100, 101]);
  assert.equal(choices[0].permalinkPath, "/events/wine-walk-current");
  assert.notEqual(choices[0].startDateTime, choices[1].startDateTime);

  const afterPartyStart = new Date(Date.parse(end) + 3600000).toISOString();
  const afterPartyEnd = new Date(Date.parse(end) + 7200000).toISOString();
  const afterParty = {
    title: "Wine Walk After Party", city: "Enumclaw", description: "Live music",
    startDateTime: afterPartyStart, endDateTime: afterPartyEnd, location: "Cafe", organizer: "Local Music",
  };
  const submit = fields => fetch(origin + "/events/submit", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...afterParty, ...fields }),
  });

  const legacy = await submit({ title: "Independent Listing" });
  assert.equal(legacy.status, 200, errors);
  const legacyPending = await legacy.json();
  const pending = await submit({ parentEventId: 100 });
  assert.equal(pending.status, 200, errors);
  const submission = await pending.json();
  assert.equal((await submit({ parentEventId: 102 })).status, 400);
  assert.equal((await submit({ parentEventId: legacyPending.id })).status, 400);
  assert.equal((await submit({ parentEventId: [100] })).status, 400);
  assert.deepEqual((await detail(100)).linkedEvents, []);
  assert.deepEqual((await options("after party")), []);

  const password = "Parent test password 1!";
  await sql(database, "INSERT INTO users (email, username, passwordHash, role, city, notificationPreferencesJson) VALUES (?, ?, ?, ?, ?, ?)",
    ["parent-reviewer@example.test", "parent-reviewer", hashPassword(password), "developer", "Enumclaw", '{"eventSubmissions":false}']);
  const login = await fetch(origin + "/login", {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ username: "parent-reviewer@example.test", password }),
  });
  assert.equal(login.status, 302);
  const headers = { cookie: login.headers.get("set-cookie").split(";", 1)[0], "content-type": "application/json" };
  const adminPost = (route, fields, requestHeaders = headers) => fetch(origin + "/admin" + route, {
    method: "POST", redirect: "manual", headers: requestHeaders, body: JSON.stringify(fields),
  });
  const approval = await adminPost("/approve-events/" + submission.id + "/approve", {});
  assert.equal(approval.status, 302, errors);
  const childId = Number(new URL(approval.headers.get("location"), origin).searchParams.get("edit"));
  assert.ok(childId > 0);

  for (const [url, checked] of [
    ["/admin/create-events", false],
    ["/admin/create-events?edit=" + childId, true],
  ]) {
    const editor = await fetch(origin + url, { headers });
    assert.equal(editor.status, 200, errors);
    const html = await editor.text();
    const advanced = html.match(/<details class="event-form-advanced">([\s\S]*?)<\/details>/)?.[1];
    assert.ok(advanced);
    const toggle = advanced.match(/<input type="checkbox" data-parent-toggle[^>]*>/)?.[0];
    assert.ok(toggle);
    assert.equal(/\bchecked\b/.test(toggle), checked);
    assert.match(advanced, /name="parentEventId"/);
  }

  let child = await detail("slug/wine-walk-after-party");
  assert.equal(child.parentEventId, 100);
  assert.equal(child.parentEvent.title, "Wine Walk Current");
  assert.equal(child.parentEvent.location, "Downtown");
  assert.equal(child.parentEvent.linkedEvents, undefined);
  assert.equal(child.location, "Cafe");
  assert.equal(child.organizer, "Local Music");
  const originalTime = child.startDateTime;
  assert.deepEqual((await detail(100)).linkedEvents.map(event => event.id), [childId]);
  assert.deepEqual(await options("wine walk", 100).then(items => items.map(event => event.id)), [101]);

  const save = (event, fields, requestHeaders) => adminPost("/events", {
    id: event.id, city: event.city, title: event.title, description: event.description || "Description",
    location: event.location, organizer: event.organizer || "Organizer",
    startDateTimeISO: event.startDateTime, endDateTimeISO: event.endDateTime,
    forceDuplicateSave: "1", ...fields,
  }, requestHeaders);
  assert.equal((await save(child, { parentEventId: 101 }, { "content-type": "application/json" })).status, 401);
  assert.equal((await save(child, { parentEventId: childId })).status, 400);
  assert.equal((await save(oldEvent, { parentEventId: childId })).status, 400);
  assert.equal((await save(child, { parentEventId: 101 })).status, 302, errors);
  assert.equal((await save(child, { description: "Updated description" })).status, 302, errors);
  child = await detail(childId);
  assert.equal(child.parentEventId, 101);
  assert.equal(child.startDateTime, originalTime);
  assert.deepEqual((await detail(100)).linkedEvents, []);
  assert.deepEqual((await detail(101)).linkedEvents.map(event => event.id), [childId]);

  assert.equal((await save(await detail(101), { parentEventId: 100 })).status, 302, errors);
  assert.equal((await save(oldEvent, { parentEventId: childId })).status, 400);
  assert.equal((await save(await detail(101), { parentEventId: null })).status, 302, errors);
  await sql(database, "UPDATE events SET archived = 1 WHERE id = ?", [childId]);
  assert.deepEqual((await detail(101)).linkedEvents, []);
  await sql(database, "UPDATE events SET archived = 0 WHERE id = ?", [childId]);

  const stalePending = await submit({ title: "Later Approval", parentEventId: 101 });
  assert.equal(stalePending.status, 200);
  const stalePendingId = (await stalePending.json()).id;
  await sql(database, "UPDATE events SET lifecycleState = 'archived' WHERE id = 101");
  assert.equal((await detail(childId)).parentEventId, null);
  assert.deepEqual((await detail(101)).linkedEvents, []);
  const staleApproval = await adminPost("/approve-events/" + stalePendingId + "/approve", {});
  assert.equal(staleApproval.status, 302, errors);
  assert.equal((await detail("slug/later-approval")).parentEventId, null);
  await sql(database, "UPDATE events SET lifecycleState = 'scheduled' WHERE id = 101");
  assert.equal((await detail(childId)).parentEventId, 101);
  assert.equal((await save(child, { parentEventId: null })).status, 302, errors);
  assert.deepEqual((await detail(101)).linkedEvents, []);

  const reciprocal = await Promise.all([
    save(child, { parentEventId: 100 }),
    save(oldEvent, { parentEventId: childId }),
  ]);
  assert.deepEqual(reciprocal.map(response => response.status).sort(), [302, 400], errors);

  assert.equal((await save(oldEvent, { parentEventId: "" })).status, 302, errors);
  assert.equal((await save(child, { parentEventId: 100 })).status, 302, errors);
  const queued = await submit({ title: "Queued Before Deletion", parentEventId: 100 });
  assert.equal(queued.status, 200);
  const queuedId = (await queued.json()).id;
  assert.equal((await adminPost("/events/100/delete", {})).status, 302);
  assert.deepEqual(await sql(database, "SELECT parentEventId FROM pending_events WHERE id = ?", [queuedId]), [{ parentEventId: null }]);
  assert.equal((await detail(childId)).parentEventId, null);
  assert.deepEqual(await sql(database, "SELECT parentEventId FROM events WHERE id = ?", [childId]), [{ parentEventId: null }]);
});
