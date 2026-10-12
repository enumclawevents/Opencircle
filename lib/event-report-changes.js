"use strict";

// The public report endpoint deliberately accepts only event fields that can
// be useful to an administrator. This prevents clients from storing arbitrary
// metadata while keeping the resulting before/after view compact.
const EVENT_REPORT_CHANGE_FIELDS = Object.freeze({
  title: "Title",
  startDateTime: "Start date and time",
  endDateTime: "End date and time",
  location: "Location",
  organizer: "Organizer",
  description: "Description",
  eventDetails: "Event details",
  goodToKnow: "Good to know",
  ticketUrl: "Ticket link",
  ticketLabel: "Ticket label",
  imageUrl: "Image",
  categories: "Categories",
});

const MAX_EVENT_REPORT_CHANGES = 12;
const MAX_EVENT_REPORT_CHANGE_VALUE_LENGTH = 3000;

function normalizeChangeValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") return { error: "Each changed value must be a string or null." };
  const trimmed = value.trim();
  if (trimmed.length > MAX_EVENT_REPORT_CHANGE_VALUE_LENGTH) {
    return { error: `Each changed value must be ${MAX_EVENT_REPORT_CHANGE_VALUE_LENGTH} characters or fewer.` };
  }
  return trimmed || null;
}

function normalizeEventReportChanges(value) {
  if (value === undefined || value === null) return { value: [] };
  if (!Array.isArray(value)) return { error: "Changes must be an array." };
  if (value.length > MAX_EVENT_REPORT_CHANGES) {
    return { error: `No more than ${MAX_EVENT_REPORT_CHANGES} changed fields may be included.` };
  }

  const changes = [];
  const seen = new Set();
  for (const change of value) {
    if (!change || typeof change !== "object" || Array.isArray(change)) {
      return { error: "Each change must include a field, before value, and after value." };
    }
    const field = String(change.field || "").trim();
    if (!Object.prototype.hasOwnProperty.call(EVENT_REPORT_CHANGE_FIELDS, field)) {
      return { error: "A changed field is not supported." };
    }
    if (seen.has(field)) return { error: "Each changed field may be included only once." };
    seen.add(field);
    if (!(Object.prototype.hasOwnProperty.call(change, "before") && Object.prototype.hasOwnProperty.call(change, "after"))) {
      return { error: "Each change must include before and after values." };
    }
    const before = normalizeChangeValue(change.before);
    const after = normalizeChangeValue(change.after);
    if (before && typeof before === "object" && before.error) return before;
    if (after && typeof after === "object" && after.error) return after;
    if (before === after) continue;
    changes.push({ field, before, after });
  }
  return { value: changes };
}

function parseEventReportChanges(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    const normalized = normalizeEventReportChanges(parsed);
    return normalized.error ? [] : normalized.value;
  } catch (_) {
    return [];
  }
}

function eventReportChangeLabel(field) {
  return EVENT_REPORT_CHANGE_FIELDS[field] || field;
}

function eventReportChangeValue(value) {
  const normalized = value === null || value === undefined ? "" : String(value).trim();
  return normalized || "Not provided";
}

module.exports = {
  eventReportChangeLabel,
  eventReportChangeValue,
  normalizeEventReportChanges,
  parseEventReportChanges,
};
