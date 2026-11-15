"use strict";

const sqlite3 = require("sqlite3");

const TOKEN_UNEXPIRED = "julianday(expiresAt) > julianday('now')";

function recoveryLink(path, parameter, token) {
  const configured = String(process.env.DASHBOARD_ORIGIN || "").trim();
  if (!/^https:\/\/[^/?#@\\\s]+\/?$/i.test(configured)) return null;
  try {
    const origin = new URL(configured).origin;
    const link = new URL(path, origin);
    link.searchParams.set(parameter, token);
    return link.href;
  } catch {
    return null;
  }
}

function protectTokenPage(res) {
  res.set("Cache-Control", "no-store");
  res.set("Referrer-Policy", "no-referrer");
}

// Keep awaited redemption statements isolated from other application writes
// on the shared SQLite connection. SQLite arbitrates competing writers.
async function withRedemptionTransaction(filename, work) {
  const connection = await new Promise((resolve, reject) => {
    const db = new sqlite3.Database(filename, sqlite3.OPEN_READWRITE, (error) => {
      if (error) reject(error);
      else resolve(db);
    });
  });
  connection.configure("busyTimeout", 5000);
  const run = (sql, params = []) => new Promise((resolve, reject) => {
    connection.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve(this.changes);
    });
  });
  const get = (sql, params) => new Promise((resolve, reject) => {
    connection.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
  try {
    await run("PRAGMA foreign_keys = ON");
    await run("BEGIN IMMEDIATE");
    try {
      const result = await work({ run, get });
      await run("COMMIT");
      return result;
    } catch (error) {
      await run("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    await new Promise((resolve) => connection.close(resolve));
  }
}

module.exports = { recoveryLink, protectTokenPage, TOKEN_UNEXPIRED, withRedemptionTransaction };
