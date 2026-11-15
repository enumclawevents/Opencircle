"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const sqlite3 = require("sqlite3");
const { DateTime } = require("luxon");
const { loadEventViewRows, loadEventViewTotals } = require("../lib/event-view-reporting");

function openDatabase(t) {
  const db = new sqlite3.Database(":memory:");
  t.after(() => new Promise((resolve) => db.close(resolve)));
  return (sql, params) => new Promise((resolve, reject) => {
    db.all(sql, params || [], (error, rows) => error ? reject(error) : resolve(rows));
  });
}

function pacificDay(date) {
  const start = DateTime.fromISO(date, { zone: "America/Los_Angeles" });
  return { start, end: start.plus({ days: 1 }) };
}

test("period hits agree across event and summary scopes across Pacific DST", async (t) => {
  const all = openDatabase(t);
  await all("CREATE TABLE events (id INTEGER PRIMARY KEY, city, owner, archived, viewCount, hasRecurrence)");
  await all("INSERT INTO events VALUES (1, 'Buckley', 10, 0, 90, 1), (2, 'Enumclaw', 10, 0, 30, 0), (3, 'Buckley', 11, 0, 80, 0), (4, 'Seattle', 10, 0, 20, 0), (5, 'Buckley', 10, 1, 20, 0), (6, 'Bonney Lake', 10, 0, 12, 0)");
  await all("CREATE TABLE event_views (eventId INTEGER, viewedAt TEXT, ipHash TEXT, ref TEXT, occurrenceDate TEXT)");
  await all("CREATE INDEX event_views_scope ON event_views(eventId, viewedAt)");
  const spring = pacificDay("2026-03-08");
  const fall = pacificDay("2026-11-01");
  assert.equal(spring.end.diff(spring.start, "hours").hours, 23);
  assert.equal(fall.end.diff(fall.start, "hours").hours, 25);
  const hits = [
    [1, "2026-03-08T07:59:59.9999Z", "early", null, null],
    [1, "2026-03-08 08:00:00", "shared", "__direct__", "2026-03-08"],
    [1, "2026-03-08T23:59:59.9999-07:00", "shared", "[src:internal]", "2026-03-15"],
    [1, "2026-03-09T07:00:00.000Z", "late", null, null],
    [2, "2026-03-08T09:00:00.500Z", "shared", "[src:referral]", null],
    [3, "2026-03-08T09:00:00Z", "other-owner", null, null],
    [4, "2026-03-08T09:00:00Z", "other-community", null, null],
    [5, "2026-03-08T09:00:00Z", "archived", null, null],
    [6, "2026-03-08T09:00:00Z", "shared", "[src:campaign]", null],
    [1, "2026-11-01T01:30:00-07:00", "fall", null, null],
    [1, "2026-11-01T01:30:00-08:00", "fall", null, null],
    [1, "2026-11-02T00:00:00-08:00", "late", null, null],
  ];
  for (const hit of hits) await all("INSERT INTO event_views VALUES (?, ?, ?, ?, ?)", hit);
  const scopeSql = "SELECT id FROM events WHERE owner = ? AND archived = 0 AND city IN (?, ?, ?)";
  const scopeParams = [10, "Buckley", "Enumclaw", "Bonney Lake"];
  const eventIds = (await all(scopeSql, scopeParams)).map(({ id }) => id);
  const { rows } = await loadEventViewTotals(all, {
    eventIds, period: spring, previousStart: spring.start.minus({ days: 1 }),
    regionalCities: ["Buckley", "Bonney Lake"],
  });
  assert.deepEqual(rows.find(({ scope }) => scope === "all"),
    { scope: "all", city: null, views: 4, previousViews: 1, uniqueViews: 1 });
  assert.equal(rows.filter(({ scope }) => scope === "city").reduce((sum, row) => sum + row.uniqueViews, 0), 3);
  assert.equal(rows.find(({ scope }) => scope === "region").uniqueViews, 1);

  const organizer = await loadEventViewRows(all, { scopeSql, scopeParams, period: spring, includeSources: true });
  const individual = await loadEventViewRows(all, {
    scopeSql: scopeSql + " AND id = ?", scopeParams: [...scopeParams, 1], period: spring, includeSources: true,
  });
  assert.equal(organizer.rows.reduce((sum, row) => sum + row.count, 0), 4);
  assert.deepEqual(individual.rows, organizer.rows.filter(({ eventId }) => eventId === 1));
  assert.deepEqual(individual.rows.map(({ source }) => source).sort(), ["direct", "internal"]);
  assert.equal(organizer.rows.find(({ eventId }) => eventId === 6).source, "other");
  assert.deepEqual(individual.rows.map((row) => DateTime.fromSQL(row.utcTime, { zone: "utc" })
    .setZone("America/Los_Angeles").toISODate()), ["2026-03-08", "2026-03-08"]);

  const repeatedHour = await loadEventViewRows(all, { scopeSql, scopeParams, period: fall });
  assert.deepEqual(repeatedHour.rows.map(({ utcTime }) => utcTime), ["2026-11-01 08:00:00", "2026-11-01 09:00:00"]);
  const fractional = await loadEventViewTotals(all, { eventIds: [2], period: {
    start: DateTime.fromISO("2026-03-08T09:00:00.500Z"), end: DateTime.fromISO("2026-03-08T09:00:00.501Z"),
  } });
  assert.equal(fractional.rows.find(({ scope }) => scope === "all").views, 1);

  assert.equal((await all("SELECT viewCount FROM events WHERE id = 1"))[0].viewCount, 90);
  assert.equal((await all("SELECT COUNT(*) AS count FROM event_views"))[0].count, hits.length);

  const plans = [];
  await loadEventViewTotals(async (sql, params) => {
    if (params) plans.push(...await all("EXPLAIN QUERY PLAN " + sql, params));
    return all(sql, params);
  }, { eventIds, period: spring, regionalCities: ["Buckley", "Bonney Lake"] });
  assert.ok(plans.some(({ detail }) => /SEARCH ev USING INDEX event_views_scope/.test(detail)));
});

test("healthy empty tracking returns zero and unavailable measurements stay distinct", async (t) => {
  const all = openDatabase(t);
  await all("CREATE TABLE events (id INTEGER PRIMARY KEY, city)");
  const period = pacificDay("2026-11-01");
  const totalsArgs = { eventIds: [], period };
  const rowArgs = { scopeSql: "SELECT id FROM events", scopeParams: [], period, includeSources: true };
  await assert.rejects(loadEventViewRows(all, rowArgs), /no such table/);
  await assert.rejects(loadEventViewTotals(all, totalsArgs), /no such table/);
  await all("CREATE TABLE event_views (eventId INTEGER, viewedAt TEXT)");
  assert.deepEqual(await loadEventViewRows(all, rowArgs), { rows: [], sourcesAvailable: false });
  const withoutHash = await loadEventViewTotals(all, totalsArgs);
  assert.equal(withoutHash.rows[0].views, 0);
  assert.equal(withoutHash.rows[0].uniqueViews, null);
  await all("ALTER TABLE event_views ADD COLUMN ipHash TEXT");
  await all("ALTER TABLE event_views ADD COLUMN ref TEXT");
  const empty = await loadEventViewTotals(all, totalsArgs);
  assert.deepEqual(empty.rows[0], { scope: "all", city: null, views: 0, previousViews: 0, uniqueViews: 0 });
  assert.deepEqual(await loadEventViewRows(all, rowArgs), { rows: [], sourcesAvailable: true });

  await all("INSERT INTO events VALUES (1, 'Enumclaw')");
  await all("INSERT INTO event_views (eventId, viewedAt) VALUES (1, '2026-11-01 07:00:00')");
  const noIdentifiers = await loadEventViewTotals(all, { eventIds: [1], period });
  assert.equal(noIdentifiers.rows.find(({ scope }) => scope === "all").views, 1);
  assert.equal(noIdentifiers.rows.find(({ scope }) => scope === "all").uniqueViews, null);
});
