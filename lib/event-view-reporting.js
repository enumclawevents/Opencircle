"use strict";

// Reporting bounds have millisecond precision. Truncate longer fractions
// before SQLite parses them so rounding cannot move a hit across a boundary.
// Keep the offset (if any) attached for SQLite's UTC conversion.
const viewedAt = `CASE WHEN substr(ev.viewedAt, 20, 1) = '.'
  AND substr(ev.viewedAt, 24, 1) BETWEEN '0' AND '9'
  THEN substr(ev.viewedAt, 1, 23) || ltrim(substr(ev.viewedAt, 24), '0123456789')
  ELSE ev.viewedAt END`;
const instant = `julianday(${viewedAt})`;
const withinPeriod = `${instant} >= julianday(?) AND ${instant} < julianday(?)`;

async function loadEventViewRows(all, { scopeSql, scopeParams, period, includeSources = false }) {
  const columns = new Set((await all("PRAGMA table_info(event_views)")).map(({ name }) => name));
  const sourcesAvailable = includeSources && columns.has("ref");
  const sourceSql = sourcesAvailable ? `, CASE
    WHEN ev.ref LIKE '[src:direct%' OR ev.ref = '__direct__' OR trim(COALESCE(ev.ref, '')) = '' THEN 'direct'
    WHEN ev.ref LIKE '[src:referral%' THEN 'referral'
    WHEN ev.ref LIKE '[src:internal%' THEN 'internal'
    ELSE 'other' END AS source` : "";
  // Pacific offsets and transitions fall on whole UTC hours. Aggregate hits
  // in SQLite before converting UTC buckets to local dates in the reports.
  const rows = await all(
    `SELECT ev.eventId, strftime('%Y-%m-%d %H:00:00', ${viewedAt}) AS utcTime, COUNT(*) AS count${sourceSql}
       FROM event_views ev
      WHERE ev.eventId IN (${scopeSql}) AND ${withinPeriod}
      GROUP BY ev.eventId, utcTime${sourcesAvailable ? ", source" : ""}`,
    [...scopeParams, period.start.toUTC().toISO(), period.end.toUTC().toISO()]
  );
  return { rows, sourcesAvailable };
}

async function loadEventViewTotals(all, { eventIds, period, previousStart, regionalCities = [] }) {
  const columns = new Set((await all("PRAGMA table_info(event_views)")).map(({ name }) => name));
  const uniqueAvailable = columns.has("ipHash");
  const start = period.start.toUTC().toISO();
  const end = period.end.toUTC().toISO();
  const hash = uniqueAvailable ? "ev.ipHash" : "NULL";
  const currentCount = "COUNT(CASE WHEN currentPeriod THEN 1 END)";
  const distinctCount = "COUNT(DISTINCT CASE WHEN currentPeriod THEN visitorHash END)";
  const uniqueCount = uniqueAvailable
    ? `CASE WHEN ${currentCount} = 0 OR ${distinctCount} > 0 THEN ${distinctCount} END`
    : "NULL";
  const measure = `${currentCount} AS views,
    COUNT(CASE WHEN NOT currentPeriod THEN 1 END) AS previousViews,
    ${uniqueCount} AS uniqueViews`;
  const rows = await all(
    `WITH hits AS (
       SELECT e.city, ${hash} AS visitorHash, ${instant} >= julianday(?) AS currentPeriod
         FROM event_views ev JOIN events e ON e.id = ev.eventId
        WHERE ev.eventId IN (SELECT value FROM json_each(?)) AND ${withinPeriod}
     )
     SELECT 'city' AS scope, city, ${measure} FROM hits GROUP BY city
     UNION ALL
     SELECT 'all', NULL, ${measure} FROM hits
     ${regionalCities.length ? `UNION ALL
     SELECT 'region', NULL, ${measure} FROM hits WHERE city IN (SELECT value FROM json_each(?))` : ""}`,
    [start, JSON.stringify(eventIds), previousStart?.toUTC().toISO() || start, end,
      ...(regionalCities.length ? [JSON.stringify(regionalCities)] : [])]
  );
  return { rows, uniqueAvailable };
}

module.exports = { loadEventViewRows, loadEventViewTotals };
