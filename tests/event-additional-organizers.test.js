"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

test("additional organizers migrate and follow the event lifecycle atomically", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "oc-additional-organizers-"));
  process.env.DB_PATH = path.join(dir, "events.db");
  const { db, initDB, run, get, all } = require("../db");
  const {
    createEventWithChange, updateEventWithChange, deleteEventWithChange, readAdditionalOrganizers,
  } = require("../lib/event-lifecycle");
  t.after(async () => {
    await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  });

  await run(`CREATE TABLE events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT, title TEXT, organizer TEXT, startDateTime TEXT
  )`);
  await run("INSERT INTO events VALUES (6, 'Enumclaw', 'Existing event', 'Arts & Music, Inc.', '2027-06-01')");
  await initDB();
  await initDB();
  assert.deepEqual(await readAdditionalOrganizers(6), []);
  assert.equal((await get("SELECT organizer FROM events WHERE id = 6")).organizer, "Arts & Music, Inc.");
  assert.equal((await get("PRAGMA foreign_keys")).foreign_keys, 0);
  assert.deepEqual((await all("PRAGMA foreign_key_list(event_additional_organizers)"))
    .map(({ table, from, to, on_delete }) => [table, from, to, on_delete]), [
    ["events", "eventId", "id", "CASCADE"],
  ]);
  assert.deepEqual((await all("PRAGMA index_info(idx_event_additional_organizers_name)"))
    .map(({ name }) => name), ["nameKey", "eventId"]);

  const fields = [["city", "Enumclaw"], ["title", "New event"], ["organizer", "Primary  Group"], ["startDateTime", "2027-06-02"]];
  const { event: single } = await createEventWithChange({ fields });
  assert.deepEqual(await readAdditionalOrganizers(single.id), []);
  for (const names of [null, "Organizer", [1], [" "], ["a\0b"], ["x".repeat(201)], Array(11).fill("x")]) {
    await assert.rejects(createEventWithChange({ fields, additionalOrganizers: names }), TypeError);
  }
  assert.equal((await get("SELECT COUNT(*) AS count FROM events")).count, 2);

  const { event } = await createEventWithChange({ fields, additionalOrganizers: ["Arts & Music, Inc.", "Second  Group"] });
  const eventId = event.id;
  const update = (additionalOrganizers, options = {}) => updateEventWithChange({
    eventId, fields: [], additionalOrganizers, ...options,
  });
  const names = () => readAdditionalOrganizers(eventId);
  assert.equal(event.revision, 1);
  assert.deepEqual(await names(), ["Arts & Music, Inc.", "Second  Group"]);
  assert.equal((await get("SELECT nameKey FROM event_additional_organizers WHERE eventId = ? AND position = 1", [eventId])).nameKey, "second group");

  await assert.rejects(update([" Arts & Music, Inc.", "arts & music, inc. "]), /must be unique/);
  await assert.rejects(update(["  PRIMARY\tgroup"]), /must be unique/);
  await assert.rejects(update(undefined, { fields: [["organizer", "second group"]] }), /must be unique/);
  assert.deepEqual(await names(), ["Arts & Music, Inc.", "Second  Group"]);
  assert.equal((await get("SELECT organizer FROM events WHERE id = ?", [eventId])).organizer, "Primary  Group");
  assert.equal((await update(["Arts & Music, Inc.", "Second  Group"])).changed, false);

  assert.equal((await update(["Second  Group"])).event.revision, 2);
  assert.deepEqual(await names(), ["Second  Group"]);
  assert.equal((await update(["Second  Group", "Cultural Council"])).event.revision, 3);
  assert.equal((await update(undefined, { fields: [["title", "Edited event"]] })).event.revision, 4);
  assert.deepEqual(await names(), ["Second  Group", "Cultural Council"]);

  await run(`CREATE TRIGGER fail_organizer_write BEFORE INSERT ON event_additional_organizers
    WHEN NEW.nameKey = 'blocked'
    BEGIN SELECT RAISE(ABORT, 'fixture organizer failure'); END`);
  await assert.rejects(createEventWithChange({ fields, additionalOrganizers: ["Blocked"] }), /fixture organizer failure/);
  assert.equal((await get("SELECT COUNT(*) AS count FROM events")).count, 3);
  await run("INSERT INTO event_unpublished_changes (eventId, baseRevision, editToken, city, payloadJson) VALUES (?, 4, 'token', 'Enumclaw', '{}')", [eventId]);
  const publication = { baseRevision: 4, editToken: "token", liveCity: "Enumclaw", liveOrganizer: "Primary  Group" };
  assert.deepEqual(await update([], { publication: { ...publication, editToken: "stale" } }), { conflict: true });
  assert.deepEqual(await update([], { publication: { ...publication, baseRevision: 3 } }), { conflict: true });
  await assert.rejects(update(["Blocked"], { publication, fields: [["title", "Failed edit"]] }), /fixture organizer failure/);
  assert.deepEqual(await names(), ["Second  Group", "Cultural Council"]);
  assert.deepEqual(await get("SELECT title, revision FROM events WHERE id = ?", [eventId]), { title: "Edited event", revision: 4 });
  assert.equal((await get("SELECT editToken FROM event_unpublished_changes WHERE eventId = ?", [eventId])).editToken, "token");

  const results = await Promise.all([update(["First"], { publication }), update(["Second"], { publication })]);
  assert.equal(results.filter((result) => result.changed).length, 1);
  assert.equal(results.filter((result) => result.conflict).length, 1);
  assert.deepEqual(await names(), [results[0].changed ? "First" : "Second"]);
  assert.equal(await get("SELECT editToken FROM event_unpublished_changes WHERE eventId = ?", [eventId]), undefined);
  assert.equal((await update(undefined, { changeType: "archived", fields: [["archived", 1], ["lifecycleState", "archived"]] })).event.revision, 6);
  assert.equal((await update(undefined, { changeType: "restored", fields: [["archived", 0], ["lifecycleState", "scheduled"]] })).event.revision, 7);
  assert.equal((await names()).length, 1);
  assert.equal((await update([])).event.revision, 8);
  assert.deepEqual(await names(), []);
  assert.equal((await update([])).changed, false);
  assert.equal((await update(["Final organizer"])).event.revision, 9);
  assert.equal((await deleteEventWithChange({ eventId })).event.revision, 10);
  assert.deepEqual(await names(), []);
  assert.deepEqual(await all("SELECT revision, changeType FROM event_changes WHERE eventId = ? ORDER BY revision", [eventId]),
    ["created", "updated", "updated", "updated", "updated", "archived", "restored", "updated", "updated", "deleted"]
      .map((changeType, index) => ({ revision: index + 1, changeType })));

  const insert = "INSERT INTO event_additional_organizers VALUES (?, ?, ?, ?)";
  await assert.rejects(run(insert, [999, "Orphan", "orphan", 0]), /requires an existing event/);
  await run(insert, [6, "Legacy co-organizer", "legacy co-organizer", 0]);
  await assert.rejects(run(insert, [6, "LEGACY co-organizer", "legacy co-organizer", 1]), /UNIQUE constraint/);
  await assert.rejects(run("UPDATE event_additional_organizers SET eventId = 999 WHERE eventId = 6"), /requires an existing event/);
  await assert.rejects(run("UPDATE events SET id = 999 WHERE id = 6"), /Cannot change an event ID/);
  await run("DELETE FROM events WHERE id = 6");
  assert.deepEqual(await readAdditionalOrganizers(6), []);

  await run("PRAGMA foreign_keys = ON");
  assert.equal((await get("PRAGMA foreign_keys")).foreign_keys, 1);
  await run(insert, [single.id, "Cascade", "cascade", 0]);
  await run("DELETE FROM events WHERE id = ?", [single.id]);
  assert.deepEqual(await readAdditionalOrganizers(single.id), []);
  assert.deepEqual(await all("PRAGMA foreign_key_check"), []);
  assert.deepEqual(await get("PRAGMA integrity_check"), { integrity_check: "ok" });
});
