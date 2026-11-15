"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const root = process.cwd();
const sqlite3 = require(path.join(root, "node_modules/sqlite3"));
const { hashPassword, hashToken } = require(path.join(root, "lib/auth"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "auth-release-"));
  const filename = path.join(dir, "opencircle.db");
  const db = new sqlite3.Database(filename);
  const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
  const preload = path.join(dir, "accelerate.cjs");
  const clockFile = path.join(dir, "clock-offset");
  let child;
  try {
    await fs.writeFile(preload, `
      const interval = global.setInterval;
      let pruneTick;
      global.setInterval = (work, delay, ...args) => {
        if (delay === 1800000) {
          pruneTick = () => work(...args);
          process.on("message", (message) => { if (message === "prune") pruneTick(); });
          return;
        }
        return interval(work, delay, ...args);
      };
      const fs = require("node:fs");
      const realNow = Date.now;
      Date.now = () => realNow() + (fs.existsSync(${JSON.stringify(clockFile)})
        ? Number(fs.readFileSync(${JSON.stringify(clockFile)}, "utf8")) : 0);
    `);
    await all("CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, username TEXT UNIQUE, passwordHash TEXT, role TEXT, city TEXT, displayName TEXT, createdAt TEXT)");
    await all("CREATE TABLE auth_sessions (tokenHash TEXT PRIMARY KEY, user TEXT NOT NULL, role TEXT, city TEXT, exp INTEGER NOT NULL, createdAt TEXT)");
    const password = "Disposable password only!";
    await all("INSERT INTO users (id, email, username, passwordHash, role, city, createdAt) VALUES (10, 'disposable@example.test', 'fixture', ?, 'developer', 'Enumclaw', datetime('now'))", [await hashPassword(password)]);
    await all("INSERT INTO auth_sessions (tokenHash, user, role, city, exp) VALUES (?, 'fixture', 'developer', 'Enumclaw', ?)",
      [hashToken("legacy-fixture-token"), Date.now() + 60_000]);
    const port = 36500 + Math.floor(Math.random() * 1000);
    child = spawn(process.execPath, ["--require", preload, path.join(root, "server.js")], {
      cwd: root,
      env: { ...process.env, DB_PATH: "", RENDER_DISK_PATH: dir, UPLOADS_DIR: path.join(dir, "uploads"),
        PORT: String(port), NODE_ENV: "production", ADMIN_USER: "bootstrap@example.test", ADMIN_PASS: "disposable bootstrap fixture",
        SMTP_HOST: "", DASHBOARD_ORIGIN: "invalid", AUTH_RATE_LIMIT_IP_MODE: "", AUTH_RATE_LIMIT_TRUSTED_PROXY_CIDRS: "" },
      stdio: ["ignore", "ignore", "inherit", "ipc"],
    });
    const base = "http://127.0.0.1:" + port;
    let healthy = false;
    for (let i = 0; i < 80 && !healthy; i++) {
      if (child.exitCode !== null) break;
      try { healthy = (await fetch(base + "/health")).ok; } catch {}
      if (!healthy) await sleep(50);
    }
    assert.ok(healthy);
    const call = (route, options = {}) => fetch(base + route, { redirect: "manual", ...options });
    const post = (route, body, headers = {}) => call(route, { method: "POST", headers, body: new URLSearchParams(body) });
    const login = (username, pass, headers) => post("/login", { username, password: pass }, headers);
    const summary = (cookie) => call("/admin/dashboard-summary", { headers: { cookie } });
    assert.equal((await summary("oc_auth=legacy-fixture-token")).status, 401);
    const columns = (await all("PRAGMA table_info(auth_sessions)")).map(({name}) => name);
    assert.ok(columns.includes("userId") && columns.includes("principalType"));
    assert.ok((await all("PRAGMA table_info(users)")).some(({name}) => name === "bootstrapIdentity"));
    const signed = await login("disposable@example.test", password);
    assert.equal(signed.status, 302);
    assert.match(signed.headers.get("set-cookie"), /; Secure/);
    assert.equal((await summary(signed.headers.get("set-cookie").split(";")[0])).status, 200);
    for (let i = 0; i < 15; i++) {
      const denied = await login(i % 2 ? "fixture" : "disposable@example.test", "incorrect", { "x-forwarded-for": "203.0.113." + (i + 1) });
      assert.equal(denied.status, 401);
    }
    const denied = await login("fixture", "incorrect");
    assert.equal(denied.status, 429);
    assert.ok(Number(denied.headers.get("retry-after")) > 0);
    assert.equal((await all("SELECT count FROM auth_rate_limits WHERE kind = 'login-account'"))[0].count, 15);
    assert.deepEqual(await all("SELECT * FROM auth_rate_limits WHERE kind IN ('login-ip', 'login-pair')"), []);
    await all("UPDATE auth_rate_limits SET expiresAt = ?", [Date.now() - 1]);
    assert.equal((await login("fixture", password)).status, 302);
    assert.deepEqual(await all("SELECT * FROM auth_rate_limits WHERE kind = 'login-account'"), []);
    assert.equal((await post("/forgot", { email: "disposable@example.test" })).status, 503);
    assert.equal((await post("/forgot", { email: "unknown@example.test" })).status, 503);
    assert.equal((await all("SELECT COUNT(*) AS count FROM password_resets"))[0].count, 0);
    console.log("PASS existing-schema startup migration, mount-path fallback, legacy session rejection, Secure cookie, default no-IP limits, account-wide restriction expiry, invalid-origin recovery");

    const addExpired = async (token) => all(
      "INSERT INTO auth_sessions (tokenHash, user, role, city, exp, userId, principalType) VALUES (?, 'fixture', 'developer', 'Enumclaw', ?, 10, 'account')",
      [hashToken(token), Date.now() - 1000]
    );
    const rowCount = async (token) => (await all("SELECT COUNT(*) AS count FROM auth_sessions WHERE tokenHash = ?", [hashToken(token)]))[0].count;
    const active = signed.headers.get("set-cookie").split(";")[0];

    await addExpired("scheduled-expired");
    assert.equal((await summary("oc_auth=scheduled-expired")).status, 401);
    assert.equal(await rowCount("scheduled-expired"), 1);
    child.send("prune");
    for (let i = 0; i < 40 && await rowCount("scheduled-expired"); i++) await sleep(25);
    assert.equal(await rowCount("scheduled-expired"), 0);
    assert.equal((await summary(active)).status, 200);
    console.log("PASS scheduled cleanup removes expired sessions and preserves active sessions");

    await addExpired("request-expired");
    assert.equal((await summary("oc_auth=request-expired")).status, 401);
    assert.equal(await rowCount("request-expired"), 1, "Request pruning should wait out the scheduled 30-minute interval");
    await fs.writeFile(clockFile, String(31 * 60_000));
    assert.equal((await summary("oc_auth=request-expired")).status, 401);
    assert.equal(await rowCount("request-expired"), 0, "Request pruning should resume after the 30-minute interval");
    assert.equal((await summary(active)).status, 200);
    console.log("PASS request-triggered pruning resumes after the scheduled run with the original cadence");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await once(child, "exit");
    }
    await new Promise((resolve) => db.close(resolve));
    await fs.rm(dir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
