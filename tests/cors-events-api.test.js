"use strict";

const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForHealth(baseUrl) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await wait(100);
  }
  throw lastError || new Error("Test API did not start.");
}

function hasHeaderValue(response, name, expectedValue) {
  return String(response.headers.get(name) || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .includes(String(expectedValue).toLowerCase());
}

test("public events CORS accepts community origins and safely rejects others", async (t) => {
  const testDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-cors-"));
  const dbPath = path.join(testDir, "opencircle.db");
  const port = 34000 + Math.floor(Math.random() * 1000);
  const baseUrl = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], {
    cwd: path.resolve(__dirname, ".."),
    env: { ...process.env, DB_PATH: dbPath, PORT: String(port) },
    stdio: "ignore",
  });

  t.after(() => {
    server.kill();
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  await waitForHealth(baseUrl);
  const eventsUrl = `${baseUrl}/events?city=Buckley&expand=1&limit=12&offset=0&sort=soonest&category=Seasonal%20%26%20Holiday`;

  for (const origin of ["https://enumclawevents.org", "https://plateauevents.org"]) {
    const response = await fetch(eventsUrl, { headers: { Origin: origin } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), origin);
    assert.ok(hasHeaderValue(response, "vary", "origin"));
  }

  const preflight = await fetch(`${baseUrl}/events`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://plateauevents.org",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "content-type, authorization, accept",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://plateauevents.org");
  assert.ok(hasHeaderValue(preflight, "vary", "origin"));
  assert.ok(hasHeaderValue(preflight, "access-control-allow-methods", "GET"));
  assert.ok(hasHeaderValue(preflight, "access-control-allow-headers", "Content-Type"));
  assert.ok(hasHeaderValue(preflight, "access-control-allow-headers", "Authorization"));
  assert.ok(hasHeaderValue(preflight, "access-control-allow-headers", "Accept"));

  const direct = await fetch(eventsUrl);
  assert.equal(direct.status, 200);

  const disallowedGet = await fetch(eventsUrl, { headers: { Origin: "https://untrusted.example" } });
  assert.equal(disallowedGet.status, 200);
  assert.equal(disallowedGet.headers.get("access-control-allow-origin"), null);

  const disallowedOptions = await fetch(`${baseUrl}/events`, {
    method: "OPTIONS",
    headers: {
      Origin: "https://untrusted.example",
      "Access-Control-Request-Method": "GET",
    },
  });
  assert.notEqual(disallowedOptions.status, 500);
  assert.equal(disallowedOptions.headers.get("access-control-allow-origin"), null);
});
