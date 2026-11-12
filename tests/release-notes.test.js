"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.DB_PATH = ":memory:";
delete process.env.APP_VERSION;

const { initDB, all, run } = require("../db");
const catalog = require("../data/release-notes.json");
const { version } = require("../package.json");
const { appVersion, publishCurrentRelease, readReleaseNotes, renderReleaseEntries } = require("../lib/release-notes");

test("curated releases appear after publication and keep their first date across retries", async () => {
  await initDB();
  assert.equal(appVersion, `v${version}`);
  assert.ok(catalog.releases[version]?.changes.length);
  const before = await readReleaseNotes();
  assert.equal(before.releases[0].date, "2026-05-05");
  assert.ok(before.releases.every(release => !release.version));
  assert.equal(before.hasMore, true);

  const notes = catalog.releases[version];
  delete catalog.releases[version];
  try {
    await publishCurrentRelease();
    assert.deepEqual(await all("SELECT version FROM published_releases"), []);
  } finally {
    catalog.releases[version] = notes;
  }

  await Promise.all([publishCurrentRelease(), publishCurrentRelease()]);
  const published = await readReleaseNotes();
  assert.equal(published.releases[0].version, version);
  assert.equal(published.releases.length, 4);
  assert.equal(published.latestVersion, version);
  assert.match(renderReleaseEntries(published), /Latest release/);

  const older = await readReleaseNotes({ page: "2" });
  assert.ok(older.releases[0].date < published.releases.at(-1).date);
  const fixed = await readReleaseNotes({ category: "fixed" });
  assert.ok(fixed.releases.length);
  assert.ok(fixed.releases.every(release => release.changes.every(change => change.category === "fixed")));
  assert.doesNotMatch(renderReleaseEntries(fixed), /Organizer venue access/);
  assert.match(renderReleaseEntries(await readReleaseNotes()), /Organizer venue access/);

  const original = await all("SELECT version, date FROM published_releases");
  delete require.cache[require.resolve("../lib/release-notes")];
  await require("../lib/release-notes").publishCurrentRelease();
  assert.deepEqual(await all("SELECT version, date FROM published_releases"), original);

  await run("INSERT INTO published_releases (version, date) VALUES ('9.9.9', '2099-01-01')");
  assert.equal((await readReleaseNotes()).latestVersion, version);
});
