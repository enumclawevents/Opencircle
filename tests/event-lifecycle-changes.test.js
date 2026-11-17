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
  await sql(dbPath, "INSERT INTO users (email, username, passwordHash, role, city) VALUES (?, ?, ?, ?, ?)", ["developer@example.test", "developer", await hashPassword(password), "developer", "Enumclaw"]);
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

  await sql(dbPath, "INSERT INTO users (email, username, passwordHash, role, city) VALUES (?, ?, ?, ?, ?)", ["organizer@example.test", "Owner Group", await hashPassword(password), "organizer", "Enumclaw"]);
  const organizerCookie = await signIn(baseUrl, "organizer@example.test", password);
  await sql(dbPath, "INSERT INTO events (city, slug, title, description, location, organizer, startDateTime, endDateTime) VALUES ('Enumclaw', 'organizer-owned', 'Organizer Owned', 'Description', 'Hall', 'Owner Group', '2027-01-14T18:00:00-08:00', '2027-01-14T20:00:00-08:00')");
  await sql(dbPath, "INSERT INTO events (city, slug, title, description, location, organizer, startDateTime, endDateTime) VALUES ('Enumclaw', 'other-owned', 'Other Owned', 'Description', 'Hall', 'Another Group', '2027-01-14T18:00:00-08:00', '2027-01-14T20:00:00-08:00')");
  const organizerOwnedId = (await sql(dbPath, "SELECT id FROM events WHERE slug = 'organizer-owned'"))[0].id;
  const otherOwnedId = (await sql(dbPath, "SELECT id FROM events WHERE slug = 'other-owned'"))[0].id;
  await sql(dbPath, "INSERT INTO event_additional_organizers VALUES (?, 'Owner Group', 'owner group', 0)", [otherOwnedId]);
  const coOrganizerEdit = await fetch(`${baseUrl}/admin/events`, {
    method: "POST", redirect: "manual", headers: { cookie: organizerCookie, "content-type": "application/x-www-form-urlencoded" },
    body: eventForm({ id: String(otherOwnedId) }),
  });
  assert.equal(coOrganizerEdit.status, 403);
  const otherDetail = await fetch(`${baseUrl}/events/${otherOwnedId}`);
  assert.equal(otherDetail.status, 200);
  const otherPublicEvent = (await otherDetail.json()).data;
  assert.equal(otherPublicEvent.organizer, "Another Group");
  assert.equal(Object.hasOwn(otherPublicEvent, "additionalOrganizers"), false);
  assert.deepEqual(otherPublicEvent.organizers, [
    { name: "Another Group", role: "primary" }, { name: "Owner Group", role: "additional" },
  ]);
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

test("the authenticated editor preserves additional organizers through drafts and publication", async (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-organizer-editor-"));
  const dbPath = path.join(testDir, "opencircle.db");
  const port = 35000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."), env: { ...process.env, DB_PATH: dbPath, PORT: String(port) }, stdio: "ignore",
  });
  t.after(() => { server.kill(); fs.rmSync(testDir, { recursive: true, force: true }); });
  await waitForHealth(baseUrl);
  const password = "organizer editor test password";
  const passwordHash = await hashPassword(password);
  for (const [username, role] of [["editor", "developer"], ["Guest Partners", "organizer"]]) {
    await sql(dbPath, "INSERT INTO users (username, passwordHash, role, city) VALUES (?, ?, ?, 'Enumclaw')", [username, passwordHash, role]);
  }
  const cookie = await signIn(baseUrl, "editor", password);
  const organizerCookie = await signIn(baseUrl, "Guest Partners", password);
  const post = (fields, names, auth = cookie) => {
    const body = new FormData();
    for (const [key, value] of new URLSearchParams(eventForm(fields))) body.append(key, value);
    if (names !== undefined) {
      body.append("additionalOrganizersPresent", "1");
      for (const name of names) body.append("additionalOrganizers", name);
    }
    return fetch(`${baseUrl}/admin/events`, { method: "POST", redirect: "manual", headers: { cookie: auth }, body });
  };
  const editor = (query, auth = cookie) => fetch(`${baseUrl}/admin/create-events?${query}`, { headers: { cookie: auth } });
  const namesFor = async (id) => (await sql(dbPath,
    "SELECT name FROM event_additional_organizers WHERE eventId = ? ORDER BY position", [id])).map(({ name }) => name);
  const editTokenFor = async (id) => (await sql(dbPath, "SELECT editToken FROM event_unpublished_changes WHERE eventId = ?", [id]))[0]?.editToken;
  const newEvent = { title: "Additional Organizer Fixture" };
  const initialNames = ["Guest Partners", "Friends & Arts, Inc."];
  const draft = await post({ ...newEvent, saveDraft: "1" }, initialNames);
  assert.equal(draft.status, 303);
  const draftId = new URL(draft.headers.get("location"), baseUrl).searchParams.get("draft");
  assert.ok(draftId);
  assert.match(await (await editor(`draft=${draftId}`)).text(), /Friends &amp; Arts, Inc\./);
  assert.equal((await editor(`draft=${draftId}`, organizerCookie)).status, 404);
  assert.equal((await post({ ...newEvent, saveDraft: "1", draftId })).status, 303);
  assert.equal((await post({ ...newEvent, draftId })).status, 302);
  const [{ id }] = await sql(dbPath, "SELECT id FROM events WHERE title = ?", [newEvent.title]);
  assert.deepEqual(await namesFor(id), initialNames);
  assert.match(await (await editor(`edit=${id}`)).text(), /Friends &amp; Arts, Inc\./);

  const suggestions = `${baseUrl}/admin/event-field-suggestions?type=organizer&city=Enumclaw&q=friends`;
  assert.deepEqual((await (await fetch(suggestions, { headers: { cookie } })).json()).data,
    [{ value: "Friends & Arts, Inc.", city: "Enumclaw" }]);
  assert.equal((await fetch(suggestions, { headers: { cookie: organizerCookie } })).status, 403);

  const edit = { ...newEvent, id: String(id), eventBaseRevision: "1", eventEditToken: "" };
  assert.equal((await post({ ...edit, saveChangesDraft: "1" }, ["Guest Partners"], organizerCookie)).status, 403);
  const duplicate = await post({ ...edit, saveChangesDraft: "1" }, [" arts  council "]);
  assert.equal(duplicate.status, 400);
  assert.match(await duplicate.text(), /must be unique/);
  assert.equal(await editTokenFor(id), undefined);
  assert.equal((await post({ ...edit, saveChangesDraft: "1" }, ["Guest Partners"])).status, 303);
  assert.deepEqual(await namesFor(id), initialNames);
  const publicMatch = async () => (await (await fetch(
    baseUrl + "/events?city=Enumclaw&status=all&windowDays=3650&expand=0&organizer=Friends%20%26%20Arts%2C%20Inc."
  )).json()).data;
  const cached = await publicMatch();
  assert.deepEqual(cached.map(event => event.id), [id]);
  assert.ok(cached[0].organizers.some(({ name }) => name === "Friends & Arts, Inc."));
  const eventEditToken = await editTokenFor(id);
  const revisionDraft = await (await editor(`edit=${id}`)).text();
  assert.match(revisionDraft, /name="additionalOrganizers" value="Guest Partners"/);
  assert.doesNotMatch(revisionDraft, /name="additionalOrganizers" value="Friends/);

  assert.equal((await post({ ...edit, eventEditToken: "stale" }, [])).status, 409);
  assert.equal((await post({ ...edit, eventEditToken })).status, 302);
  assert.deepEqual(await namesFor(id), ["Guest Partners"]);
  assert.deepEqual(await publicMatch(), []);
  assert.equal((await post({ ...edit, eventBaseRevision: "2" }, ["Guest Partners"])).status, 302);
  assert.equal((await sql(dbPath, "SELECT revision FROM events WHERE id = ?", [id]))[0].revision, 2);
  assert.equal((await post({ ...edit, eventBaseRevision: "2" }, [])).status, 302);
  assert.deepEqual(await namesFor(id), []);
  assert.deepEqual((await sql(dbPath, "SELECT organizer, revision FROM events WHERE id = ?", [id]))[0],
    { organizer: "Arts Council", revision: 3 });
});

test("public additional organizers survive both approval paths, failures, and retries", async (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-organizer-approval-"));
  const dbPath = path.join(testDir, "opencircle.db");
  const port = 36000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, DB_PATH: dbPath, PORT: String(port) },
    stdio: "ignore",
  });
  t.after(() => { server.kill(); fs.rmSync(testDir, { recursive: true, force: true }); });
  await waitForHealth(baseUrl);
  const password = "approval test password";
  const passwordHash = await hashPassword(password);
  for (const [name, role] of [["approver", "admin"], ["Guest Partners", "organizer"]]) {
    await sql(dbPath, "INSERT INTO users(username,passwordHash,role,city) VALUES (?,?,?,'Enumclaw')", [name, passwordHash, role]);
  }
  const admin = await signIn(baseUrl, "approver", password);
  const organizer = await signIn(baseUrl, "Guest Partners", password);
  let submissionAddress = 0;
  const submit = (title, fields = {}) => fetch(baseUrl + "/events/submit", {
    method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `192.0.2.${++submissionAddress}` },
    body: JSON.stringify({ ...Object.fromEntries(new URLSearchParams(eventForm({ title }))), ...fields }),
  });
  const sendSubmission = async (title, fields) => {
    const response = await submit(title, fields);
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json()).id;
  };
  const approve = (id, cookie = admin) => fetch(`${baseUrl}/admin/approve-events/${id}/approve`, {
    method: "POST", redirect: "manual", headers: { cookie },
  });
  const approveInEditor = (id, title, fields = {}, cookie = admin) => fetch(baseUrl + "/admin/events", {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: eventForm({ pendingId: String(id), title, ...fields }),
  });
  const pending = (id) => sql(dbPath, "SELECT organizer, additionalOrganizersJson FROM pending_events WHERE id = ?", [id]);
  const published = (title) => sql(dbPath, "SELECT id, city, organizer, hasRecurrence FROM events WHERE title = ?", [title]);
  const names = async (id) => (await sql(dbPath,
    "SELECT name FROM event_additional_organizers WHERE eventId = ? ORDER BY position", [id])).map(({ name }) => name);

  const legacy = await sendSubmission("Legacy intake");
  assert.deepEqual(await pending(legacy), [{ organizer: "Arts Council", additionalOrganizersJson: null }]);
  assert.equal((await approve(legacy)).status, 302);
  assert.deepEqual(await names((await published("Legacy intake"))[0].id), []);

  for (const additionalOrganizers of [null, "Other", [42], [" "], ["x".repeat(201)], Array(11).fill("Other"), ["Arts  COUNCIL"], ["Same", "same"]]) {
    const response = await submit("Invalid intake", { additionalOrganizers });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).ok, false);
  }
  assert.equal((await sql(dbPath, "SELECT id FROM pending_events WHERE title = 'Invalid intake'")).length, 0);

  const suggest = (q, city = "Enumclaw", ip = "198.51.100.1") => fetch(
    `${baseUrl}/events/organizer-suggestions?${new URLSearchParams({ q, city })}`,
    { headers: { "x-forwarded-for": ip } }
  );
  const suggestions = async (q, city) => {
    const response = await suggest(q, city);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return (await response.json()).data;
  };
  assert.deepEqual(await suggestions("tS  CoUn", "enumclaw"), [{ name: "Arts Council" }]);
  assert.deepEqual(await suggestions("arts", "Buckley"), []);
  assert.deepEqual(await suggestions("a"), []);
  assert.deepEqual(await suggestions("%_"), []);
  for (const query of ["q=arts", "q=arts&q=other&city=Enumclaw", "q=arts&city=Enumclaw&city=Buckley", `q=${"x".repeat(101)}&city=Enumclaw`]) {
    assert.equal((await fetch(`${baseUrl}/events/organizer-suggestions?${query}`)).status, 400);
  }

  const partners = ["Guest Partners", "Friends  & Arts, Inc."];
  const direct = await sendSubmission("Direct intake", { additionalOrganizers: partners, hasRecurrence: "1", recurrenceType: "weekly", weeklyByDay: ["SU"] });
  assert.deepEqual(JSON.parse((await pending(direct))[0].additionalOrganizersJson), partners);
  assert.deepEqual(await published("Direct intake"), []);
  assert.deepEqual(await suggestions("friends"), []);
  const queue = await fetch(baseUrl + "/admin/approve-events", { headers: { cookie: admin } });
  assert.match(await queue.text(), /Additional organizer: Friends  &amp; Arts, Inc\./);
  assert.equal((await approve(direct, organizer)).status, 403);
  assert.equal((await approveInEditor(direct, "Direct intake", {}, organizer)).status, 403);
  assert.equal((await fetch(`${baseUrl}/admin/create-events?pending=${direct}`, { headers: { cookie: organizer } })).status, 403);
  const reviewed = await fetch(`${baseUrl}/admin/create-events?pending=${direct}`, { headers: { cookie: admin } });
  assert.match(await reviewed.text(), /Friends  &amp; Arts, Inc\./);

  await sql(dbPath, `CREATE TRIGGER fail_pending_organizer BEFORE INSERT ON event_additional_organizers
    WHEN NEW.nameKey = 'guest partners'
    BEGIN SELECT RAISE(ABORT, 'fixture association failure'); END`);
  assert.equal((await approve(direct)).status, 500);
  assert.equal((await approveInEditor(direct, "Direct intake")).status, 500);
  assert.deepEqual(await published("Direct intake"), []);
  assert.deepEqual(JSON.parse((await pending(direct))[0].additionalOrganizersJson), partners);
  assert.deepEqual(await sql(dbPath, "SELECT * FROM event_changes WHERE revision = 1 AND eventId NOT IN (SELECT id FROM events)"), []);
  await sql(dbPath, "DROP TRIGGER fail_pending_organizer");

  const directResults = await Promise.all([approve(direct), approve(direct)]);
  assert.ok(directResults.every(response => response.status === 302));
  const directRows = await published("Direct intake");
  assert.equal(directRows.length, 1);
  assert.equal(directRows[0].hasRecurrence, 1);
  assert.deepEqual(await names(directRows[0].id), partners);
  assert.deepEqual(await pending(direct), []);
  assert.equal((await approveInEditor(direct, "Direct intake")).status, 404);

  const editor = await sendSubmission("Editor intake", { additionalOrganizers: partners });
  assert.equal((await approveInEditor(editor, "Editor intake", { organizer: "guest partners" })).status, 400);
  assert.equal((await pending(editor)).length, 1);
  assert.equal((await approveInEditor(editor, "Editor intake")).status, 302);
  assert.deepEqual(await names((await published("Editor intake"))[0].id), partners);

  const plateau = await sendSubmission("Plateau intake", { city: "Plateau Regional", additionalOrganizers: partners });
  const plateauReview = await approve(plateau);
  assert.equal(plateauReview.status, 302);
  assert.match(plateauReview.headers.get("location"), /workspace=Plateau%20Regional/);
  assert.deepEqual(await published("Plateau intake"), []);
  const plateauPage = await fetch(new URL(plateauReview.headers.get("location"), baseUrl), { headers: { cookie: admin } });
  assert.match(await plateauPage.text(), /Friends  &amp; Arts, Inc\./);
  const plateauEdit = { additionalOrganizersPresent: "1", additionalOrganizers: partners[1] };
  const plateauResults = await Promise.all([
    approveInEditor(plateau, "Plateau intake", plateauEdit),
    approveInEditor(plateau, "Plateau intake", plateauEdit),
  ]);
  assert.deepEqual(plateauResults.map(response => response.status).sort(), [302, 404]);
  const plateauRows = await published("Plateau intake");
  assert.equal(plateauRows.length, 1);
  assert.equal(plateauRows[0].city, "Buckley");
  assert.equal(plateauRows[0].organizer, "Arts Council");
  assert.deepEqual(await names(plateauRows[0].id), [partners[1]]);
  assert.deepEqual(await pending(plateau), []);
  assert.deepEqual(await suggestions("FRIENDS & arts"), [{ name: partners[1] }]);
  assert.deepEqual(await suggestions("friends", "Buckley"), [{ name: partners[1] }]);
  assert.deepEqual(await suggestions("guest partners", "Buckley"), []);
  const directDetail = await (await fetch(`${baseUrl}/events/${directRows[0].id}`)).json();
  assert.equal(directDetail.data.organizer, "Arts Council");
  assert.deepEqual(directDetail.data.organizers, [
    { name: "Arts Council", role: "primary" },
    ...partners.map(name => ({ name, role: "additional" })),
  ]);
  for (const filter of ["organizer", "org"]) {
    const params = new URLSearchParams({ city: "Enumclaw", status: "all", expand: "0", [filter]: partners[1] });
    const filtered = await (await fetch(`${baseUrl}/events?${params}`)).json();
    assert.deepEqual(filtered.data.map(row => row.id).sort(), [
      directRows[0].id, (await published("Editor intake"))[0].id,
    ].sort());
  }

  const denied = await sendSubmission("Rejected intake", { organizer: "New Free-Text Name", additionalOrganizers: ["Pending Only Partner"] });
  assert.deepEqual(await suggestions("pending only"), []);
  assert.equal((await fetch(`${baseUrl}/admin/approve-events/${denied}/deny`, {
    method: "POST", redirect: "manual", headers: { cookie: admin },
  })).status, 302);
  assert.deepEqual(await pending(denied), []);
  assert.deepEqual(await published("Rejected intake"), []);
  assert.deepEqual(await suggestions("free-text"), []);

  const createPrivate = fields => fetch(baseUrl + "/admin/events", {
    method: "POST", redirect: "manual", headers: { cookie: admin, "content-type": "application/x-www-form-urlencoded" },
    body: eventForm(fields),
  });
  assert.equal((await createPrivate({ title: "Private draft", organizer: "Draft Only Organizer", saveDraft: "1" })).status, 303);
  assert.equal((await createPrivate({
    id: String(directRows[0].id), eventBaseRevision: "1", eventEditToken: "",
    title: "Direct intake", organizer: "Revision Only Organizer", saveChangesDraft: "1",
  })).status, 303);
  for (const query of ["Draft Only", "Revision Only"]) assert.deepEqual(await suggestions(query), []);
  assert.deepEqual(await suggestions("friends"), [{ name: partners[1] }]);

  for (const [name, archived, state] of [
    ["Outside Archive Flag", 1, "scheduled"], ["Outside Archive State", 0, "archived"],
    ...Array.from({ length: 12 }, (_, index) => [`Bounded Organizer ${index}`, 0, "scheduled"]),
  ]) {
    await sql(dbPath, "INSERT INTO events (city, title, startDateTime, organizer, archived, lifecycleState) VALUES ('Enumclaw', 'Suggestion Fixture', '2027-01-10T18:00', ?, ?, ?)", [name, archived, state]);
  }
  assert.deepEqual(await suggestions("outside archive"), []);
  assert.equal((await suggestions("bounded organizer")).length, 8);

  const requests = await Promise.all(Array.from({ length: 61 }, () => suggest("a", "Enumclaw", "198.51.100.2")));
  assert.equal(requests.filter(response => response.status === 200).length, 60);
  const limited = requests.find(response => response.status === 429);
  assert.equal(limited?.headers.get("retry-after"), "60");

});
