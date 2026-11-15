"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");

const LEGACY_PASSWORD_ITER = 120_000;
const PASSWORD_ITER = 600_000;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 256;
const FORMAT = "pbkdf2-sha256:v1";
const derive = promisify(crypto.pbkdf2);
const dummySalt = crypto.randomBytes(16).toString("hex");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = await derive(String(password || ""), salt, PASSWORD_ITER, 32, "sha256");
  return `${FORMAT}:${PASSWORD_ITER}:${salt}:${hash.toString("hex")}`;
}

function parsePasswordHash(stored) {
  const legacy = /^([a-f0-9]{32}):([a-f0-9]{64})$/.exec(String(stored || ""));
  if (legacy) return { iterations: LEGACY_PASSWORD_ITER, salt: legacy[1], hash: legacy[2] };

  const versioned = /^pbkdf2-sha256:v1:([1-9][0-9]{0,6}):([a-f0-9]{32}):([a-f0-9]{64})$/.exec(String(stored || ""));
  if (!versioned) return null;
  const iterations = Number(versioned[1]);
  if (iterations < LEGACY_PASSWORD_ITER || iterations > 2_000_000) return null;
  return { iterations, salt: versioned[2], hash: versioned[3] };
}

async function verifyPassword(password, stored, { balanceFailure = false } = {}) {
  const parsed = parsePasswordHash(stored);
  const value = String(password || "");
  if (!parsed) {
    if (balanceFailure) await derive(value, dummySalt, PASSWORD_ITER, 32, "sha256");
    return false;
  }
  const test = await derive(value, parsed.salt, parsed.iterations, 32, "sha256");
  const valid = crypto.timingSafeEqual(Buffer.from(parsed.hash, "hex"), test);
  if (!valid && balanceFailure && parsed.iterations < PASSWORD_ITER) {
    await derive(value, dummySalt, PASSWORD_ITER - parsed.iterations, 32, "sha256");
  }
  return valid;
}

function needsPasswordUpgrade(stored) {
  const parsed = parsePasswordHash(stored);
  return !!parsed && parsed.iterations < PASSWORD_ITER;
}

function passwordLengthError(password) {
  if (password.length < MIN_PASSWORD_LENGTH) return "password_short";
  if (password.length > MAX_PASSWORD_LENGTH) return "password_long";
  return null;
}

module.exports = {
  PASSWORD_ITER, MIN_PASSWORD_LENGTH, MAX_PASSWORD_LENGTH,
  hashPassword, hashToken, verifyPassword, needsPasswordUpgrade, passwordLengthError,
};
