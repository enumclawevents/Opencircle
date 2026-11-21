"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const sqlite = require("sqlite3");
const { canonicalOccurrence } = require("../lib/occurrence-engagement");

test("signed occurrence engagement preserves legacy totals and independent visitor selections", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-occurrence-"));
  const filename = path.join(dir, "test.db");
  const port = 41000 + Math.floor(Math.random() * 1000);
  const origin = "http://127.0.0.1:" + port;
  const secret = crypto.randomBytes(32).toString("hex");
  let credentialId = "enumclaw";
  const child = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, DB_PATH: filename, PORT: String(port),
      ADMIN_USER: "fixture", ADMIN_PASS: "fixture password", NODE_ENV: "test",
      OCCURRENCE_ENGAGEMENT_IDENTITY_KEY: crypto.randomBytes(32).toString("hex"),
      OCCURRENCE_ENGAGEMENT_CREDENTIALS: JSON.stringify({ enumclaw: { city: "Enumclaw", secret }, buckley: { city: "Buckley", secret } }) },
    stdio: "ignore",
  });
  t.after(() => { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  for (let attempt = 0; attempt < 70; attempt++) {
    try { if ((await fetch(origin + "/health")).ok) break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  const db = new sqlite.Database(filename);
  const sql = (query, params = []) => new Promise((resolve, reject) => db.all(query, params, (error, rows) => error ? reject(error) : resolve(rows)));
  t.after(() => db.close());
  await sql(`INSERT INTO events(id,city,title,slug,startDateTime,endDateTime,hasRecurrence,recurrenceRule,goingCount,interestedCount)
    VALUES (1,'Enumclaw','Recurring','recurring','2030-01-02T12:00:00-08:00','2030-01-02T14:00:00-08:00',1,?,11,22),
           (2,'Enumclaw','Single','single','2030-01-02T12:00:00-08:00','2030-01-02T14:00:00-08:00',0,NULL,7,8),
           (3,'Buckley','Private community','buckley','2030-01-02T12:00:00-08:00','2030-01-02T14:00:00-08:00',1,?,0,0)`,
  [JSON.stringify({ type: "weekly", interval: 1, byDay: ["WE"] }), JSON.stringify({ type: "weekly", interval: 1, byDay: ["WE"] })]);
  const visitor = crypto.randomBytes(32).toString("base64url");
  const other = crypto.randomBytes(32).toString("base64url");
  const first = "e1_2030-01-02T20:00:00.000Z";
  const second = "e1_2030-01-09T20:00:00.000Z";
  const build = (body, event = "1") => {
    const url = "/events/" + event + "/engagement";
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString("base64url");
    const digest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const signature = crypto.createHmac("sha256", secret).update(["POST", url, timestamp, nonce, digest].join("\n")).digest("hex");
    return [origin + url, { method: "POST", headers: { "content-type": "application/json",
      "X-OC-Key-Id": credentialId, "X-OC-Timestamp": timestamp, "X-OC-Nonce": nonce, "X-OC-Signature": signature }, body: JSON.stringify(body) }];
  };
  const body = (occurrenceId = first, selection = "going", token = visitor) => ({ mode: "occurrence_set", occurrenceId, visitorToken: token, selection });
  const send = async (payload, event) => {
    const response = await fetch(...build(payload, event));
    return { status: response.status, headers: response.headers, data: await response.json() };
  };
  const set = (occurrence, selection, token) => send(body(occurrence, selection, token));
  assert.equal((await set(first, "going")).data.goingCount, 1);
  assert.equal((await set(first, "going")).data.goingCount, 1);
  assert.equal((await set(second, "interested")).data.interestedCount, 1);
  assert.equal((await set(first, "interested")).data.goingCount, 0);
  assert.equal((await set(first, "interested")).data.interestedCount, 1);
  assert.equal((await set(first, "going", other)).data.goingCount, 1);
  const read = await send({ mode: "occurrence_read", occurrenceId: first, visitorToken: visitor });
  assert.equal(read.data.selection, "interested");
  assert.equal(read.data.interestedCount, 1);
  assert.equal(read.headers.get("cache-control"), "private, no-store");
  assert.equal(JSON.stringify(read.data).includes(visitor), false);
  assert.equal((await set(first, null)).data.selection, null);
  const simultaneous = await Promise.all([set(first, "going"), set(first, "interested"), set(first, "going")]);
  assert.ok(simultaneous.every(result => result.status === 200));
  assert.equal((await sql("SELECT count(*) AS n FROM occurrence_engagement WHERE occurrenceStart = ?", ["2030-01-02T20:00:00.000Z"]))[0].n, 2);
  assert.deepEqual((await sql("SELECT goingCount,interestedCount FROM events WHERE id=1"))[0], { goingCount: 11, interestedCount: 22 });
  for (const payload of [body(first, "both"), body("e2_2030-01-02T20:00:00Z"), body("invalid"), body(first, "going", "forged")]) {
    assert.equal((await send(payload)).status, 400);
  }
  assert.equal((await send(body(), "3")).status, 404);
  credentialId = "buckley";
  assert.equal((await send(body("e3_2030-01-02T20:00:00Z"), "3")).status, 200);
  assert.equal((await send(body(), "1")).status, 404);
  const hashes = await sql("SELECT eventId, visitorHash FROM occurrence_engagement WHERE eventId IN (1,3)");
  assert.ok(hashes.filter(row => row.eventId === 1).every(row => row.visitorHash !== hashes.find(item => item.eventId === 3).visitorHash));
  credentialId = "enumclaw";
  assert.equal((await send(body("e2_2030-01-02T20:00:00Z"), "2")).status, 400);
  const forged = build(body());
  forged[1].headers["X-OC-Signature"] = "0".repeat(64);
  assert.equal((await fetch(...forged)).status, 401);
  const replay = build(body());
  assert.equal((await fetch(...replay)).status, 200);
  assert.equal((await fetch(...replay)).status, 409);
  assert.equal(canonicalOccurrence("e1_2030-01-02T12:00:00-08:00", 1).id, first);
  assert.equal(canonicalOccurrence("e1_2030-02-30T12:00:00Z", 1), null);
  for (const instant of ["2030-03-06T12:00:00-08:00", "2030-03-13T12:00:00-07:00", "2030-10-30T12:00:00-07:00", "2030-11-06T12:00:00-08:00"]) {
    const result = await set("e1_" + instant, "going");
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  await sql("UPDATE events SET startDateTime='2030-01-02T13:00:00-08:00',endDateTime='2030-01-02T15:00:00-08:00' WHERE id=1");
  assert.equal((await set(first, "going")).status, 409);
  assert.equal((await send({ mode: "occurrence_read", occurrenceId: first, visitorToken: visitor })).data.available, false);
  assert.equal((await set("e1_2030-01-02T21:00:00Z", "going")).data.goingCount, 1);
  await sql("UPDATE events SET lifecycleState='cancelled' WHERE id=1");
  assert.equal((await set("e1_2030-01-02T21:00:00Z", "going")).status, 409);
  assert.ok((await sql("SELECT count(*) AS n FROM occurrence_engagement"))[0].n > 0);
  const legacy = await fetch(origin + "/events/2/engagement", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ goingDelta: 1 }) });
  assert.equal((await legacy.json()).goingCount, 8);
  const absolute = await fetch(origin + "/events/1/engagement", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ going: 30, interested: 40 }) });
  assert.equal((await absolute.json()).goingCount, 30);
  assert.ok((await sql("SELECT count(*) AS n FROM occurrence_engagement"))[0].n > 0);
  const attempts = [];
  for (let index = 0; index < 65; index++) {
    attempts.push((await send({ mode: "occurrence_read", occurrenceId: first, visitorToken: visitor })).status);
  }
  assert.ok(attempts.includes(429));
  const schema = await sql("SELECT sql FROM sqlite_master WHERE name = 'occurrence_engagement'");
  assert.match(schema[0].sql, /PRIMARY KEY/);
  assert.equal((await sql("PRAGMA integrity_check"))[0].integrity_check, "ok");

});

test("signing ID and secret rotation retain identity; missing identity key fails closed", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-identity-rotation-"));
  const filename = path.join(dir, "rotation.db");
  const port = 42500 + Math.floor(Math.random() * 500);
  const origin = `http://127.0.0.1:${port}`;
  const identityKey = crypto.randomBytes(32).toString("hex");
  const token = crypto.randomBytes(32).toString("base64url");
  const other = crypto.randomBytes(32).toString("base64url");
  const originalSecret = crypto.randomBytes(32).toString("hex");
  let child;
  let keyId;
  let secret;
  let logs = "";
  t.after(() => { child?.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  async function start(id, signingSecret, identity = identityKey) {
    if (child) {
      const exited = new Promise(resolve => child.once("exit", resolve));
      child.kill();
      await exited;
    }
    keyId = id;
    secret = signingSecret;
    child = spawn(process.execPath, ["server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: { PATH: process.env.PATH, NODE_PATH: process.env.NODE_PATH, DB_PATH: filename, PORT: String(port),
        NODE_ENV: "test", ADMIN_USER: "fixture", ADMIN_PASS: "fixture password",
        OCCURRENCE_ENGAGEMENT_IDENTITY_KEY: identity,
        OCCURRENCE_ENGAGEMENT_CREDENTIALS: JSON.stringify({ [id]: { city: "Enumclaw", secret: signingSecret } }) },
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", data => { logs += data; });
    for (let attempt = 0; attempt < 70; attempt++) {
      try { if ((await fetch(origin + "/health")).ok) return; } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw Error("Fixture did not start");
  }
  const sql = (query, params = []) => new Promise((resolve, reject) => {
    const db = new sqlite.Database(filename);
    db.all(query, params, (error, rows) => db.close(() => error ? reject(error) : resolve(rows)));
  });
  const occurrenceId = "e1_2030-01-02T20:00:00.000Z";
  async function request(mode, selection, visitorToken = token, customHeaders = {}) {
    const body = { mode, occurrenceId, visitorToken };
    if (mode === "occurrence_set") body.selection = selection;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce = crypto.randomBytes(18).toString("base64url");
    const digest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const path = "/events/1/engagement";
    const signature = crypto.createHmac("sha256", secret).update(["POST", path, timestamp, nonce, digest].join("\n")).digest("hex");
    const response = await fetch(origin + path, { method: "POST",
      headers: { "content-type": "application/json", "X-OC-Key-Id": keyId, "X-OC-Timestamp": timestamp,
        "X-OC-Nonce": nonce, "X-OC-Signature": signature, ...customHeaders }, body: JSON.stringify(body) });
    return { status: response.status, data: await response.json() };
  }
  await start("original", originalSecret);
  await sql(`INSERT INTO events (id,city,title,startDateTime,endDateTime,hasRecurrence,recurrenceRule,goingCount,interestedCount)
    VALUES (1,'Enumclaw','Rotation','2030-01-02T12:00:00-08:00','2030-01-02T14:00:00-08:00',1,?,12,13)`,
    [JSON.stringify({ type: "weekly", interval: 1, byDay: ["WE"] })]);
  assert.equal((await request("occurrence_set", "going")).data.goingCount, 1);
  const stored = (await sql("SELECT visitorHash FROM occurrence_engagement"))[0].visitorHash;
  await start("new-id", originalSecret);
  assert.equal((await request("occurrence_read")).data.selection, "going");
  assert.equal((await request("occurrence_set", "going")).data.goingCount, 1);
  await start("new-id", crypto.randomBytes(32).toString("hex"));
  assert.equal((await request("occurrence_read")).data.selection, "going");
  assert.equal((await request("occurrence_set", "interested")).data.interestedCount, 1);
  assert.equal((await sql("SELECT visitorHash FROM occurrence_engagement"))[0].visitorHash, stored);
  assert.equal((await request("occurrence_set", "going", other)).data.goingCount, 1);
  assert.equal((await request("occurrence_set", null)).data.interestedCount, 0);
  assert.equal((await request("occurrence_read", undefined, other)).data.selection, "going");
  assert.equal((await request("occurrence_read", undefined, token, { "X-OC-Signature": "0".repeat(64) })).status, 401);
  const rotatedSecret = secret;
  for (const invalid of ["", "predictable", "a".repeat(63)]) {
    await start("new-id", rotatedSecret, invalid);
    assert.equal((await request("occurrence_set", "going")).status, 503);
    assert.equal((await request("occurrence_read")).status, 503);
    const legacy = await fetch(origin + "/events/1/engagement", { method: "POST",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ goingDelta: 0 }) });
    assert.equal(legacy.status, 200);
  }
  assert.equal((await sql("SELECT count(*) AS n FROM occurrence_engagement"))[0].n, 1);
  assert.deepEqual((await sql("SELECT goingCount,interestedCount FROM events"))[0], { goingCount: 12, interestedCount: 13 });
  assert.match(logs, /Configure OCCURRENCE_ENGAGEMENT_IDENTITY_KEY/);
  for (const sensitive of [identityKey, originalSecret, rotatedSecret, token, other]) assert.equal(logs.includes(sensitive), false);
});
