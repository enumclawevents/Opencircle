"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

const source = fs.readFileSync(path.join(__dirname, "..", "routes", "admin.js"), "utf8");

test("event form groups the existing controls without changing their bindings", () => {
  for (const heading of ["Event basics", "Date &amp; time", "Location &amp; organizer", "Media &amp; ticketing", "Advanced settings"]) {
    assert.match(source, new RegExp(heading));
  }

  // These names are consumed directly by the existing event-save route. The
  // layout can move them, but must never replace them with a parallel payload.
  for (const name of [
    "city", "eventTypeChoice", "title", "description", "categories",
    "eventDetails", "goodToKnow", "startDateTime", "endDateTime",
    "hasRecurrence", "recurrenceType", "recurrenceUntilDate",
    "recurrenceDatesJson", "imageFile", "imageUrl", "ticketLabel",
    "ticketUrl", "location", "organizer", "seoTitle", "metaDescription",
    "focusKeyphrase", "imageAlt", "featured", "eddiesPick", "forceDuplicateSave",
  ]) {
    assert.match(source, new RegExp(`name="${name}"`));
  }

  assert.match(source, /id="recurrencePreview"/);
  assert.match(source, /id="recurrenceIntro"/);
  assert.match(source, /id="quickAddUrl"/);
  assert.match(source, /id="quickAddFetch"/);
  assert.match(source, /id="imageFileInput"/);
  assert.match(source, /id="imageFileName"/);
  assert.ok(!source.includes('form[action="/admin/events"]{ padding-bottom:calc(88px'));
  assert.match(source, /event-form-savebar\{ position:static/);
  assert.match(source, /event-form-advanced\[open\] > summary svg/);
});

test("event editor keeps lifecycle actions in a separate, accessible status section", () => {
  for (const label of ["Event status", "Cancel event", "Postpone event", "Reschedule event", "Restore to scheduled"]) {
    assert.match(source, new RegExp(label));
  }
  assert.match(source, /id="eventLifecycleFeedback" role="status" aria-live="polite"/);
  assert.match(source, /name="lifecycleAction"/);
  assert.match(source, /confirmRecurringLifecycle/);
  assert.match(source, /This action affects the entire recurring event series/);
});
