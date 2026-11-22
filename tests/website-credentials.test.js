"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const sqlite = require("sqlite3");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ensureWebsiteCredentialSchema, createWebsiteCredentialRegistry, resolveSigningCredential } = require("../lib/website-credentials");
const { ensureOccurrenceEngagementSchema, createOccurrenceEngagementHandler } = require("../lib/occurrence-engagement");
const { generateOccurrences } = require("../routes/events");

async function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-registry-"));
  const db = new sqlite.Database(path.join(dir, "fixture.db"));
  t.after(() => new Promise(resolve => db.close(() => { fs.rmSync(dir, { recursive: true, force: true }); resolve(); })));
  const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (e) { e ? reject(e) : resolve({ changes: this.changes, lastID: this.lastID }); }));
  const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (e, rows) => e ? reject(e) : resolve(rows)));
  const get = async (sql, params) => (await all(sql, params))[0];
  let tail = Promise.resolve();
  const transaction = fn => {
    const work = async () => {
      await run("BEGIN IMMEDIATE");
      try { const result = await fn({ run, get, all }); await run("COMMIT"); return result; }
      catch (error) { await run("ROLLBACK"); throw error; }
    };
    const result = tail.then(work, work); tail = result.catch(() => {}); return result;
  };
  await ensureWebsiteCredentialSchema(run); await ensureOccurrenceEngagementSchema(run);
  await run("CREATE TABLE users(id INTEGER PRIMARY KEY,role,city)");
  await run("INSERT INTO users VALUES (1,'admin','Enumclaw'),(2,'developer','Enumclaw'),(3,'organizer','Enumclaw')");
  const env = { WEBSITE_CREDENTIAL_ENCRYPTION_KEYS: JSON.stringify({ v1: crypto.randomBytes(32).toString("hex") }),
    WEBSITE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY: "v1", OCCURRENCE_ENGAGEMENT_IDENTITY_KEY: crypto.randomBytes(32).toString("hex") };
  const authorize = async ({ tx, actorUserId, city }) => {
    const user = await tx.get("SELECT * FROM users WHERE id=?", [actorUserId]);
    return !!user && (user.role === "admin" || user.role === "developer" && (!city || city === user.city));
  };
  let time = Date.now();
  const registry = createWebsiteCredentialRegistry({ transaction, authorize, env, now: () => time });
  const connection = await registry.registerInstallation({ actorUserId: 1, siteUrl: "https://Example.test:443/wordpress" });
  await registry.grantCity({ actorUserId: 1, installationId: connection.id, city: "Enumclaw" });
  const issue = extra => registry.issueCredential({ actorUserId: 1, installationId: connection.id, city: "Enumclaw", ...extra });
  const activate = credentialId => registry.activateCredential({ actorUserId: 1, credentialId });
  const lookup = id => transaction(tx => resolveSigningCredential(tx, id, env, time, authorize));
  return { run, get, all, transaction, registry, authorize, env, connection, issue, activate, lookup, advance: ms => { time += ms; } };
}

test("additive registry initialization, trusted authority and encrypted lifecycle", async t => {
  const f = await fixture(t);
  const before = await f.all("SELECT name,sql FROM sqlite_master ORDER BY name");
  await ensureWebsiteCredentialSchema(f.run); await ensureWebsiteCredentialSchema(f.run);
  assert.deepEqual(await f.all("SELECT name,sql FROM sqlite_master ORDER BY name"), before);
  assert.equal(f.connection.siteUrl, "https://example.test/wordpress/");
  await assert.rejects(f.registry.registerInstallation({ actorUserId: 3, siteUrl: "https://bad.test" }), { code: "FORBIDDEN" });
  await assert.rejects(createWebsiteCredentialRegistry({ transaction: f.transaction }).registerInstallation({ actorUserId: 1, siteUrl: "https://bad.test" }), { code: "FORBIDDEN" });
  await assert.rejects(f.registry.grantCity({ actorUserId: 2, installationId: f.connection.id, city: "Buckley" }), { code: "FORBIDDEN" });
  await assert.rejects(f.registry.grantCity({ actorUserId: 1, installationId: f.connection.id, city: "Plateau Regional" }), { code: "INVALID" });
  await assert.rejects(f.issue({ city: "Buckley" }), { code: "FORBIDDEN" });
  const credential = await f.issue();
  assert.match(credential.id, /^ocm_[A-Za-z0-9_-]{32}$/);
  assert.equal(await f.lookup(credential.id), null);
  const stored = await f.get("SELECT * FROM website_signing_credentials WHERE id=?", [credential.id]);
  assert.ok(!JSON.stringify(stored).includes(credential.secret));
  await f.activate(credential.id);
  assert.deepEqual(await f.lookup(credential.id), { city: "Enumclaw", secret: credential.secret });
  await f.activate(credential.id); // idempotent
  await f.registry.recordAuditEvent({ actorUserId: 1, installationId: f.connection.id, credentialId: credential.id, action: "connection.checked" });
  await assert.rejects(f.registry.recordAuditEvent({ actorUserId: 1, installationId: f.connection.id, action: credential.secret }), { code: "INVALID" });
  const status = await f.registry.getStatus({ actorUserId: 1, installationId: f.connection.id });
  assert.ok(!JSON.stringify(status).includes(credential.secret));
  assert.ok(!JSON.stringify(status).includes(stored.secretCiphertext));
  await f.registry.revokeCredential({ actorUserId: 1, credentialId: credential.id });
  await assert.rejects(f.activate(credential.id), { code: "CONFLICT" });
  assert.equal(await f.lookup(credential.id), null);
  const audit = await f.all("SELECT * FROM website_connection_audit");
  assert.ok(!JSON.stringify(audit).includes(credential.secret));
  assert.ok(audit.some(e => e.action === "credential.revoked"));
});

test("key configuration fails closed; manual credentials remain independent", async t => {
  const f = await fixture(t), c = await f.issue(); await f.activate(c.id);
  f.env.OCCURRENCE_ENGAGEMENT_CREDENTIALS = JSON.stringify({ manual: { city: "Enumclaw", secret: "fixture manual signing secret".repeat(2) }, [c.id]: { city: "Buckley", secret: "malicious fallback".repeat(3) } });
  const key = f.env.WEBSITE_CREDENTIAL_ENCRYPTION_KEYS;
  for (const value of [undefined, "bad JSON", "{}", '{"v1":"invalid"}', JSON.stringify({ v1: f.env.OCCURRENCE_ENGAGEMENT_IDENTITY_KEY })]) {
    f.env.WEBSITE_CREDENTIAL_ENCRYPTION_KEYS = value;
    assert.equal(await f.lookup(c.id), null);
    assert.ok(await f.lookup("manual"));
    await assert.rejects(f.issue(), { code: "UNAVAILABLE" });
  }
  f.env.WEBSITE_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify({ v1: crypto.randomBytes(32).toString("hex") });
  assert.equal(await f.lookup(c.id), null);
  f.env.WEBSITE_CREDENTIAL_ENCRYPTION_KEYS = key;
  f.env.WEBSITE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY = "v2";
  await assert.rejects(f.issue(), { code: "UNAVAILABLE" });
  f.env.WEBSITE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY = "v1";
  assert.equal(await f.lookup("unknown"), null);
  const collidingId = "ocm_" + "A".repeat(32);
  f.env.OCCURRENCE_ENGAGEMENT_CREDENTIALS = JSON.stringify({ [collidingId]: { city: "Enumclaw", secret: "manual-fallback-must-not-work".repeat(2) } });
  assert.equal(await f.lookup(collidingId), null);
  assert.equal(await f.lookup("ocm_invalid"), null);
  await f.registry.revokeCredential({ actorUserId: 1, credentialId: c.id });
  assert.equal(await f.lookup(c.id), null); // never manual fallback
});

test("ciphertext and authenticated scope tampering fail closed", async t => {
  const f = await fixture(t), c = await f.issue(); await f.activate(c.id);
  const row = await f.get("SELECT * FROM website_signing_credentials WHERE id=?", [c.id]);
  for (const [column, value] of [["id", "ocm_" + "B".repeat(32)], ["secretCiphertext", "0" + row.secretCiphertext.slice(1)], ["installationId", "different-installation"], ["encryptionKeyVersion", "v2"]]) {
    const changed = column === "secretCiphertext" && value === row.secretCiphertext ? "1" + value.slice(1) : value;
    await f.run(`UPDATE website_signing_credentials SET ${column}=? WHERE id=?`, [changed, c.id]);
    assert.equal(await f.lookup(column === "id" ? changed : c.id), null);
    await f.run(`UPDATE website_signing_credentials SET ${column}=? WHERE id=?`, [row[column], column === "id" ? changed : c.id]);
  }
  await f.registry.grantCity({ actorUserId: 1, installationId: f.connection.id, city: "Buckley" });
  await f.run("UPDATE website_signing_credentials SET city='Buckley' WHERE id=?", [c.id]);
  assert.equal(await f.lookup(c.id), null);
  await f.run("UPDATE website_signing_credentials SET city=? WHERE id=?", [row.city, c.id]);
  assert.ok(await f.lookup(c.id));
  // Key versions support overlap without changing the stored ciphertext.
  const keys = JSON.parse(f.env.WEBSITE_CREDENTIAL_ENCRYPTION_KEYS);
  keys.v2 = crypto.randomBytes(32).toString("hex");
  f.env.WEBSITE_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify(keys);
  f.env.WEBSITE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY = "v2";
  const next = await f.issue(); await f.activate(next.id);
  assert.ok(await f.lookup(c.id)); assert.ok(await f.lookup(next.id));
  delete keys.v1; f.env.WEBSITE_CREDENTIAL_ENCRYPTION_KEYS = JSON.stringify(keys);
  assert.equal(await f.lookup(c.id), null); assert.ok(await f.lookup(next.id));
});

test("expiration, independent city scopes, rotation and grant revocation", async t => {
  const f = await fixture(t), c = await f.issue({ expiresAt: Date.now() + 1000 }); await f.activate(c.id);
  const replacement = await f.issue({ replacesCredentialId: c.id }); await f.activate(replacement.id);
  assert.ok(await f.lookup(c.id)); assert.ok(await f.lookup(replacement.id));
  f.advance(2000); assert.equal(await f.lookup(c.id), null); assert.ok(await f.lookup(replacement.id));
  await f.registry.grantCity({ actorUserId: 1, installationId: f.connection.id, city: "Buckley" });
  const buckley = await f.issue({ city: "Buckley" }); await f.activate(buckley.id);
  await assert.rejects(f.issue({ city: "Buckley", replacesCredentialId: replacement.id }), { code: "INVALID" });
  await f.registry.revokeCity({ actorUserId: 1, installationId: f.connection.id, city: "Enumclaw" });
  assert.equal(await f.lookup(replacement.id), null); assert.ok(await f.lookup(buckley.id));
  await f.registry.revokeInstallation({ actorUserId: 1, installationId: f.connection.id });
  assert.equal(await f.lookup(buckley.id), null);
});

test("transaction failure rolls activation back and concurrent revocation cannot reactivate", async t => {
  const f = await fixture(t), c = await f.issue();
  await f.run("CREATE TRIGGER reject_activation BEFORE INSERT ON website_connection_audit WHEN NEW.action='credential.activated' BEGIN SELECT RAISE(ABORT,'fixture private failure'); END");
  await assert.rejects(f.activate(c.id), error => error.code === "STORAGE" && !error.message.includes("private"));
  assert.equal((await f.get("SELECT status FROM website_signing_credentials WHERE id=?", [c.id])).status, "pending");
  assert.equal((await f.get("SELECT status FROM website_installations WHERE id=?", [f.connection.id])).status, "registered");
  await f.run("DROP TRIGGER reject_activation");
  await Promise.allSettled([f.activate(c.id), f.registry.revokeCredential({ actorUserId: 1, credentialId: c.id }), f.activate(c.id)]);
  assert.equal(await f.lookup(c.id), null);
  assert.equal((await f.get("SELECT status FROM website_signing_credentials WHERE id=?", [c.id])).status, "revoked");
});

test("failed revocation preserves installation, grants, credentials and history", async t => {
  const f = await fixture(t), c = await f.issue(); await f.activate(c.id);
  await f.run("INSERT INTO occurrence_engagement VALUES (99,'2030-01-01T00:00:00.000Z','historical','going','now')");
  const history = await f.all("SELECT * FROM occurrence_engagement");
  const schema = await f.all("SELECT name,sql FROM sqlite_master WHERE name IN ('occurrence_engagement','occurrence_engagement_nonces') ORDER BY name");
  await f.run("CREATE TRIGGER reject_revocation BEFORE INSERT ON website_connection_audit WHEN NEW.action='installation.revoked' BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
  await assert.rejects(f.registry.revokeInstallation({ actorUserId: 1, installationId: f.connection.id }), { code: "STORAGE" });
  assert.ok(await f.lookup(c.id));
  assert.equal((await f.get("SELECT revokedAt FROM website_authorized_cities WHERE installationId=?", [f.connection.id])).revokedAt, null);
  await f.run("DROP TRIGGER reject_revocation");
  await f.registry.revokeInstallation({ actorUserId: 1, installationId: f.connection.id });
  await ensureWebsiteCredentialSchema(f.run);
  assert.deepEqual(await f.all("SELECT * FROM occurrence_engagement"), history);
  assert.deepEqual(await f.all("SELECT name,sql FROM sqlite_master WHERE name IN ('occurrence_engagement','occurrence_engagement_nonces') ORDER BY name"), schema);
});

test("managed HMAC preserves signatures, replay, throttling and stable occurrence selections", async t => {
  const f = await fixture(t);
  const manual = { id: "manual-fixture", secret: "fixture manual secret with sufficient length" };
  f.env.OCCURRENCE_ENGAGEMENT_CREDENTIALS = JSON.stringify({ [manual.id]: { city: "Enumclaw", secret: manual.secret } });
  const previous = {};
  for (const key of Object.keys(f.env)) { previous[key] = process.env[key]; process.env[key] = f.env[key]; }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  await f.run("CREATE TABLE events(id INTEGER PRIMARY KEY,city,slug,startDateTime,endDateTime,hasRecurrence,recurrenceRule,archived,lifecycleState)");
  const rule = JSON.stringify({ type: "weekly", byDay: ["WE"] });
  await f.run("INSERT INTO events VALUES (1,'Enumclaw','one','2030-01-02T12:00:00-08:00','2030-01-02T14:00:00-08:00',1,?,0,'scheduled'),(2,'Buckley','two','2030-01-02T12:00:00-08:00','2030-01-02T14:00:00-08:00',1,?,0,'scheduled')", [rule, rule]);
  const handler = createOccurrenceEngagementHandler({ transaction: f.transaction, generateOccurrences, normalizeRowTimes: row => row, availableEventSql: () => "archived=0", authorizeManagedCredential: f.authorize });
  const visitor = crypto.randomBytes(32).toString("base64url");
  const first = "e1_2030-01-02T20:00:00.000Z", second = "e1_2030-01-09T20:00:00.000Z";
  const make = (c, selection, overrides = {}) => {
    const body = { mode: "occurrence_set", occurrenceId: first, visitorToken: visitor, selection, ...overrides.body };
    const timestamp = overrides.timestamp || String(Math.floor(Date.now() / 1000));
    const nonce = overrides.nonce || crypto.randomBytes(18).toString("base64url");
    const originalUrl = "/events/" + (overrides.event || 1) + "/engagement";
    const signature = crypto.createHmac("sha256", c.secret).update(["POST", originalUrl, timestamp, nonce, crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex")].join("\n")).digest("hex");
    const headers = { "X-OC-Key-Id": c.id, "X-OC-Timestamp": timestamp, "X-OC-Nonce": nonce, "X-OC-Signature": signature, ...overrides.headers };
    return { method: "POST", originalUrl, body, params: { idOrSlug: String(overrides.event || 1) }, ip: "fixture-ip", get: name => headers[name] };
  };
  const send = async req => {
    const res = { statusCode: 200, headers: {}, set(k,v) { this.headers[k]=v; return this; }, status(code) { this.statusCode=code; return this; }, json(data) { this.data=data; return this; } };
    await handler(req, res); return res;
  };
  let response = await send(make(manual, "going"));
  assert.equal(response.statusCode, 200); assert.equal(response.data.goingCount, 1);
  const manualHash = await f.get("SELECT visitorHash FROM occurrence_engagement");
  const c = await f.issue(); await f.activate(c.id);
  response = await send(make(c, "going")); assert.equal(response.statusCode, 200); assert.equal(response.data.goingCount, 1);
  const stored = await f.get("SELECT visitorHash FROM occurrence_engagement");
  assert.deepEqual(stored, manualHash);
  const replay = make(c, "going"); assert.equal((await send(replay)).statusCode, 200); assert.equal((await send(replay)).statusCode, 409);
  assert.equal((await send(make(c, "going", { timestamp: "1000000000" }))).statusCode, 401);
  assert.equal((await send(make(c, "going", { headers: { "X-OC-Signature": "0".repeat(64) } }))).statusCode, 401);
  assert.equal((await send(make(c, "going", { event: 2, body: { occurrenceId: "e2_2030-01-02T20:00:00.000Z" } }))).statusCode, 404);
  const rotated = await f.issue({ replacesCredentialId: c.id }); await f.activate(rotated.id);
  await f.registry.revokeCredential({ actorUserId: 1, credentialId: c.id });
  assert.equal((await send(make(c, "going"))).statusCode, 401);
  response = await send(make(rotated, "interested")); assert.equal(response.data.goingCount, 0); assert.equal(response.data.interestedCount, 1);
  assert.deepEqual(await f.get("SELECT visitorHash FROM occurrence_engagement"), stored);
  response = await send(make(rotated, "going", { body: { occurrenceId: second } })); assert.equal(response.data.goingCount, 1);
  response = await send(make(rotated, null)); assert.equal(response.data.interestedCount, 0);
  assert.equal((await f.get("SELECT COUNT(*) AS n FROM occurrence_engagement")).n, 1);
  let limited;
  for (let i = 0; i < 65; i++) { limited = await send(make(rotated, "going")); if (limited.statusCode === 429) break; }
  assert.equal(limited.statusCode, 429); assert.equal(limited.headers["Retry-After"], "60");
  // Fresh visitor identities still share the broader IP request budget.
  for (let i = 0; i < 125; i++) { limited = await send(make(rotated, "going", { body: { visitorToken: crypto.randomBytes(32).toString("base64url") } })); if (limited.statusCode === 429) break; }
  assert.equal(limited.statusCode, 429); assert.equal(limited.headers["Retry-After"], "60");
});
