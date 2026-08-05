"use strict";

const crypto = require("crypto");

const PASSWORD_ITER = 120000;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(String(password || ""), salt, PASSWORD_ITER, 32, "sha256")
    .toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const test = crypto
    .pbkdf2Sync(String(password || ""), salt, PASSWORD_ITER, 32, "sha256")
    .toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
  } catch {
    return false;
  }
}

module.exports = {
  PASSWORD_ITER,
  hashPassword,
  hashToken,
  verifyPassword,
};
