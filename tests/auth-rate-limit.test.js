"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");
const { createAuthIpResolver, createAuthRateLimiter, ensureAuthRateLimitSchema, limits } = require("../lib/auth-rate-limit");

test("auth IP resolution ignores spoofed headers outside verified ingress", () => {
  const req = {
    socket: { remoteAddress: "::ffff:192.0.2.4" },
    ip: "203.0.113.9",
    headers: { "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "203.0.113.9" },
  };
  assert.equal(createAuthIpResolver({})(req), null);
  assert.equal(createAuthIpResolver({ mode: "direct" })(req), "192.0.2.4");
  const renderIp = createAuthIpResolver({ mode: "render", trustedProxyCidrs: "192.0.2.0/24" });
  assert.equal(renderIp(req), "203.0.113.9");
  assert.equal(renderIp({ ...req, socket: { remoteAddress: "198.51.100.5" } }), null);
  assert.equal(renderIp({ ...req, headers: { "x-forwarded-for": req.ip } }), null);
  assert.equal(renderIp({ ...req, headers: { "cf-connecting-ip": "203.0.113.9, 203.0.113.12" } }), null);
});

test("SQLite limiter serializes attempts, persists windows, expires and bounds buckets", async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-rate-limit-"));
  const file = path.join(directory, "limits.db");
  const db = new sqlite3.Database(file);
  t.after(async () => {
    await new Promise((resolve) => db.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await ensureAuthRateLimitSchema((sql) => new Promise((resolve, reject) => {
    db.run(sql, (error) => error ? reject(error) : resolve());
  }));

  let time = 1000;
  const first = createAuthRateLimiter(file, () => time);
  const second = createAuthRateLimiter(file, () => time);
  const ip = "192.0.2.10";
  const volume = limits.loginVolume(ip);
  const account = limits.loginFailures(["user", 1], ip);
  const attempts = await Promise.all(Array.from({ length: 8 }, (_, index) =>
    (index % 2 ? first : second).take(volume, account)));
  assert.equal(attempts.filter((value) => value === null).length, 5);
  assert.deepEqual(await second.take(volume, account), { retryAfter: 900, volumeLimited: false });
  assert.equal(await second.take(volume, limits.loginFailures(["user", 2], ip)), null);
  await first.clearFailures(account);
  assert.equal(await second.take(volume, account), null);
  for (let i = 0; i < 19; i++) assert.equal(await first.take(volume, []), null);
  assert.deepEqual(await second.take(volume, []), { retryAfter: 900, volumeLimited: true });
  time += 899_001;
  assert.equal((await first.take(volume, [])).retryAfter, 1);
  time += 999;
  assert.equal(await second.take(volume, account), null);

  const distributed = ["user", 3];
  for (let i = 1; i <= 15; i++) {
    assert.equal(await first.take(null, limits.loginFailures(distributed, `198.51.100.${i}`)), null);
  }
  assert.equal((await second.take(null, limits.loginFailures(distributed, "198.51.100.100"))).retryAfter, 900);
  const capped = createAuthRateLimiter(file, () => time, 1);
  assert.equal(await capped.take(null, [limits.recoveryAddress("original@example.test")]), null);
  assert.equal((await capped.take(null, [limits.recoveryAddress("new@example.test")])).volumeLimited, true);
  time += 900_000;
  assert.equal(await capped.take(null, [limits.recoveryAddress("new@example.test")]), null);
});
