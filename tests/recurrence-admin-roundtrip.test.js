"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");
const { hashPassword } = require("../lib/auth");
const { generateOccurrences } = require("../routes/events");

function execSql(filename, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename);
    db.run(sql, params, (error) => { db.close(); error ? reject(error) : resolve(); });
  });
}

function getSql(filename, sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename);
    db.get(sql, params, (error, row) => { db.close(); error ? reject(error) : resolve(row); });
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
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ username: email, password }).toString(),
  });
  assert.equal(response.status, 302);
  return response.headers.get("set-cookie").split(";", 1)[0];
}

function schedule(event) {
  return generateOccurrences(event, Date.parse("2026-01-01T00:00:00-08:00"), Date.parse("2027-12-31T23:59:59-08:00"))
    .map((item) => [item.occurrenceDate, item.startDateTime, item.endDateTime]);
}

function formFor(row, extra = {}) {
  const values = {
    id: String(row.id), city: row.city, title: row.title, description: "Description", location: "Hall", organizer: "Organizer",
    startDateTime: row.startDateTime.slice(0, 16), endDateTime: row.endDateTime.slice(0, 16),
    startDateTimeISO: row.startDateTime, endDateTimeISO: row.endDateTime,
    hasRecurrence: "1", eventTypeChoice: "recurring", forceDuplicateSave: "1",
    recurrenceStartDate: row.recurrenceStartDate || row.startDateTime.slice(0, 10),
    recurrenceUntilDate: row.recurrenceUntilDate || "",
    ...extra,
  };
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (Array.isArray(value)) value.forEach((item) => form.append(key, item));
    else form.set(key, value == null ? "" : String(value));
  }
  return form.toString();
}

test("admin recurrence saves preserve weekly, custom, annual fallback, and ambiguous legacy schedules", async (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-recurrence-roundtrip-"));
  const dbPath = path.join(testDir, "opencircle.db");
  const port = 36000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, DB_PATH: dbPath, PORT: String(port) }, stdio: "ignore" });
  t.after(() => { server.kill(); fs.rmSync(testDir, { recursive: true, force: true }); });
  await waitForHealth(baseUrl);

  const password = "recurrence test password";
  await execSql(dbPath, "INSERT INTO users (email, username, passwordHash, role, city) VALUES (?, ?, ?, ?, ?)", ["developer@example.test", "developer", hashPassword(password), "developer", "Enumclaw"]);
  const customRule = JSON.stringify({ type: "custom", items: [
    { date: "2026-03-03", start: "2026-03-03T18:00:00-08:00", end: "2026-03-03T20:00:00-08:00", label: "Early session", source: "legacy-import" },
    { date: "2026-03-10", start: "2026-03-10T23:00:00-07:00", end: "2026-03-11T01:00:00-07:00", label: "Overnight session", source: "legacy-import" },
  ] });
  const rows = [
    ["weekly", "Weekly", "2026-02-01T18:00:00-08:00", "2026-02-01T20:00:00-08:00", JSON.stringify({ type: "weekly", interval: 2, byDay: ["SU", "WE"] }), null, "2026-02-01", null],
    ["custom", "Custom", "2026-03-03T18:00:00-08:00", "2026-03-03T20:00:00-08:00", customRule, JSON.stringify(["2026-03-03", "2026-03-10"]), "2026-03-03", null],
    ["annual", "Annual", "2026-01-15T10:00:00-08:00", "2026-01-15T12:00:00-08:00", JSON.stringify({ type: "annual", interval: 1, byMonth: 1, byMonthday: 15 }), null, "2026-01-15", null],
    ["legacy", "Legacy", "2026-02-01T16:00:00-08:00", "2027-09-17T18:00:00-07:00", JSON.stringify({ type: "weekly", interval: 1, byDay: ["SU"] }), null, "2026-02-01", null],
  ];
  for (const [slug, title, start, end, rule, dates, recurrenceStartDate, recurrenceUntilDate] of rows) {
    await execSql(dbPath, "INSERT INTO events (city, slug, title, description, location, organizer, startDateTime, endDateTime, hasRecurrence, recurrenceRule, recurrenceDates, recurrenceStartDate, recurrenceUntilDate) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)", ["Enumclaw", slug, title, "Description", "Hall", "Organizer", start, end, rule, dates, recurrenceStartDate, recurrenceUntilDate]);
  }
  const cookie = await signIn(baseUrl, "developer@example.test", password);

  // The server, not the browser's machine timezone, owns conversion of edited
  // datetime-local values. This simulates a client that intentionally omits
  // a browser-local offset after changing the first occurrence.
  const timezoneRow = await getSql(dbPath, "SELECT * FROM events WHERE slug = ?", ["weekly"]);
  const timezoneSave = await fetch(`${baseUrl}/admin/events`, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: formFor(timezoneRow, {
      startDateTime: "2026-02-01T16:00", endDateTime: "2026-02-01T18:00",
      startDateTimeISO: "", endDateTimeISO: "", recurrenceType: "weekly", recurrenceInterval: "2", weeklyByDay: ["SU", "WE"],
    }),
  });
  assert.equal(timezoneSave.status, 302);
  const timezoneSaved = await getSql(dbPath, "SELECT * FROM events WHERE id = ?", [timezoneRow.id]);
  assert.equal(timezoneSaved.startDateTime, "2026-02-01T16:00:00-08:00");
  assert.equal(timezoneSaved.endDateTime, "2026-02-01T18:00:00-08:00");

  for (const slug of ["weekly", "custom", "annual", "legacy"]) {
    const before = await getSql(dbPath, "SELECT * FROM events WHERE slug = ?", [slug]);
    const beforeSchedule = schedule(before);
    const extra = slug === "weekly"
      ? { recurrenceType: "weekly", recurrenceInterval: "2", weeklyByDay: ["SU", "WE"] }
      : slug === "custom"
        ? { recurrenceType: "custom", recurrenceDatesJson: customRule.replace(/^.*"items":/, "[").replace(/}$/, "") }
        : slug === "annual"
          ? { recurrenceType: "annual", preserveRecurrenceRule: "1", originalRecurrenceRule: before.recurrenceRule, originalRecurrenceDates: before.recurrenceDates || "" }
          : { recurrenceType: "weekly", recurrenceInterval: "1", weeklyByDay: "SU" };
    if (slug === "custom") extra.recurrenceDatesJson = JSON.stringify(JSON.parse(customRule).items);
    const response = await fetch(`${baseUrl}/admin/events`, { method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" }, body: formFor(before, extra) });
    assert.equal(response.status, 302, slug);
    const after = await getSql(dbPath, "SELECT * FROM events WHERE id = ?", [before.id]);
    assert.equal(after.startDateTime, before.startDateTime, `${slug} start`);
    assert.equal(after.endDateTime, before.endDateTime, `${slug} end`);
    assert.equal(after.recurrenceRule, before.recurrenceRule, `${slug} rule`);
    assert.equal(after.recurrenceDates, before.recurrenceDates, `${slug} dates`);
    assert.equal(after.recurrenceUntilDate, before.recurrenceUntilDate, `${slug} cutoff`);
    assert.deepEqual(schedule(after), beforeSchedule, `${slug} occurrences`);
  }

  const annualBeforeSwitch = await getSql(dbPath, "SELECT * FROM events WHERE slug = ?", ["annual"]);
  const annualSwitch = await fetch(`${baseUrl}/admin/events`, {
    method: "POST", redirect: "manual", headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
    body: formFor(annualBeforeSwitch, {
      recurrenceType: "weekly", recurrenceInterval: "1", weeklyByDay: "TH",
      preserveRecurrenceRule: "1", recurrenceRuleChanged: "1",
      originalRecurrenceRule: annualBeforeSwitch.recurrenceRule, originalRecurrenceDates: annualBeforeSwitch.recurrenceDates || "",
    }),
  });
  assert.equal(annualSwitch.status, 302);
  const annualAfterSwitch = await getSql(dbPath, "SELECT recurrenceRule FROM events WHERE id = ?", [annualBeforeSwitch.id]);
  assert.deepEqual(JSON.parse(annualAfterSwitch.recurrenceRule), { type: "weekly", interval: 1, byDay: ["TH"] });

  const previewPayload = {
    startDateTime: "2026-02-01T16:00",
    endDateTime: "2026-02-01T18:00",
    type: "weekly", interval: 1, weeklyByDay: ["SU"], recurrenceUntilDate: "",
  };
  const deniedPreview = await fetch(`${baseUrl}/admin/events/preview-recurrence`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(previewPayload),
  });
  assert.ok([401, 403].includes(deniedPreview.status));
  const preview = await fetch(`${baseUrl}/admin/events/preview-recurrence`, {
    method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(previewPayload),
  });
  assert.equal(preview.status, 200);
  const previewJson = await preview.json();
  assert.ok(previewJson.occurrences.length > 0 && previewJson.occurrences.length <= 10);
  assert.equal(new Set(previewJson.occurrences.map((item) => item.occurrenceDate)).size, previewJson.occurrences.length);
  assert.ok(previewJson.occurrences.every((item) => item.startDateTime.slice(11, 16) === "16:00" && item.endDateTime.slice(11, 16) === "18:00"));
});
