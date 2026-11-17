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
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port), ADMIN_USER: "report-reviewer", ADMIN_PASS: "disposable report test password", SMTP_HOST: "" },
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

  for (const [reportType, message] of [["cancelled", "One"], ["other", "Two"]]) {
    const response = await fetch(`${baseUrl}/events/1/reports`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...payload, reportType, message }),
    });
    assert.equal(response.status, 201);
  }
  const cancellation = await getSql(dbPath, "SELECT reportType, status FROM event_reports WHERE eventId = 1 AND reportType = 'cancelled' LIMIT 1");
  assert.deepEqual(cancellation, { reportType: "cancelled", status: "open" });
  assert.deepEqual(await getSql(dbPath, "SELECT title, city FROM events WHERE id = 1"), { title: "Reported Event", city: "Enumclaw" });
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

  const login = await fetch(`${baseUrl}/login`, {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ username: "report-reviewer", password: "disposable report test password" }),
  });
  assert.equal(login.status, 302);
  const cookie = login.headers.get("set-cookie").split(";")[0];
  const admin = (route, options = {}) => fetch(`${baseUrl}${route}`, {
    redirect: "manual", ...options, headers: { cookie },
  });
  const cancellationRow = await getSql(dbPath, "SELECT id FROM event_reports WHERE reportType = 'cancelled'");
  const reviewUrl = `/admin/create-events?edit=1&city=Enumclaw&reviewReport=${cancellationRow.id}&reportType=cancelled`;
  const queue = await admin("/admin/event-reports?city=Enumclaw&reportType=cancelled");
  const queueMarkup = await queue.text();
  assert.match(queueMarkup, /<a class="btn btn-primary"[^>]+reviewReport=.+?>Review Event<\/a>/);
  assert.match(queueMarkup, />Mark Resolved<\/button>/);

  const review = await admin(reviewUrl);
  assert.equal(review.status, 200);
  assert.equal(review.headers.get("cache-control"), "private, no-store");
  const markup = await review.text();
  assert.match(markup, /Reported issue: Cancelled/);
  assert.match(markup, /event-report-review-message">One</);
  assert.match(markup, /event-form-schedule" data-report-review-area/);
  assert.match(markup, /id="eventLifecycleSection" data-report-review-area/);
  assert.match(markup, /reportType=cancelled[^"]*">Back to Event Reports/);
  assert.doesNotMatch(markup, /reporter@example.com/);

  const general = await admin(`/admin/create-events?edit=1&reviewReport=${created.report.id}`);
  const generalMarkup = await general.text();
  assert.match(generalMarkup, /Reported issue: Changed details/);
  assert.doesNotMatch(generalMarkup, / data-report-review-area>/);
  assert.doesNotMatch(generalMarkup, /reporter@example.com/);

  const unavailable = await admin(`/admin/create-events?edit=1234&reviewReport=${cancellationRow.id}`);
  assert.equal(unavailable.status, 302);
  assert.match(unavailable.headers.get("location"), /reportNotice=review_unavailable/);
  const anonymous = await fetch(`${baseUrl}${reviewUrl}`, { redirect: "manual" });
  assert.equal(anonymous.status, 401);

  const save = await admin("/admin/events", {
    method: "POST",
    body: new URLSearchParams({
      id: "1", city: "Enumclaw", title: "Reported Event", description: "Reviewed event",
      location: "Town Hall", organizer: "Fixture Organizer", startDateTime: "2027-01-10T18:00",
      reviewReport: String(cancellationRow.id), reportType: "cancelled", reportStatus: "open",
    }),
  });
  assert.equal(save.status, 302, await save.clone().text());
  assert.match(save.headers.get("location"), new RegExp(`reviewReport=${cancellationRow.id}`));
  assert.equal((await getSql(dbPath, "SELECT status FROM event_reports WHERE id = ?", [cancellationRow.id])).status, "open");
  assert.match(await (await admin(save.headers.get("location"))).text(), /Reported issue: Cancelled/);

  const password = "disposable organizer password";
  const passwordHash = await hashPassword(password);
  await execSql(dbPath, `
    INSERT INTO users (username, passwordHash, role, city) VALUES
      ('Fixture Organizer', '${passwordHash}', 'organizer', 'Enumclaw'),
      ('Additional Partner', '${passwordHash}', 'organizer', 'Enumclaw'),
      ('Remote Developer', '${passwordHash}', 'developer', 'Buckley');
    UPDATE users SET permissionsJson = '{"cityAccess":["Buckley"]}' WHERE username = 'Remote Developer';
    INSERT INTO event_additional_organizers (eventId, name, nameKey, position)
      VALUES (1, 'Additional Partner', 'additional partner', 0);
    INSERT INTO events (city, title, startDateTime) VALUES ('Enumclaw', 'Unrelated event', '2027-01-10T18:00:00-08:00');
  `);
  for (const username of ["Fixture Organizer", "Additional Partner", "Remote Developer"]) {
    const memberLogin = await fetch(`${baseUrl}/login`, {
      method: "POST", redirect: "manual",
      body: new URLSearchParams({ username, password }),
    });
    assert.equal(memberLogin.status, 302);
    const membersCookie = memberLogin.headers.get("set-cookie").split(";")[0];
    const memberReview = await fetch(`${baseUrl}${reviewUrl}`, {
      redirect: "manual", headers: { cookie: membersCookie },
    });
    if (username === "Fixture Organizer") {
      assert.equal(memberReview.status, 200);
      assert.match(await memberReview.text(), /Reported issue: Cancelled/);
    } else {
      assert.equal(memberReview.status, 302);
      assert.match(memberReview.headers.get("location"), /reportNotice=review_unavailable/);
    }
  }
  const mismatched = await admin(reviewUrl.replace("edit=1", "edit=2"));
  assert.match(mismatched.headers.get("location"), /reportNotice=review_unavailable/);

  const complete = (id, status, resolutionNote, notifyReporter = "0") => admin(`/admin/event-reports/${id}/status`, {
    method: "POST",
    body: new URLSearchParams({ status, resolutionNote, notifyReporter, reportType: "cancelled" }),
  });
  const completed = await complete(cancellationRow.id, "resolved", "Checked with the organizer.");
  assert.match(completed.headers.get("location"), /reportType=cancelled&reportNotice=updated/);
  const dismissed = await Promise.all([
    complete(created.report.id, "dismissed", "Duplicate report.", "1"),
    complete(created.report.id, "dismissed", "Duplicate report.", "1"),
  ]);
  assert.deepEqual(dismissed.map(response => new URL(response.headers.get("location"), baseUrl).searchParams.get("reportNotice")).sort(),
    ["already_completed", "updated_email_not_sent"]);
  assert.deepEqual(await getSql(dbPath, "SELECT status, resolutionNote FROM event_reports WHERE id = ?", [cancellationRow.id]),
    { status: "resolved", resolutionNote: "Checked with the organizer." });
  assert.deepEqual(await getSql(dbPath, "SELECT status, resolutionNote FROM event_reports WHERE id = ?", [created.report.id]),
    { status: "dismissed", resolutionNote: "Duplicate report." });
  assert.equal((await getSql(dbPath, "SELECT status FROM event_reports WHERE reportType = 'other'")).status, "open");
  await execSql(dbPath, "UPDATE events SET archived = 1, lifecycleState = 'archived' WHERE id = 1");
  assert.match(await (await admin(reviewUrl)).text(), /Report #.*Resolved/);
  await execSql(dbPath, "DELETE FROM events WHERE id = 1");
  assert.match((await admin(reviewUrl)).headers.get("location"), /reportNotice=review_unavailable/);
});
