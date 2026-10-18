"use strict";

// Listing payloads used by public entity pages should not reveal dashboard
// ownership, moderation, or engagement data. Keep this intentionally
// allowlisted so newly added event columns remain private by default.
const PUBLIC_EVENT_LIST_FIELDS = Object.freeze([
  "id",
  "slug",
  "city",
  "title",
  "description",
  "eventDetails",
  "goodToKnow",
  "startDateTime",
  "endDateTime",
  "baseStartDateTime",
  "occurrenceDate",
  "occurrenceLabel",
  "isOccurrence",
  "instanceId",
  "hasOccurrences",
  "hasRecurrence",
  "recurrenceType",
  "recurrenceStartDate",
  "recurrenceUntilDate",
  "multiDaySchedule",
  "location",
  "organizer",
  "host",
  "imageUrl",
  "imageAlt",
  "categories",
  "tags",
  "ticketUrl",
  "ticketLabel",
  "eventLink",
  "featured",
  "isFeatured",
  "eddiesPick",
  "status",
  "eventEnded",
  "statusLabel",
  "lifecycleState",
  "revision",
  "lifecycleUpdatedAt",
  "replacementEventId",
]);

function toPublicEventListItem(item) {
  const out = {};
  for (const field of PUBLIC_EVENT_LIST_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(item || {}, field)) {
      out[field] = item[field];
    }
  }
  return out;
}

module.exports = { PUBLIC_EVENT_LIST_FIELDS, toPublicEventListItem };
