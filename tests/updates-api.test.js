"use strict";
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const sqlite3 = require("sqlite3");

function execSql(filename, sql) { return new Promise((resolve, reject) => { const db = new sqlite3.Database(filename); db.exec(sql, (error) => { db.close(); error ? reject(error) : resolve(); }); }); }
function wait(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function health(base) { for (let i = 0; i < 40; i += 1) { try { if ((await fetch(`${base}/health`)).ok) return; } catch (_) {} await wait(100); } throw new Error("Server did not start"); }

test("updates public API exposes only published city-scoped content and protects views", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencircle-updates-")); const dbPath = path.join(dir, "opencircle.db"); const port = 35000 + Math.floor(Math.random() * 1000); const base = `http://127.0.0.1:${port}`;
  const server = spawn(process.execPath, ["server.js"], { cwd: path.resolve(__dirname, ".."), env: { ...process.env, DB_PATH: dbPath, PORT: String(port) }, stdio: "ignore" });
  t.after(() => { server.kill(); fs.rmSync(dir, { recursive: true, force: true }); });
  await health(base);
  await execSql(dbPath, `INSERT INTO update_categories (city,name,slug) VALUES ('Enumclaw','Town News','town-news'),('Buckley','Town News','town-news');
    INSERT INTO updates (city,title,slug,summary,bodyHtml,status,publishedAt,updatedAt,categoryId) VALUES
    ('Enumclaw','Published Enumclaw','same-slug','Visible summary','<p>Visible</p>','published','2026-01-01T00:00:00.000Z','2026-01-02T00:00:00.000Z',(SELECT id FROM update_categories WHERE city='Enumclaw' AND slug='town-news')),
    ('Enumclaw','Draft Enumclaw','draft-slug','Hidden','<script>x</script>','draft',NULL,datetime('now'),NULL),
    ('Buckley','Published Buckley','same-slug','Buckley summary','<p>Buckley</p>','published','2026-01-03T00:00:00.000Z','2026-01-03T00:00:00.000Z',(SELECT id FROM update_categories WHERE city='Buckley' AND slug='town-news'));`);
  const enumclaw = await fetch(`${base}/updates?city=Enumclaw&limit=10`); assert.equal(enumclaw.status, 200); const list = await enumclaw.json(); assert.equal(list.meta.total, 1); assert.equal(list.data[0].title, "Published Enumclaw");
  assert.equal((await fetch(`${base}/updates`)).status, 400);
  const detail = await fetch(`${base}/updates/same-slug?city=Buckley`); assert.equal(detail.status, 200); assert.equal((await detail.json()).data.title, "Published Buckley");
  assert.equal((await fetch(`${base}/updates/draft-slug?city=Enumclaw`)).status, 404);
  const firstView = await fetch(`${base}/updates/1/view`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" }, body: "{}" }); assert.deepEqual(await firstView.json(), { ok: true, tracked: true });
  const repeatedView = await fetch(`${base}/updates/1/view`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Mozilla/5.0" }, body: "{}" }); assert.deepEqual(await repeatedView.json(), { ok: true, tracked: false });
  const botView = await fetch(`${base}/updates/1/view`, { method: "POST", headers: { "content-type": "application/json", "user-agent": "Googlebot" }, body: "{}" }); assert.deepEqual(await botView.json(), { ok: true, tracked: false });
});
