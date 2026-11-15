"use strict";

const assert = require("node:assert/strict");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const [reference, release, rollback] = process.argv.slice(2);
const sqlite3 = require(path.join(release, "node_modules/sqlite3"));
const { hashToken, verifyPassword } = require(path.join(release, "lib/auth"));

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "oc-rollback-db-"));
  const filename = path.join(temporary, "opencircle.db");
  const mailFile = path.join(temporary, "mail.jsonl");
  const preload = path.join(temporary, "mail.cjs");
  const port = 36600 + Math.floor(Math.random() * 1000);
  const origin = "https://dashboard.example.test";
  const bootstrapUser = "bootstrap@example.test";
  const bootstrapPassword = "fixture env password";
  const commonEnv = {
    ...process.env, NODE_ENV: "test", PORT: String(port), DB_PATH: filename,
    UPLOADS_DIR: path.join(temporary, "uploads"), DASHBOARD_ORIGIN: origin,
    ADMIN_USER: bootstrapUser, ADMIN_PASS: bootstrapPassword, SMTP_HOST: "",
    AUTH_RATE_LIMIT_IP_MODE: "", AUTH_RATE_LIMIT_TRUSTED_PROXY_CIDRS: "",
  };
  let db, child;
  let errors = "";
  async function stop() {
    if (child?.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
  }
  async function start(dir) {
    errors = "";
    child = spawn(process.execPath, ["--require", preload, "server.js"], {
      cwd: dir, env: commonEnv, stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr.on("data", (part) => { errors += part; });
    for (let i = 0; i < 80; i++) {
      if (child.exitCode !== null) break;
      try { if ((await request("/health")).ok) return; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail("fixture server failed to start: " + errors);
  }
  const sql = (query, params = []) => new Promise((resolve, reject) => {
    db.all(query, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
  const request = (url, cookie, fields) => fetch("http://127.0.0.1:" + port + url, {
    redirect: "manual",
    headers: cookie ? { cookie } : {},
    ...(fields ? { method: "POST", body: new URLSearchParams(fields) } : {}),
  });
  async function login(username, password) {
    const response = await request("/login", "", { username, password });
    assert.equal(response.status, 302);
    return response.headers.get("set-cookie").split(";")[0];
  }
  const summary = (cookie) => request("/admin/dashboard-summary?range=30d", cookie);
  const passwordOf = async (id) => (await sql("SELECT passwordHash FROM users WHERE id = ?", [id]))[0].passwordHash;
  try {
    await fs.writeFile(preload, `
      const mailer = require(require("node:path").join(process.cwd(), "mailer.js"));
      mailer.sendEmail = async message => {
        require("node:fs").appendFileSync(${JSON.stringify(mailFile)}, JSON.stringify(message) + "\\n");
        return true;
      };
    `);
    // Initialize using e499479's real SQLite schema, before any auth migrations.
    execFileSync(process.execPath, ["-e", "require('./db').initDB().catch(e => { console.error(e); process.exitCode = 1; })"],
      { cwd: reference, env: commonEnv, stdio: "pipe" });
    db = new sqlite3.Database(filename);
    assert.ok(!(await sql("PRAGMA table_info(auth_sessions)")).some(({name}) => name === "userId"));
    const inode = (await fs.stat(filename)).ino;
    const oldVerifier = require(path.join(reference, "lib/auth"));
    const password = "fixture initial password";
    const replacement = "fixture replacement password";
    const adminEmail = "daniel@opencircleapi.com";
    const legacyEmail = "legacy@example.test";
    const organizerEmail = "new-organizer@example.test";
    await sql("INSERT INTO users (id,email,username,passwordHash,role,city) VALUES (1,?,'Fixture Admin',?,'admin','Enumclaw')",
      [adminEmail, oldVerifier.hashPassword(password)]);
    const legacyHash = oldVerifier.hashPassword(password);
    await sql("INSERT INTO users (id,email,username,passwordHash,role,city,permissionsJson) VALUES (2,?,'Fixture Developer',?,'developer','Enumclaw',?)",
      [legacyEmail, legacyHash, JSON.stringify({ cityAccess: ["Enumclaw"] })]);
    await sql("INSERT INTO auth_sessions (tokenHash,user,role,city,exp) VALUES (?,'Fixture Admin','admin','Enumclaw',?)",
      [hashToken("legacy-cookie"), Date.now() + 60_000]);

    await start(release);
    assert.ok((await sql("PRAGMA table_info(auth_sessions)")).some(({name}) => name === "userId"));
    assert.equal((await summary("oc_auth=legacy-cookie")).status, 401);
    const adminCookie = await login(adminEmail, password);
    assert.match(await passwordOf(1), /^pbkdf2-sha256:v1:600000:/);
    const bootstrapCookie = await login(bootstrapUser, bootstrapPassword);
    const invite = await request("/admin/invites", adminCookie, { role: "organizer", city: "Enumclaw" });
    assert.equal(invite.status, 200);
    const [, inviteToken] = /https:\/\/dashboard\.example\.test\/invite\?invite=([a-f0-9]+)/.exec(await invite.text());
    const accept = await request("/invite", "", { invite: inviteToken, email: organizerEmail, username: "Fixture Organizer",
      password, confirmPassword: password, agreeToTerms: "yes" });
    assert.equal(accept.status, 302);
    const organizerCookie = await login(organizerEmail, password);
    const [{ id: organizerId }] = await sql("SELECT id FROM users WHERE email = ?", [organizerEmail]);
    const upgradedHash = await passwordOf(organizerId);
    assert.match(upgradedHash, /^pbkdf2-sha256:v1:600000:/);
    const eventStart = new Date(Date.now() + 86_400_000).toISOString();
    await sql("INSERT INTO events (id,city,slug,title,organizer,location,startDateTime,endDateTime,viewCount) VALUES (20,'Enumclaw','rollback-fixture-event','Rollback fixture event','Fixture Organizer','Fixture hall',?,?,7)", [eventStart,eventStart]);
    await sql("CREATE TABLE IF NOT EXISTS event_views (id INTEGER PRIMARY KEY, eventId INTEGER, occurrenceDate TEXT, viewedAt TEXT, ipHash TEXT, ref TEXT)");
    await sql("INSERT INTO event_views (eventId,viewedAt,ipHash,ref) VALUES (20,datetime('now','-1 minute'),'fixture-viewer','__direct__')");
    await stop();

    await start(rollback);
    assert.equal((await fs.stat(filename)).ino, inode, "Switch must use the same SQLite file");
    assert.equal((await summary("oc_auth=legacy-cookie")).status, 401);
    const legacyCookie = await login(legacyEmail, password);
    assert.equal(await passwordOf(2), legacyHash, "Fallback must preserve a valid legacy hash");
    const secondOrganizerCookie = await login(organizerEmail, password);
    assert.equal(await passwordOf(organizerId), upgradedHash, "Fallback must preserve the upgraded hash");
    for (const [cookie, role] of [[adminCookie,"admin"], [legacyCookie,"developer"], [organizerCookie,"organizer"], [bootstrapCookie,"developer"]]) {
      const res = await summary(cookie);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.role, role);
      if (role === "organizer" || cookie === legacyCookie) assert.deepEqual(data.scope.cities, ["Enumclaw"]);
      if (cookie === organizerCookie) assert.equal(data.kpis.eventViews, 1);
    }
    assert.equal((await request("/admin/users/2/reset", bootstrapCookie, {})).status, 403);
    assert.equal((await request("/admin/users/2/reset", adminCookie, {})).status, 302);
    const messages = (await fs.readFile(mailFile, "utf8")).trim().split("\n").map(JSON.parse);
    const resetUrl = new URL(messages.at(-1).text.match(/https:\/\/\S+$/)[0]);
    assert.equal(resetUrl.origin, origin);
    assert.equal(resetUrl.pathname, "/reset");
    const reset = await request("/reset", "", { token: resetUrl.searchParams.get("token"), password: replacement });
    assert.equal(reset.status, 302);
    assert.equal((await summary(legacyCookie)).status, 401);
    assert.ok(await verifyPassword(replacement, await passwordOf(2)));
    const changed = await request("/admin/preferences/password", organizerCookie, {
      currentPassword: password, newPassword: replacement, confirmPassword: replacement,
    });
    assert.equal(changed.headers.get("location"), "/login?notice=password_changed");
    assert.equal((await summary(organizerCookie)).status, 401);
    assert.equal((await summary(secondOrganizerCookie)).status, 401);
    assert.match(await passwordOf(organizerId), /^pbkdf2-sha256:v1:600000:/);
    const ordinary = await login(legacyEmail, replacement);
    assert.equal((await request("/admin/users/2/delete", adminCookie, {})).status, 302);
    assert.equal((await summary(ordinary)).status, 401);
    assert.equal((await summary(adminCookie)).status, 200);
    assert.equal((await summary(bootstrapCookie)).status, 200);
    const publicEvent = await request("/events/rollback-fixture-event");
    assert.equal(publicEvent.status, 200);
    assert.match(await publicEvent.text(), /Rollback fixture event/);
    assert.equal((await sql("SELECT viewCount FROM events WHERE id = 20"))[0].viewCount, 7);
    assert.equal((await sql("SELECT COUNT(*) AS count FROM event_views WHERE eventId = 20"))[0].count, 1);
    console.log("PASS same-file switch: pre-release schema → migrated release → rollback; both hashes, existing sessions, roles, bootstrap isolation, trusted reset, revocation, and post-release account/event/analytics data");
  } finally {
    await stop();
    if (db) await new Promise((resolve) => db.close(resolve));
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
