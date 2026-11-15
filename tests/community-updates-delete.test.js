"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");
const { hashPassword } = require("../lib/auth");

test("Community Update deletion enforces community scope and rolls back failures", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-update-delete-"));
  const dbPath = path.join(dir, "fixture.db");
  const port = 38100 + Math.floor(Math.random() * 2000);
  const origin = `http://127.0.0.1:${port}`;
  const password = "Disposable fixture password 9!";
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: {
      PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, NODE_ENV: "test",
      PORT: String(port), DB_PATH: dbPath, UPLOADS_DIR: path.join(dir, "uploads"),
      ADMIN_USER: "fixture-bootstrap", ADMIN_PASS: "Unused bootstrap fixture password!",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let errors = "";
  let db;
  server.stderr.setEncoding("utf8").on("data", (chunk) => { errors += chunk; });
  t.after(async () => {
    if (db) await new Promise((resolve) => db.close(resolve));
    if (server.exitCode === null && server.signalCode === null) {
      const exited = once(server, "exit");
      server.kill();
      await exited;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let ready = false;
  for (let attempt = 0; attempt < 100 && server.exitCode === null; attempt++) {
    try {
      if ((await fetch(origin + "/health")).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  assert.ok(ready, `Disposable API did not start: ${errors}`);

  db = new sqlite3.Database(dbPath);
  const sql = (query, params = []) => new Promise((resolve, reject) => {
    db.all(query, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
  const hash = await hashPassword(password);
  for (const role of ["developer", "admin", "organizer"]) {
    await sql("INSERT INTO users (email, username, passwordHash, role, city, permissionsJson) VALUES (?, ?, ?, ?, ?, ?)",
      [`${role}@example.test`, role, hash, role, "Enumclaw", JSON.stringify({ cityAccess: ["Enumclaw"] })]);
  }

  assert.equal((await fetch(origin + "/venues?city=Enumclaw")).status, 200);
  await sql("INSERT INTO events (id, title, startDateTime) VALUES (101, 'Linked event', '2099-01-01T12:00:00Z')");
  await sql("INSERT INTO venues (id, name) VALUES (201, 'Linked venue')");
  for (const [id, city] of [[10, "Enumclaw"], [11, "Enumclaw"], [20, "Buckley"], [21, "Buckley"],
    [30, "Enumclaw"], [31, "Enumclaw"], [40, "Enumclaw"]]) {
    await sql("INSERT INTO updates (id, city, title, slug) VALUES (?, ?, ?, ?)", [id, city, `Update ${id}`, `update-${id}`]);
    await sql("INSERT INTO update_metric_events (updateId, source) VALUES (?, 'direct')", [id]);
    await sql("INSERT INTO update_event_links (updateId, eventId) VALUES (?, 101)", [id]);
    await sql("INSERT INTO update_venue_links (updateId, venueId) VALUES (?, 201)", [id]);
  }

  async function login(username) {
    const response = await fetch(origin + "/login", {
      method: "POST", redirect: "manual", body: new URLSearchParams({ username, password }),
    });
    assert.equal(response.status, 302);
    const cookie = response.headers.get("set-cookie");
    assert.ok(cookie);
    return cookie.split(";", 1)[0];
  }

  const manager = await login("developer");
  const admin = await login("admin");
  const organizer = await login("organizer");
  const remove = (id, city, cookie) => fetch(`${origin}/admin/updates/${id}/delete?city=${city}`, {
    method: "POST", redirect: "manual", headers: { cookie },
  });
  const tables = ["updates", "update_metric_events", "update_event_links", "update_venue_links"];
  const snapshot = (id) => Promise.all(tables.map((table) =>
    sql(`SELECT * FROM ${table} WHERE ${table === "updates" ? "id" : "updateId"} = ? ORDER BY rowid`, [id])));
  const empty = [[], [], [], []];

  const outside = await snapshot(20);
  const denied = await remove(20, "Buckley", manager);
  assert.equal(denied.status, 404);
  const deniedBody = await denied.text();
  assert.deepEqual(await snapshot(20), outside);

  for (const id of [999, "invalid", "1e1", "0", "9007199254740992"]) {
    const response = await remove(id, "Enumclaw", manager);
    assert.equal(response.status, 404);
    assert.equal(await response.text(), deniedBody);
  }
  const owned = await snapshot(10);
  assert.equal((await remove(10, "Enumclaw", organizer)).status, 403);
  assert.deepEqual(await snapshot(10), owned);

  for (const [id, city, cookie] of [[10, "Enumclaw", manager], [11, "Enumclaw", admin], [21, "Buckley", admin]]) {
    const response = await remove(id, city, cookie);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), `/admin/updates?city=${city}`);
    assert.deepEqual(await snapshot(id), empty);
  }

  await sql("CREATE TRIGGER fail_parent BEFORE DELETE ON updates WHEN OLD.id = 30 BEGIN SELECT RAISE(ABORT, 'fixture parent failure'); END");
  await sql("CREATE TRIGGER fail_link BEFORE DELETE ON update_venue_links WHEN OLD.updateId = 31 BEGIN SELECT RAISE(ABORT, 'fixture link failure'); END");
  for (const id of [30, 31]) {
    const before = await snapshot(id);
    const response = await remove(id, "Enumclaw", manager);
    assert.equal(response.status, 500);
    assert.deepEqual(await snapshot(id), before);
  }

  const concurrent = await Promise.all([remove(40, "Enumclaw", manager), remove(40, "Enumclaw", manager)]);
  assert.deepEqual(concurrent.map((response) => response.status).sort(), [302, 404]);
  assert.deepEqual(await snapshot(40), empty);
  assert.deepEqual(await snapshot(20), outside);
  assert.deepEqual(await sql("SELECT id, title FROM events WHERE id = 101"), [{ id: 101, title: "Linked event" }]);
  assert.deepEqual(await sql("SELECT id, name FROM venues WHERE id = 201"), [{ id: 201, name: "Linked venue" }]);
});
