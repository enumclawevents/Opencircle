"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { generateOccurrences } = require("../routes/events");

function expand(template, from, to) {
  return generateOccurrences(template, Date.parse(from), Date.parse(to));
}

test("editor preview engine keeps occurrence duration separate from repeat-until", () => {
  const occurrences = expand({
    startDateTime: "2026-10-25T19:00:00-07:00",
    endDateTime: "2026-10-25T21:00:00-07:00",
    hasRecurrence: 1,
    recurrenceRule: JSON.stringify({ type: "weekly", interval: 1, byDay: ["SU"] }),
    recurrenceStartDate: "2026-10-25",
    recurrenceUntilDate: "2026-11-08",
  }, "2026-10-24T00:00:00-07:00", "2026-11-20T00:00:00-08:00");

  assert.deepEqual(occurrences.map((item) => item.occurrenceDate), ["2026-10-25", "2026-11-01", "2026-11-08"]);
  assert.deepEqual(occurrences.map((item) => item.startDateTime.slice(11)), ["19:00:00-07:00", "19:00:00-08:00", "19:00:00-08:00"]);
  assert.deepEqual(occurrences.map((item) => item.endDateTime.slice(11)), ["21:00:00-07:00", "21:00:00-08:00", "21:00:00-08:00"]);
});

test("editor preview engine leaves an ambiguous legacy end time unknown without ending the schedule", () => {
  const occurrences = expand({
    startDateTime: "2026-02-01T16:00:00-08:00",
    endDateTime: "2027-09-17T18:00:00-07:00",
    hasRecurrence: 1,
    recurrenceRule: JSON.stringify({ type: "weekly", interval: 1, byDay: ["SU"] }),
    recurrenceStartDate: "2026-02-01",
    recurrenceUntilDate: null,
  }, "2026-10-18T00:00:00-07:00", "2026-11-02T00:00:00-08:00");

  assert.deepEqual(occurrences.map((item) => item.occurrenceDate), ["2026-10-18", "2026-10-25", "2026-11-01"]);
  assert.ok(occurrences.every((item) => item.endDateTime === ""));
});
