"use strict";

const assert = require("node:assert/strict");
const { pbkdf2Sync } = require("node:crypto");
const test = require("node:test");
const { hashPassword, needsPasswordUpgrade, passwordLengthError, verifyPassword } = require("../lib/auth");

test("PBKDF2 retains legacy verification and writes versioned, independently salted hashes", async () => {
  const password = "  a long unicode passphrase ☕ ".repeat(16);
  const salt = "a".repeat(32);
  const legacy = salt + ":" + pbkdf2Sync(password, salt, 120_000, 32, "sha256").toString("hex");
  assert.ok(await verifyPassword(password, legacy));
  assert.equal(await verifyPassword(password.trim(), legacy), false);
  assert.ok(needsPasswordUpgrade(legacy));

  const hashes = await Promise.all([hashPassword(password), hashPassword(password)]);
  assert.match(hashes[0], /^pbkdf2-sha256:v1:600000:[a-f0-9]{32}:[a-f0-9]{64}$/);
  assert.notEqual(hashes[0], hashes[1]);
  assert.equal(needsPasswordUpgrade(hashes[0]), false);
  assert.ok(await verifyPassword(password, hashes[0]));
  assert.equal(await verifyPassword("incorrect", hashes[0]), false);
  assert.equal(await verifyPassword(password, hashes[0].replace(":600000:", ":9999999:")), false);
  assert.equal(await verifyPassword(password, hashes[0].replace(":v1:", ":v2:")), false);
  assert.equal(passwordLengthError("x".repeat(7)), "password_short");
  assert.equal(passwordLengthError("x".repeat(256)), null);
  assert.equal(passwordLengthError("x".repeat(257)), "password_long");
});
