"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { generateOccurrences } = require("../routes/events");

function occurrences(event, from, to) {
  return generateOccurrences(event, Date.parse(from), Date.parse(to));
}

function recurring(startDateTime, endDateTime, recurrenceRule, extra = {}) {
  return {
    startDateTime,
    endDateTime,
    hasRecurrence: 1,
    recurrenceRule: JSON.stringify(recurrenceRule),
    recurrenceStartDate: startDateTime.slice(0, 10),
    ...extra,
  };
}

test("weekly intervals and multiple weekdays retain their selected local dates", () => {
  const result = occurrences(recurring(
    "2026-01-04T18:00:00-08:00", "2026-01-04T20:00:00-08:00",
    { type: "weekly", interval: 2, byDay: ["MO", "WE"] },
  ), "2026-01-01T00:00:00-08:00", "2026-02-01T00:00:00-08:00");
  assert.deepEqual(result.map((item) => item.occurrenceDate), ["2026-01-05", "2026-01-07", "2026-01-19", "2026-01-21"]);
});

test("monthly day-of-month rules clamp 29th through 31st to shorter months", () => {
  const result = occurrences(recurring(
    "2026-01-31T18:00:00-08:00", "2026-01-31T20:00:00-08:00",
    { type: "monthly", interval: 1, mode: "monthday", byMonthday: 31 },
  ), "2026-01-01T00:00:00-08:00", "2026-04-01T00:00:00-07:00");
  assert.deepEqual(result.map((item) => item.occurrenceDate), ["2026-01-31", "2026-02-28", "2026-03-31"]);
});

test("monthly first and last weekday rules support multiple selected weekdays", () => {
  const first = occurrences(recurring(
    "2026-01-01T10:00:00-08:00", "2026-01-01T11:00:00-08:00",
    { type: "monthly", interval: 1, mode: "nthweekday", setPos: 1, byDay: ["MO", "WE"] },
  ), "2026-01-01T00:00:00-08:00", "2026-03-01T00:00:00-08:00");
  assert.deepEqual(first.map((item) => item.occurrenceDate), ["2026-01-05", "2026-01-07", "2026-02-02", "2026-02-04"]);

  const last = occurrences(recurring(
    "2026-01-01T10:00:00-08:00", "2026-01-01T11:00:00-08:00",
    { type: "monthly", interval: 1, mode: "nthweekday", setPos: -1, byDay: ["FR"] },
  ), "2026-01-01T00:00:00-08:00", "2026-03-01T00:00:00-08:00");
  assert.deepEqual(last.map((item) => item.occurrenceDate), ["2026-01-30", "2026-02-27"]);
});

test("annual, custom varying-time, and overnight occurrences retain paired start/end values", () => {
  const annual = occurrences(recurring(
    "2024-02-29T18:00:00-08:00", "2024-02-29T20:00:00-08:00",
    { type: "annual", interval: 1, byMonth: 2, byMonthday: 29 },
  ), "2025-01-01T00:00:00-08:00", "2027-01-01T00:00:00-08:00");
  assert.deepEqual(annual.map((item) => item.occurrenceDate), ["2025-02-28", "2026-02-28"]);

  const custom = occurrences(recurring(
    "2026-03-01T18:00:00-08:00", "2026-03-01T20:00:00-08:00",
    { type: "custom", items: [
      { date: "2026-03-03", start: "2026-03-03T18:00:00-08:00", end: "2026-03-03T20:00:00-08:00" },
      { date: "2026-03-10", start: "2026-03-10T23:00:00-07:00", end: "2026-03-11T01:00:00-07:00" },
    ] },
  ), "2026-03-01T00:00:00-08:00", "2026-03-20T00:00:00-07:00");
  assert.deepEqual(custom.map((item) => [item.startDateTime, item.endDateTime]), [
    ["2026-03-03T18:00:00-08:00", "2026-03-03T20:00:00-08:00"],
    ["2026-03-10T23:00:00-07:00", "2026-03-11T01:00:00-07:00"],
  ]);
});

test("spring and fall DST keep weekly wall-clock time and never duplicate a local date", () => {
  const spring = occurrences(recurring(
    "2026-03-01T10:00:00-08:00", "2026-03-01T12:00:00-08:00",
    { type: "weekly", interval: 1, byDay: ["SU"] },
  ), "2026-03-01T00:00:00-08:00", "2026-03-16T00:00:00-07:00");
  assert.deepEqual(spring.map((item) => item.startDateTime.slice(11)), ["10:00:00-08:00", "10:00:00-07:00", "10:00:00-07:00"]);

  const fall = occurrences(recurring(
    "2026-10-25T10:00:00-07:00", "2026-10-25T12:00:00-07:00",
    { type: "weekly", interval: 1, byDay: ["SU"] },
  ), "2026-10-25T00:00:00-07:00", "2026-11-09T00:00:00-08:00");
  assert.deepEqual(fall.map((item) => item.occurrenceDate), ["2026-10-25", "2026-11-01", "2026-11-08"]);
  assert.equal(new Set(fall.map((item) => item.occurrenceDate)).size, fall.length);
});
