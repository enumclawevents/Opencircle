"use strict";

const crypto = require("crypto");
const { run } = require("../db");

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function arg(name, fallback = "") {
  const idx = process.argv.indexOf(name);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

async function main() {
  const email = arg("--email", "").trim().toLowerCase() || null;
  const days = Math.max(1, Math.min(30, parseInt(arg("--days", "7"), 10)));
  const base = arg("--base", "").trim();

  const token = crypto.randomBytes(20).toString("hex");
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();

  await run("INSERT INTO invites (email, tokenHash, expiresAt) VALUES (?, ?, ?)", [
    email,
    tokenHash,
    expiresAt,
  ]);

  if (base) {
    console.log(`${base.replace(/\/$/, "")}/signup?invite=${token}`);
  } else {
    console.log(token);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
