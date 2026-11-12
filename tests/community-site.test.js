"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");
const { hashPassword } = require("../lib/auth");

function sql(filename, statement) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename);
    db.exec(statement, error => db.close(() => error ? reject(error) : resolve()));
  });
}

test("the API-hosted Enumclaw preview is public, scoped, escaped, and uses existing event data", async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-site-"));
  const database = path.join(directory, "site.db");
  const port = 41000 + Math.floor(Math.random() * 1000);
  const origin = "http://127.0.0.1:" + port;
  const base = origin + "/preview/enumclaw";
  const process = spawn(global.process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...global.process.env, DB_PATH: database, PORT: String(port), NODE_ENV: "test" },
    stdio: "pipe",
  });
  let serverOutput = "";
  process.stderr.on("data", data => { serverOutput += data; });
  t.after(() => {
    process.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(origin + "/health")).ok) { ready = true; break; }
    } catch (_) {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, serverOutput);
  // Initialize the existing public schema before inserting test-only listings.
  await fetch(origin + "/venues");
  await fetch(origin + "/updates?city=Enumclaw");
  await fetch(origin + "/jobs?city=Enumclaw");
  const start = new Date(Date.now() + 2 * 86400000).toISOString();
  const end = new Date(Date.now() + 2 * 86400000 + 3600000).toISOString();
  await sql(database, `
    INSERT INTO events (id, city, slug, title, description, startDateTime, endDateTime, categories, location, archived, featured)
    VALUES
      (9901, 'Enumclaw', 'preview-local', '<script>alert(1)</script> Local Event', 'Live database description', '${start}', '${end}', '["Music"]', 'Local Hall', 0, 1),
      (9902, 'Buckley', 'preview-other-city', 'Private to other city listing', 'Other', '${start}', '${end}', '["Music"]', 'Other Hall', 0, 0),
      (9903, 'Enumclaw', 'preview-archived', 'Archived listing', 'Old', '${start}', '${end}', '["Music"]', 'Local Hall', 1, 0);
    INSERT INTO venues (id, city, slug, name, description) VALUES
      (9901, 'Buckley', 'private-venue', 'Other city venue', 'Other'),
      (9902, 'Enumclaw', 'community-arts', 'Community Arts Center', 'Local venue');
    INSERT INTO jobs (id, city, slug, title, company, status, applicationMode, applicationFieldsJson)
      VALUES (9901, 'Enumclaw', 'local-job', 'Local Job', 'Local Company', 'active', 'website', '{"firstName":"required","email":"required"}');
  `);

  const home = await fetch(base);
  assert.equal(home.status, 200);
  assert.equal(home.headers.get("x-robots-tag"), "noindex, nofollow");
  const html = await home.text();
  assert.match(html, /Featured Events/);
  assert.match(html, /Local Event/);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>|Private to other city listing|Archived listing/);
  assert.match(html, /data-newsletter/);
  assert.match(html, /aria-controls="siteNavigation"/);
  const result = await fetch(base + "/events?q=Local&category=music");
  assert.equal(result.status, 200);
  assert.match(await result.text(), /Local Event/);
  assert.equal((await fetch(base + "/events?category=not-a-category")).status, 400);
  const detail = await fetch(base + "/events/preview-local");
  assert.equal(detail.status, 200);
  assert.match(await detail.text(), /Live database description/);
  const calendar = await fetch(base + "/events/preview-local/calendar");
  assert.equal(calendar.status, 200);
  assert.match(calendar.headers.get("content-type"), /text\/calendar/);
  const calendarBody = await calendar.text();
  assert.match(calendarBody, /BEGIN:VEVENT/);
  assert.match(calendarBody, /SUMMARY:.*Local Event/);
  assert.match(calendarBody, /LOCATION:Local Hall/);
  assert.doesNotMatch(calendarBody, /<script>/);
  assert.equal((await fetch(base + "/events/preview-other-city/calendar")).status, 404);
  assert.equal((await fetch(base + "/events/preview-archived/calendar")).status, 404);
  const filtered = await (await fetch(base + "/events?category=music&featured=1")).text();
  assert.match(filtered, /name="featured" value="1"/);
  assert.match(filtered, /category=music&amp;sort=soonest&amp;period=today&amp;featured=1/);
  assert.equal((await fetch(base + "/events/preview-other-city")).status, 404);
  assert.equal((await fetch(base + "/events/preview-archived")).status, 404);
  assert.equal((await fetch(base + "/venues/private-venue")).status, 404);

  for (const route of ["/about", "/updates", "/privacy", "/terms", "/get-involved", "/jobs", "/jobs/local-job", "/submit-event"]) {
    assert.equal((await fetch(base + route)).status, 200, route);
  }
  const job = await (await fetch(base + "/jobs/local-job")).text();
  assert.match(job, /data-job-apply/);
  assert.match(job, /name="firstName"/);
  const invalidSubmission = await fetch(base + "/submit-event", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ start: "invalid", end: "invalid" }),
  });
  assert.equal(invalidSubmission.status, 400);
  const submissionForm = await (await fetch(base + "/submit-event")).text();
  assert.match(submissionForm, /Add a Venue \(optional\)<select name="venueId"/);
  assert.match(submissionForm, /<option value="9902">Community Arts Center/);
  assert.doesNotMatch(submissionForm, /Other city venue/);
  const address = "123 Main Street";
  const venueName = "Community Arts Center";
  const submit = (venueId, submittedName) => fetch(base + "/submit-event", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: "Venue Submission", description: "A local concert", category: "Music",
      location: address, venueId, venueName: submittedName, organizer: "Arts Council",
      start: start.slice(0, 16), end: end.slice(0, 16),
    }),
  });
  assert.equal((await submit(9901, "")).status, 400);
  const submission = await submit(9902, "Ignored when an existing venue is selected");
  assert.equal(submission.status, 200);
  assert.equal((await submission.json()).ok, true);

  const password = "Preview reviewer password 1!";
  await sql(database, `
    INSERT INTO users (email, username, passwordHash, role, city)
    VALUES ('venue-reviewer@example.test', 'venue-reviewer', '${hashPassword(password)}', 'developer', 'Enumclaw');
  `);
  const login = await fetch(origin + "/login", {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ username: "venue-reviewer@example.test", password }),
  });
  assert.equal(login.status, 302);
  const headers = { cookie: login.headers.get("set-cookie").split(";", 1)[0] };
  const review = await (await fetch(origin + "/admin/approve-events", { headers })).text();
  assert.match(review, /Venue: Community Arts Center/);
  const approvalPath = review.match(/action="(\/admin\/approve-events\/\d+\/approve)"/)?.[1];
  assert.ok(approvalPath);
  const pendingId = approvalPath.split("/")[3];
  const editor = await (await fetch(origin + "/admin/create-events?pending=" + pendingId, { headers })).text();
  assert.match(editor, /<option value="9902" data-city="Enumclaw" selected>Community Arts Center/);
  const approval = await fetch(origin + approvalPath, { method: "POST", redirect: "manual", headers });
  assert.equal(approval.status, 302);
  assert.match(approval.headers.get("location"), /create-events\?edit=\d+/);
  const publishedId = new URL(approval.headers.get("location"), origin).searchParams.get("edit");
  const published = await (await fetch(origin + "/events/" + publishedId + "?track=0")).json();
  assert.equal(published.data.venueName, venueName);
  assert.equal(published.data.venueId, 9902);
  const venueEvents = await (await fetch(origin + "/venues/9902/events?city=Enumclaw")).json();
  assert.ok(venueEvents.data.some(event => event.id === Number(publishedId)));
  const venuePage = await fetch(base + "/venues/community-arts");
  assert.equal(venuePage.status, 200);
  assert.match(await venuePage.text(), /Venue Submission/);

  const saveVenue = venueId => fetch(origin + "/admin/events", {
    method: "POST", redirect: "manual", headers,
    body: new URLSearchParams({
      id: publishedId, city: "Enumclaw", title: "Venue Submission", description: "A local concert",
      location: address, organizer: "Arts Council", venueId,
      startDateTime: start, endDateTime: end,
    }),
  });
  assert.equal((await saveVenue("9901")).status, 400);
  assert.equal((await saveVenue("")).status, 302);
  const unlinked = await (await fetch(origin + "/events/" + publishedId + "?track=0")).json();
  assert.equal(unlinked.data.venueId, null);
  assert.equal(unlinked.data.location, address);
  assert.equal((await saveVenue("9902")).status, 302);
  const relinked = await (await fetch(origin + "/events/" + publishedId + "?track=0")).json();
  assert.equal(relinked.data.venueId, 9902);

  const matched = await submit(undefined, "  community arts center  ");
  assert.equal(matched.status, 200);
  const matchedReview = await (await fetch(origin + "/admin/approve-events", { headers })).text();
  assert.match(matchedReview, /Venue: Community Arts Center/);
  assert.equal((await submit("", "")).status, 200);
  assert.equal(published.data.location, address);
  assert.equal(published.data.organizer, "Arts Council");
  assert.equal((await fetch(base + "/missing-page")).status, 404);
  const api = await fetch(origin + "/events?city=Enumclaw&limit=1");
  assert.match(api.headers.get("content-type"), /application\/json/);
  assert.equal((await fetch(origin + "/admin", { redirect: "manual", headers: { Accept: "text/html" } })).status, 302);
});
