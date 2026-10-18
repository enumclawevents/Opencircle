"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");
const {
  hasValidEventDateRange,
  normalizeCategoryInput,
  normalizeEventDateTimes,
  normalizeMultiDaySchedule,
  requiredEventFields,
} = require("../lib/event-input");
const { findLikelyEventDuplicates } = require("../lib/event-dedupe");

function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitForHealth(baseUrl) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { if ((await fetch(`${baseUrl}/health`)).ok) return; } catch {}
    await wait(100);
  }
  throw new Error("Test API did not start.");
}

function execSql(filename, sql) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename);
    db.exec(sql, (error) => { db.close(); error ? reject(error) : resolve(); });
  });
}

test("shared event input keeps Pacific local times, default duration, and baseline validation consistent", () => {
  const normalized = normalizeEventDateTimes({
    startDateTime: "2026-11-01T01:30",
    endDateTime: "",
    defaultEndHours: 1,
  });
  assert.match(normalized.startDateTime, /^2026-11-01T01:30:00-/);
  assert.equal(hasValidEventDateRange(normalized.startDateTime, normalized.endDateTime), true);
  assert.deepEqual(requiredEventFields({ title: "A", description: "", location: "Hall" }), ["description", "startDateTime", "endDateTime", "organizer"]);
  assert.deepEqual(normalizeCategoryInput([" Music ", "", "Food & Drink"]), ["Music", "Food & Drink"]);
  assert.deepEqual(normalizeMultiDaySchedule('[{"date":"2026-10-10","startTime":"09:00","endTime":"17:00"},{"date":"bad","startTime":"09:00","endTime":"17:00"}]'), [
    { date: "2026-10-10", startTime: "09:00", endTime: "17:00" },
  ]);
});

test("production refuses implicit bootstrap credentials", () => {
  const env = { ...process.env, NODE_ENV: "production" };
  delete env.ADMIN_USER;
  delete env.ADMIN_PASS;
  const result = spawnSync(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env,
    encoding: "utf8",
    timeout: 5000,
  });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}\n${result.stdout}`, /Non-development runtimes require ADMIN_USER and ADMIN_PASS/);
});

test("duplicate detection remains advisory and requires meaningful event evidence", () => {
  const matches = findLikelyEventDuplicates({
    title: "Community Concert", location: "Town Hall", organizer: "Arts Council",
    startDateTime: "2026-10-20T18:00:00-07:00", ticketUrl: "https://tickets.example.test/concert?utm_source=mail",
  }, [
    {
      id: 1, title: "Community Concert", location: "Town Hall", organizer: "Arts Council",
      startDateTime: "2026-10-20T19:00:00-07:00", ticketUrl: "https://tickets.example.test/concert",
    },
    {
      id: 2, title: "Community Concert", location: "Other Hall", organizer: "Other Group",
      startDateTime: "2026-12-20T18:00:00-08:00", ticketUrl: "https://tickets.example.test/other",
    },
  ]);
  assert.deepEqual(matches.map((item) => item.id), [1]);
  assert.equal(matches[0].isLikelyDuplicate, true);
});

test("public submissions and engagement writes are rate limited without affecting normal requests", async (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-public-write-security-"));
  const dbPath = path.join(testDir, "opencircle.db");
  const port = 37000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port) },
    stdio: "ignore",
  });
  t.after(() => { server.kill(); fs.rmSync(testDir, { recursive: true, force: true }); });
  await waitForHealth(baseUrl);

  const submission = {
    title: "Rate limited event", description: "A complete description", location: "Town Hall", organizer: "Organizer",
    startDateTime: "2026-10-20T18:00", endDateTime: "2026-10-20T20:00",
  };
  for (let index = 0; index < 8; index += 1) {
    const response = await fetch(`${baseUrl}/events/submit`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...submission, title: `Rate limited event ${index}` }),
    });
    assert.equal(response.status, 200);
  }
  const limitedSubmission = await fetch(`${baseUrl}/events/submit`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submission),
  });
  assert.equal(limitedSubmission.status, 429);
  assert.equal(limitedSubmission.headers.get("retry-after"), "900");

  await execSql(dbPath, "INSERT INTO events (city, slug, title, ticketUrl, startDateTime, endDateTime) VALUES ('Enumclaw', 'engagement-event', 'Engagement Event', 'https://tickets.example.test/event', '2026-10-20T18:00:00-07:00', '2026-10-20T20:00:00-07:00')");
  assert.equal((await fetch(`${baseUrl}/events/1/ticket-click`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({}),
  })).status, 200);
  for (let index = 0; index < 60; index += 1) {
    const response = await fetch(`${baseUrl}/events/1/engagement`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goingDelta: 1 }),
    });
    assert.equal(response.status, 200);
  }
  const limitedEngagement = await fetch(`${baseUrl}/events/1/engagement`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goingDelta: 1 }),
  });
  assert.equal(limitedEngagement.status, 429);
  assert.equal(limitedEngagement.headers.get("retry-after"), "900");
});
