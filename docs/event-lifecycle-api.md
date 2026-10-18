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

`recurrenceUntilDate` is the only recurrence termination authority.
`endDateTime` is the per-occurrence duration template. If a legacy recurring
row has an invalid or implausibly long template duration (more than fourteen
days), the API continues to generate occurrences according to its recurrence
rule but omits each generated occurrence end time rather than inventing a
months-long end date or silently stopping the schedule. Normal multi-day and
overnight templates of fourteen days or less are unchanged. Correcting a
legacy row requires an editorial update that supplies the actual per-occurrence
`endDateTime` and, if applicable, a separate `recurrenceUntilDate`.

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

`data.lifecycle` also includes an additive human-readable `label` and public
`notice`. Cancelled, postponed, and rescheduled events therefore remain
available to existing consumers while providing a clear attendee-facing state.
Event JSON-LD now emits `EventCancelled` or `EventPostponed` when applicable;
rescheduled events retain `EventScheduled` with their updated date/time.

## Cancellations, postponements, rescheduling, and duplicates

The event schema has additive lifecycle support. Every event has a
`lifecycleState` (`scheduled`, `cancelled`, `postponed`, `rescheduled`, or
`archived`), a monotonically increasing `revision`, and lifecycle update
metadata. Public detail responses expose these values through
`data.lifecycle`; the date-derived `status` remains unchanged for backwards
compatibility. Public reports still require moderator review and do not change
an event automatically.

Lifecycle changes are explicit editorial actions. A replacement event may be
recorded for rescheduling through `replacementEventId`; a public consumer
should fetch that replacement separately and must not infer it from title or
date similarity. Incremental consumers can use the community-scoped
[`event change feed`](./event-changes-api.md) to observe lifecycle changes,
archives, restorations, and deletion tombstones.

## Admin lifecycle workflow

When an authorized user edits an event, the **Event status** section offers
only transitions allowed from its current state. Cancellation and postponement
ask for confirmation. Rescheduling sends the user to the existing date/time
fields, validates the updated range through the normal event save path, and
records the rescheduled state in the same lifecycle revision. For recurring
events the editor explicitly confirms that the action applies to the entire
series; individual-occurrence lifecycle overrides are not supported.

Likewise, the API prevents slug collisions with `ensureUniqueSlug` but does
not merge or automatically flag similar event records. That is deliberate:
title/date/location similarity is not reliable enough for safe identity
changes. Lifecycle data is additive and requires no migration of existing
event records; legacy rows read as `scheduled` until explicitly changed.
