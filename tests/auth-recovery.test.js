"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pbkdf2Sync, randomBytes } = require("node:crypto");
const test = require("node:test");
const sqlite3 = require("sqlite3");
const { hashPassword, hashToken, verifyPassword } = require("../lib/auth");
const { recoveryLink } = require("../lib/auth-recovery");
const { createSessionStore } = require("../lib/auth-sessions");

function legacyHash(password) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
}

test("recovery links require a configured HTTPS origin", (t) => {
  const existing = process.env.DASHBOARD_ORIGIN;
  t.after(() => {
    if (existing === undefined) delete process.env.DASHBOARD_ORIGIN;
    else process.env.DASHBOARD_ORIGIN = existing;
  });
  for (const value of ["", "http://example.test", "https://example.test/reset", "https://example.test/?", "https://user@example.test", "https://example.test/#", "https://example.test\\evil"]) {
    process.env.DASHBOARD_ORIGIN = value;
    assert.equal(recoveryLink("/reset", "token", "fixture"), null);
  }
  process.env.DASHBOARD_ORIGIN = "https://dashboard.example.test/";
  assert.equal(recoveryLink("/invite", "invite", "fixture+token"),
    "https://dashboard.example.test/invite?invite=fixture%2Btoken");
});

test("recovery routes use trusted links and redeem tokens atomically", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-recovery-"));
  const dbPath = path.join(dir, "fixture.db");
  const mailPath = path.join(dir, "mail.jsonl");
  const preload = path.join(dir, "mail.cjs");
  const port = 35000 + Math.floor(Math.random() * 1500);
  const base = `http://127.0.0.1:${port}`;
  const dashboard = "https://dashboard.example.test";
  fs.writeFileSync(preload, `
    const mailer = require(${JSON.stringify(require.resolve("../mailer"))});
    const fs = require("node:fs");
    mailer.sendEmail = async (message) => {
      fs.appendFileSync(${JSON.stringify(mailPath)}, JSON.stringify(message) + "\\n");
      if (message.to === "mail-failure@example.test") throw new Error(message.text);
      return true;
    };
  `);
  const bootstrapUser = "fixture-bootstrap";
  const bootstrapPassword = "Fixture bootstrap login!";
  let server;
  let errors = "";
  async function stopServer() {
    if (server?.exitCode === null && server.signalCode === null) {
      server.kill();
      await once(server, "exit");
    }
  }
  async function startServer() {
    server = spawn(process.execPath, ["--require", preload, "server.js"], {
      cwd: path.resolve(__dirname, ".."),
      env: {
        ...process.env, NODE_ENV: "test", PORT: String(port), DB_PATH: dbPath, DASHBOARD_ORIGIN: dashboard,
        AUTH_RATE_LIMIT_IP_MODE: "direct", ADMIN_USER: bootstrapUser, ADMIN_PASS: bootstrapPassword,
      },
      stdio: ["ignore", "ignore", "pipe"],
    });
    server.stderr.on("data", (chunk) => { errors += chunk; });
    for (let attempt = 0; ; attempt++) {
      if (server.exitCode !== null || attempt >= 60) assert.fail("Disposable API did not start");
      try { if ((await fetch(base + "/health")).ok) break; } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  t.after(async () => {
    await stopServer();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  await startServer();

  const db = new sqlite3.Database(dbPath);
  t.after(() => new Promise((resolve) => db.close(resolve)));
  const sql = (query, params = []) => new Promise((resolve, reject) => {
    db.all(query, params, (error, rows) => error ? reject(error) : resolve(rows));
  });
  const request = (route, options = {}) => fetch(base + route, {
    redirect: "manual",
    ...options,
    headers: { host: "untrusted.example.test", "x-forwarded-host": "untrusted.example.test",
      "x-forwarded-proto": "http", ...options.headers },
  });
  const post = (route, body, cookie) => request(route, {
    method: "POST",
    headers: cookie ? { cookie } : {},
    body: new URLSearchParams(body),
  });
  const assertPrivate = (response) => {
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  };
  const mail = () => fs.readFileSync(mailPath, "utf8").trim().split("\n").map(JSON.parse);
  const tokenFromEmail = (message, route, parameter) => {
    const url = new URL(message.text.match(/https:\/\/\S+$/)[0]);
    assert.equal(url.origin, dashboard);
    assert.equal(url.pathname, route);
    assert.ok(message.html.includes(url.href));
    return url.searchParams.get(parameter);
  };

  const initialPassword = "Fixture password 1!";
  const nextPassword = "Fixture replacement 2!";
  const organizer = "organizer@example.test";
  const admin = "daniel@opencircleapi.com";
  for (const [id, email, role] of [[1, organizer, "organizer"], [2, admin, "admin"], [3, "mail-failure@example.test", "organizer"]]) {
    await sql("INSERT INTO users (id, email, passwordHash, role, city) VALUES (?, ?, ?, ?, 'Enumclaw')",
      [id, email, legacyHash(initialPassword), role]);
  }
  await sql("UPDATE users SET username = ? WHERE id = 1", ["fixture-organizer"]);
  await sql("INSERT INTO users (id, username, email, passwordHash, role, city) VALUES (4, ?, ?, ?, 'organizer', 'Buckley')",
    [bootstrapUser, "bootstrap-shadow@example.test", await hashPassword(initialPassword)]);
  const developer = "developer@example.test";
  await sql("INSERT INTO users (id, username, email, passwordHash, role, city, permissionsJson) VALUES (5, ?, ?, ?, 'developer', 'Buckley', ?)",
    ["FIXTURE-ORGANIZER", developer, await hashPassword(initialPassword), JSON.stringify({ cityAccess: ["Buckley"] })]);
  const login = async (email, password = initialPassword) => {
    const response = await post("/login", { username: email, password });
    assert.equal(response.status, 302);
    return response.headers.get("set-cookie").split(";")[0];
  };
  const adminCookie = await login(admin);
  const [organizerCookie] = await Promise.all([login(organizer), login("fixture-organizer")]);
  const [upgradedOrganizer] = await sql("SELECT passwordHash, role FROM users WHERE id = 1");
  assert.match(upgradedOrganizer.passwordHash, /^pbkdf2-sha256:v1:600000:/);
  assert.equal(upgradedOrganizer.role, "organizer");
  assert.ok(await verifyPassword(initialPassword, upgradedOrganizer.passwordHash));
  const bootstrapCookie = await login(bootstrapUser, bootstrapPassword);
  const developerCookie = await login("FIXTURE-ORGANIZER");
  const summary = (cookie) => request("/admin/dashboard-summary", { headers: { cookie } });
  const cookieHash = (cookie) => hashToken(cookie.slice("oc_auth=".length));
  const [bootstrapSession] = await sql("SELECT principalType, userId FROM auth_sessions WHERE tokenHash = ?", [cookieHash(bootstrapCookie)]);
  assert.equal(bootstrapSession.principalType, "bootstrap");
  assert.notEqual(bootstrapSession.userId, 4);
  assert.notEqual(bootstrapSession.userId, 5);
  assert.equal((await (await summary(bootstrapCookie)).json()).role, "developer");
  const shadowCookie = await login(bootstrapUser);
  assert.equal((await (await summary(shadowCookie)).json()).role, "organizer");
  assert.equal((await post("/admin/users/1/reset", {}, bootstrapCookie)).status, 403);
  const [storedDeveloperSession] = await sql("SELECT principalType, userId FROM auth_sessions WHERE tokenHash = ?", [cookieHash(developerCookie)]);
  assert.deepEqual(storedDeveloperSession, { principalType: "account", userId: 5 });
  await sql("UPDATE users SET username = ?, email = ? WHERE id = 5", ["renamed-developer", developer]);
  const developerSummary = await (await summary(developerCookie)).json();
  assert.equal(developerSummary.role, "developer");
  assert.deepEqual(developerSummary.scope.cities, ["Buckley", "Wilkeson", "Carbonado", "South Prairie"]);

  await sql("INSERT INTO auth_sessions (tokenHash, user, role, city, exp) VALUES (?, 'fixture-organizer', 'developer', 'Enumclaw', ?)",
    [hashToken("legacy"), Date.now() + 60_000]);
  assert.equal((await summary("oc_auth=legacy")).status, 401);
  const wrongLogin = (username, spoofedIp) => request("/login", {
    method: "POST",
    headers: { "x-forwarded-for": spoofedIp, "cf-connecting-ip": spoofedIp },
    body: new URLSearchParams({ username, password: "incorrect" }),
  });
  const aliases = [organizer, "fixture-organizer", ` ${organizer.toUpperCase()} `, "fixture-organizer", organizer, organizer, organizer];
  const failures = await Promise.all(aliases.map((alias, index) => wrongLogin(alias, `198.51.100.${index + 1}`)));
  assert.deepEqual(failures.map((result) => result.status).sort(), [401, 401, 401, 401, 401, 429, 429]);
  assert.ok(Number(failures.find((result) => result.status === 429).headers.get("retry-after")) > 0);
  await stopServer();
  await startServer();
  assert.equal((await wrongLogin("fixture-organizer", "198.51.100.99")).status, 429);
  await login(admin); // The restricted organizer and this admin share a socket IP.
  for (const identifier of [bootstrapUser, "missing-account@example.test"]) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const result = await wrongLogin(identifier, "198.51.100.90");
      assert.equal(result.status, 401);
      assert.equal(await result.text(), "Invalid credentials");
    }
    assert.equal((await wrongLogin(identifier, "198.51.100.90")).status, 429);
  }

  const firstForgot = await post("/forgot", { email: organizer });
  const repeatedForgot = await post("/forgot", { email: ` ${organizer.toUpperCase()} ` });
  const unknownForgot = await post("/forgot", { email: "unknown@example.test" });
  assert.equal(firstForgot.status, 200);
  assert.equal(repeatedForgot.status, 200);
  assert.equal(unknownForgot.status, 200);
  const generic = await firstForgot.text();
  assert.equal(await repeatedForgot.text(), generic);
  assert.equal(await unknownForgot.text(), generic);
  assert.equal(mail().length, 1);
  assert.equal((await post("/admin/users/1/reset", {}, adminCookie)).status, 302);
  assert.equal((await post("/admin/users/2/reset", {}, adminCookie)).status, 302);
  const [selfReset, siblingReset, adminReset] = mail().map((message) => tokenFromEmail(message, "/reset", "token"));
  assert.equal((await post("/forgot", { email: "mail-failure@example.test" })).status, 200);
  const failedEmailToken = tokenFromEmail(mail()[3], "/reset", "token");

  const resetPage = await request("/reset?token=" + selfReset);
  assertPrivate(resetPage);
  assert.match(await resetPage.text(), /name="password"/);
  const reset = (token) => post("/reset", { token, password: nextPassword });
  assert.equal((await reset("invalid")).status, 400);
  assert.equal((await post("/reset", { token: selfReset, password: "x".repeat(257) })).status, 400);
  await sql("INSERT INTO password_resets (userId, tokenHash, expiresAt) VALUES (1, ?, datetime('now', '-1 day'))", [hashToken("expired")]);
  assert.equal((await reset("expired")).status, 400);
  const concurrent = await Promise.all([reset(selfReset), reset(selfReset)]);
  assert.deepEqual(concurrent.map((res) => res.status).sort(), [302, 400]);
  assert.equal((await reset(siblingReset)).status, 400);
  assert.equal((await reset(adminReset)).status, 302);
  const [staleLogin, concurrentReset] = await Promise.all([
    post("/login", { username: "mail-failure@example.test", password: initialPassword }),
    reset(failedEmailToken),
  ]);
  assert.equal(concurrentReset.status, 302);
  assert.ok([302, 401].includes(staleLogin.status));
  if (staleLogin.status === 302) {
    const staleCookie = staleLogin.headers.get("set-cookie").split(";")[0];
    assert.equal((await summary(staleCookie)).status, 401);
  }
  const [racedAccount] = await sql("SELECT passwordHash FROM users WHERE id = 3");
  assert.ok(await verifyPassword(nextPassword, racedAccount.passwordHash));
  assert.equal(await verifyPassword(initialPassword, racedAccount.passwordHash), false);
  for (const id of [1, 2]) {
    const [row] = await sql("SELECT passwordHash FROM users WHERE id = ?", [id]);
    assert.match(row.passwordHash, /^pbkdf2-sha256:v1:600000:/);
    assert.ok(await verifyPassword(nextPassword, row.passwordHash));
  }
  assert.equal((await request("/admin/dashboard-summary", { headers: { cookie: organizerCookie } })).status, 401);
  assert.equal((await request("/admin/dashboard-summary", { headers: { cookie: adminCookie } })).status, 401);
  const renewedAdminCookie = await login(admin, nextPassword);

  const freshExpiry = new Date(Date.now() + 60_000).toISOString();
  await sql("INSERT INTO password_resets (userId, tokenHash, expiresAt) VALUES (1, ?, ?)", [hashToken("rollback"), freshExpiry]);
  await sql("CREATE TRIGGER fail_reset BEFORE UPDATE OF passwordHash ON users BEGIN SELECT RAISE(ABORT, 'fixture reset failure'); END");
  assert.equal((await reset("rollback")).status, 500);
  assert.equal((await sql("SELECT usedAt FROM password_resets WHERE tokenHash = ?", [hashToken("rollback")]))[0].usedAt, null);
  await sql("DROP TRIGGER fail_reset");
  assert.equal((await reset("rollback")).status, 302);

  assert.equal((await post("/admin/users/1/resend-invite", {}, renewedAdminCookie)).status, 302);
  tokenFromEmail(mail()[4], "/invite", "invite");
  const inviteResult = await post("/admin/invites", { role: "organizer", city: "Enumclaw" }, renewedAdminCookie);
  assert.equal(inviteResult.status, 200);
  assert.equal(inviteResult.headers.get("location"), null);
  assertPrivate(inviteResult);
  const inviteHtml = await inviteResult.text();
  assert.doesNotMatch(inviteHtml, /unpkg\.com\/lucide/);
  const [, invite] = /https:\/\/dashboard\.example\.test\/invite\?invite=([a-f0-9]+)/.exec(inviteHtml);
  const invitePage = await request("/invite?invite=" + invite);
  assertPrivate(invitePage);
  assert.match(await invitePage.text(), /name="invite"/);
  const accept = (token, name) => post("/invite", { invite: token, email: name + "@example.test", username: name,
    password: initialPassword, confirmPassword: initialPassword, agreeToTerms: "yes" });
  await sql("INSERT INTO invites (tokenHash, expiresAt) VALUES (?, datetime('now', '-1 day'))", [hashToken("expired")]);
  assert.equal((await accept("expired", "expired")).status, 410);
  assert.equal((await accept("missing", "invalid")).status, 404);
  assert.equal((await post("/invite", { invite, email: "long@example.test", username: "long",
    password: "x".repeat(257), confirmPassword: "x".repeat(257), agreeToTerms: "yes" })).status, 400);
  await sql("CREATE TRIGGER fail_invite BEFORE INSERT ON users BEGIN SELECT RAISE(ABORT, 'fixture invite failure'); END");
  assert.equal((await accept(invite, "first")).status, 500);
  assert.equal((await sql("SELECT usedAt FROM invites WHERE tokenHash = ?", [hashToken(invite)]))[0].usedAt, null);
  await sql("DROP TRIGGER fail_invite");
  const accepts = await Promise.all([accept(invite, "first"), accept(invite, "second")]);
  assert.deepEqual(accepts.map((res) => res.status).sort(), [302, 410]);
  assert.equal((await sql("SELECT COUNT(*) AS count FROM users WHERE username IN ('first', 'second')"))[0].count, 1);
  const [invitedAccount] = await sql("SELECT passwordHash FROM users WHERE username IN ('first', 'second')");
  assert.match(invitedAccount.passwordHash, /^pbkdf2-sha256:v1:600000:/);
  assert.ok(await verifyPassword(initialPassword, invitedAccount.passwordHash));
  const resentInvite = tokenFromEmail(mail()[4], "/invite", "invite");
  assert.equal((await sql("SELECT usedAt FROM invites WHERE tokenHash = ?", [hashToken(resentInvite)]))[0].usedAt, null);

  const resetAbuse = await Promise.all(Array.from({ length: 7 }, () => reset("fixture-nonexistent-token")));
  assert.deepEqual(resetAbuse.map((result) => result.status).sort(), [400, 400, 400, 400, 400, 400, 429]);
  for (let attempt = 0; attempt < 6; attempt++) {
    assert.equal((await post("/forgot", { email: `unused-${attempt}@example.test` })).status, 200);
  }
  const limitedForgot = await post("/forgot", { email: "another-unused@example.test" });
  assert.equal(limitedForgot.status, 429);
  assert.ok(Number(limitedForgot.headers.get("retry-after")) > 0);
  assert.equal(mail().length, 5);

  const [staleDeveloper] = await sql("SELECT id, passwordHash FROM users WHERE id = 5");
  const rejectedChange = await post("/admin/preferences/password", {
    currentPassword: initialPassword, newPassword: "x".repeat(257), confirmPassword: "x".repeat(257),
  }, developerCookie);
  assert.match(rejectedChange.headers.get("location"), /password_long$/);
  const changedPassword = await post("/admin/preferences/password", {
    currentPassword: initialPassword, newPassword: nextPassword, confirmPassword: nextPassword,
  }, developerCookie);
  assert.equal(changedPassword.headers.get("location"), "/login?notice=password_changed");
  const postChange = await Promise.all([summary(developerCookie), summary(developerCookie), summary(renewedAdminCookie)]);
  assert.deepEqual(postChange.map((result) => result.status), [401, 401, 200]);
  const testStore = createSessionStore({
    get: async (query, params) => (await sql(query, params))[0],
    filename: dbPath, bootstrapUser, ttlMs: 60_000,
  });
  assert.equal(await testStore.createAccountSession(staleDeveloper, await hashPassword(initialPassword)), null);
  const [changedDeveloper] = await sql("SELECT passwordHash FROM users WHERE id = 5");
  assert.match(changedDeveloper.passwordHash, /^pbkdf2-sha256:v1:600000:/);
  assert.ok(await verifyPassword(nextPassword, changedDeveloper.passwordHash));

  const deletionCookie = await login(developer, nextPassword);
  await sql("CREATE TRIGGER fail_revoke BEFORE DELETE ON auth_sessions WHEN OLD.userId = 5 BEGIN SELECT RAISE(ABORT, 'fixture revocation failure'); END");
  assert.equal((await post("/admin/users/5/delete", {}, renewedAdminCookie)).status, 500);
  assert.equal((await summary(deletionCookie)).status, 200);
  await sql("DROP TRIGGER fail_revoke");
  assert.equal((await post("/admin/users/5/delete", {}, renewedAdminCookie)).status, 302);
  assert.equal((await summary(deletionCookie)).status, 401);
  assert.equal((await sql("SELECT COUNT(*) AS count FROM auth_sessions WHERE userId = 5"))[0].count, 0);
  assert.equal((await summary(renewedAdminCookie)).status, 200);
  assert.equal((await summary(bootstrapCookie)).status, 200);
  assert.equal((await post("/logout", {}, bootstrapCookie)).status, 302);
  assert.equal((await summary(bootstrapCookie)).status, 401);
  await sql("UPDATE auth_sessions SET exp = ? WHERE tokenHash = ?", [Date.now() - 1000, cookieHash(shadowCookie)]);
  assert.equal((await summary(shadowCookie)).status, 401);

  const marker = "fixture-auth-body-secret";
  await request("/reset?token=" + selfReset, { method: "POST",
    headers: { "content-type": "application/json", cookie: organizerCookie },
    body: '{"password":"' + marker + '",' });
  assert.match(errors, /Request failed/);
  for (const secret of [marker, selfReset, failedEmailToken, organizerCookie, invite, initialPassword, nextPassword]) {
    assert.equal(errors.includes(secret), false);
  }
});
