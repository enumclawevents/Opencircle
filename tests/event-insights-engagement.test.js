"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const sqlite = require("sqlite3");
const { hashPassword } = require("../lib/auth");

test("event insights uses private per-occurrence aggregates and preserves single-event totals", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-insights-test-"));
  const file = path.join(dir, "fixture.db");
  const origin = "http://127.0.0.1:" + (42500 + Math.floor(Math.random() * 500));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."), stdio: "ignore",
    env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, PORT: new URL(origin).port,
      NODE_ENV: "test", DB_PATH: file, ADMIN_USER: "bootstrap", ADMIN_PASS: "fixture bootstrap password" },
  });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(origin + "/health")).ok) { ready = true; break; } } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  assert.ok(ready, "fixture starts");
  const db = new sqlite.Database(file);
  t.after(() => db.close());
  const sql = (query, params = []) => new Promise((resolve, reject) => db.all(query, params, (e, rows) => e ? reject(e) : resolve(rows)));
  const password = "fixture authentication password";
  const hash = await hashPassword(password);
  for (const [name, role, city] of [["admin", "admin", "Enumclaw"], ["Owner", "organizer", "Enumclaw"], ["Other", "organizer", "Enumclaw"], ["developer", "developer", "Enumclaw"]]) {
    await sql("INSERT INTO users(username,email,passwordHash,role,city) VALUES (?,?,?,?,?)", [name, name + "@example.test", hash, role, city]);
  }
  const rule = JSON.stringify({ type: "weekly", interval: 1, byDay: ["SU"] });
  await sql(`INSERT INTO events(id,city,title,slug,organizer,location,startDateTime,endDateTime,hasRecurrence,recurrenceRule,goingCount,interestedCount) VALUES
    (1,'Enumclaw','Recurring fixture','recurring','Owner','Town Hall','2026-03-01T12:00:00-08:00','2026-03-01T14:00:00-08:00',1,?,71,82),
    (2,'Enumclaw','Single fixture','single','Owner','Town Hall','2026-03-01T12:00:00-08:00','2026-03-01T14:00:00-08:00',0,NULL,7,8),
    (3,'Seattle','Outside scope','outside','Owner','Town Hall','2026-03-01T12:00:00-08:00','2026-03-01T14:00:00-08:00',1,?,0,0)`, [rule, rule]);
  await sql("INSERT INTO occurrence_engagement VALUES (1,'2026-03-01T20:00:00.000Z','private-hash','going','now'), (1,'2026-03-08T19:00:00.000Z','private-hash','interested','now'), (1,'2025-01-01T20:00:00.000Z','historical-hash','going','now')");
  const login = async name => {
    const response = await fetch(origin + "/login", { method: "POST", redirect: "manual", body: new URLSearchParams({ username: name, password }) });
    assert.equal(response.status, 302);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const admin = await login("admin"), owner = await login("Owner"), other = await login("Other"), developer = await login("developer");
  const url = (id, date) => origin + "/admin/event-occurrence-engagement?" + new URLSearchParams({ event: id, occurrenceId: `e${id}_${date}` });
  const read = (cookie, id = 1, date = "2026-03-01T20:00:00.000Z") => fetch(url(id, date), { headers: { Cookie: cookie, Accept: "application/json" } });
  assert.equal((await fetch(url(1, "2026-03-01T20:00:00.000Z"), { headers: { Accept: "application/json" } })).status, 401);
  for (const cookie of [admin, owner, developer]) {
    const response = await read(cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(await response.json(), { occurrenceId: "e1_2026-03-01T20:00:00.000Z", scheduled: true, goingCount: 1, interestedCount: 0 });
  }
  assert.equal((await read(other)).status, 404);
  assert.equal((await read(owner, 3)).status, 404);
  assert.equal((await read(admin, 2)).status, 400);
  const spring = await (await read(owner, 1, "2026-03-08T19:00:00.000Z")).json();
  assert.equal(spring.goingCount, 0); assert.equal(spring.interestedCount, 1);
  const zero = await (await read(owner, 1, "2026-11-08T20:00:00.000Z")).json();
  assert.equal(zero.goingCount, 0); assert.equal(zero.interestedCount, 0); assert.equal(zero.scheduled, true);
  const removed = await (await read(owner, 1, "2025-01-01T20:00:00.000Z")).json();
  assert.equal(removed.scheduled, false); assert.equal(removed.goingCount, 1);
  assert.equal((await read(owner, 1, "2025-01-02T20:00:00.000Z")).status, 404);
  await sql("UPDATE occurrence_engagement SET selection='interested' WHERE occurrenceStart='2026-03-01T20:00:00.000Z'");
  assert.equal((await (await read(owner)).json()).interestedCount, 1);
  await sql("DELETE FROM occurrence_engagement WHERE occurrenceStart='2026-03-01T20:00:00.000Z'");
  assert.equal((await (await read(owner)).json()).interestedCount, 0);
  const page = await (await fetch(origin + "/admin/events-analytics?event=1&city=Enumclaw", { headers: { Cookie: owner } })).text();
  assert.ok(page.includes('id="eventInsightsOccurrence"'));
  assert.ok(page.includes('e1_2025-01-01T20:00:00.000Z'));
  assert.ok(page.includes('no longer scheduled'));
  assert.ok(!page.includes('private-hash'));
  const single = await (await fetch(origin + "/admin/events-analytics?event=2&city=Enumclaw", { headers: { Cookie: owner } })).text();
  assert.ok(!single.includes('id="eventInsightsOccurrence"'));
  assert.match(single, /Current Going total[\s\S]*?<div class="v" >7<\/div>/);
  assert.deepEqual((await sql("SELECT goingCount,interestedCount FROM events WHERE id=1"))[0], { goingCount: 71, interestedCount: 82 });
});
