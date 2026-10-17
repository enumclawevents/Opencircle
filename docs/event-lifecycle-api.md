# Event lifecycle and SEO data

## Current architecture

`events` is the durable source record. Its numeric `id` is the stable internal
identity and its globally unique `slug` is the stable public identifier. Event
rows are not deleted when they expire. The scheduled archive job soft-archives
expired rows after the configured retention period (120 days by default),
retaining the row, its id, and its slug.

One-time events use `startDateTime` and `endDateTime`. Recurring events remain
one database row and are expanded only for the requested bounded window. The
supported recurrence rule types are `weekly`, `monthly`, `annual` (also read
as `yearly` for compatibility), and explicit `custom` dates. Generated
occurrences preserve the local wall-clock time in `America/Los_Angeles` while
selecting the correct daylight-saving offset for each date. There is no
occurrence table and no unbounded occurrence generation.

The public feed continues to use `status=upcoming|past|all`; archived records
require an authorized admin/developer request using `status=archived` and are
served with `X-Robots-Tag: noindex, nofollow`.

## WordPress event-detail contract

Request an event by its stable slug:

```text
GET /events/{slug}
```

The existing event fields remain unchanged. The additive `data.lifecycle`
object provides the stable SEO-facing lifecycle summary:

```json
{
  "stableId": 42,
  "slug": "annual-harvest-festival",
  "status": "upcoming",
  "isRecurring": true,
  "recurrenceType": "annual",
  "originalStartDateTime": "2025-10-18T10:00:00-07:00",
  "originalEndDateTime": "2025-10-18T16:00:00-07:00",
  "nextUpcomingOccurrence": {
    "occurrenceDate": "2026-10-18",
    "startDateTime": "2026-10-18T10:00:00-07:00",
    "endDateTime": "2026-10-18T16:00:00-07:00",
    "label": "Oct 18, 2026"
  },
  "lastCompletedOccurrence": null,
  "community": { "city": "Enumclaw" },
  "venue": { "name": "Enumclaw Expo Center" },
  "organizer": { "name": "OpenCircle" }
}
```

The summary looks back at most ten years and ahead at most 370 days. WordPress
can use it to render dates and make its own indexing/canonical decisions; the
API does not prescribe those decisions.

## Cancellations, postponements, rescheduling, and duplicates

The current event schema has no published cancellation, postponement, or
reschedule state. Public `cancelled` reports are stored separately in
`event_reports` for moderator review and intentionally do not alter an event
automatically. Consequently WordPress must not infer a cancellation from a
report, and no cancellation or postponement flag is currently exposed in the
public event contract.

Likewise, the API prevents slug collisions with `ensureUniqueSlug` but does
not merge or automatically flag similar event records. That is deliberate:
title/date/location similarity is not reliable enough for safe SEO identity
changes. No migration is required for this phase. A future editorial lifecycle
workflow should introduce explicit, reviewed status and replacement fields
before WordPress renders cancellation, postponement, or rescheduling states.
