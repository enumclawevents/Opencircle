"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

process.env.DB_PATH = ":memory:";
delete process.env.APP_VERSION;

const { initDB, all, run } = require("../db");
const catalog = require("../data/release-notes.json");
const { version } = require("../package.json");
const lockfile = require("../package-lock.json");
const { appVersion, publishCurrentRelease, readReleaseNotes, renderReleaseEntries } = require("../lib/release-notes");

test("API package and lockfile versions have matching release notes", () => {
  assert.equal(lockfile.version, version);
  assert.equal(lockfile.packages[""].version, version);
  assert.equal(appVersion, `v${version}`);
  assert.ok(Object.hasOwn(catalog.releases, version));
  assert.ok(Array.isArray(catalog.releases[version].changes));
  assert.ok(catalog.releases[version].changes.length > 0);
});

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
  catalog.releases["9.9.8"] = notes;
  try {
    await publishCurrentRelease();
    assert.deepEqual(await all("SELECT version FROM published_releases"), []);
    await run("INSERT INTO published_releases (version, date) VALUES ('9.9.8', '2099-01-01')");
    const missing = await readReleaseNotes();
    assert.equal(missing.latestVersion, undefined);
    assert.match(renderReleaseEntries(missing), /Release notes for the current version are unavailable/);
    assert.doesNotMatch(renderReleaseEntries(missing), /Latest release/);
    assert.match(renderReleaseEntries(missing), /May 5, 2026/);
  } finally {
    delete catalog.releases["9.9.8"];
    catalog.releases[version] = notes;
  }

  await Promise.all([publishCurrentRelease(), publishCurrentRelease()]);
  const published = await readReleaseNotes();
  assert.equal(published.releases[0].version, version);
  assert.equal(published.releases.length, 4);
  assert.equal(published.latestVersion, version);
  assert.equal(appVersion, `v${published.latestVersion}`);
  assert.match(renderReleaseEntries(published), /Latest release/);
  assert.ok(renderReleaseEntries(published).includes(`<time datetime="${published.releases[0].date}">`));

  const older = await readReleaseNotes({ page: "2" });
  assert.ok(older.releases[0].date < published.releases.at(-1).date);
  const fixed = await readReleaseNotes({ category: "fixed" });
  assert.ok(fixed.releases.length);
  assert.ok(fixed.releases.every(release => release.changes.every(change => change.category === "fixed")));
  assert.doesNotMatch(renderReleaseEntries(fixed), /Organizer venue access/);
  assert.match(renderReleaseEntries(await readReleaseNotes()), /Organizer venue access/);

  const security = { category: "security", title: "Fixture security improvement", description: "Fixture details." };
  const fixtureChanges = [
    { category: "new", title: "Fixture new feature", description: "Fixture details." },
    { category: "improved", title: "Fixture improvement one", description: "Fixture details." },
    { category: "improved", title: "Fixture improvement two", description: "Fixture details." },
    security,
  ];
  notes.changes.push(...fixtureChanges);
  try {
    for (const category of ["new", "improved", "fixed"]) {
      const filtered = await readReleaseNotes({ category });
      assert.ok(filtered.releases.length);
      assert.ok(filtered.releases.every(release => release.changes.every(change => change.category === category)));
      assert.doesNotMatch(renderReleaseEntries(filtered), /Fixture security improvement/);
    }
    const html = renderReleaseEntries(await readReleaseNotes());
    assert.match(html, /release-category--improved[^]*Fixture improvement one[^]*Fixture improvement two/);
    assert.match(html, /release-category--security[^]*Fixture security improvement/);
  } finally {
    notes.changes.splice(-fixtureChanges.length);
  }

  const original = await all("SELECT version, date FROM published_releases");
  process.env.APP_VERSION = "v9.9.7";
  delete require.cache[require.resolve("../lib/release-notes")];
  try {
    const reloaded = require("../lib/release-notes");
    assert.equal(reloaded.appVersion, `v${version}`);
    await reloaded.publishCurrentRelease();
    assert.equal((await reloaded.readReleaseNotes()).latestVersion, version);
  } finally {
    delete process.env.APP_VERSION;
    delete require.cache[require.resolve("../lib/release-notes")];
  }
  assert.deepEqual(await all("SELECT version, date FROM published_releases"), original);

  await run("INSERT INTO published_releases (version, date) VALUES ('9.9.9', '2099-01-01')");
  assert.equal((await readReleaseNotes()).latestVersion, version);
});
