# Event lifecycle design

Phase 2 implements the additive lifecycle and change-log foundation described
here. It does not change WordPress, recurrence expansion, or existing stable
event IDs/slugs.

## Phase 2 implementation note

The implemented schema uses `lifecycleState TEXT NOT NULL DEFAULT
'scheduled'` rather than a nullable state. This is a deliberate compatible
variation from the original proposal: legacy rows are explicitly scheduled by
the additive migration, avoiding per-request inference while preserving their
existing public behavior. `event_changes` is now append-only and records
`created`, `updated`, `lifecycle`, `archived`, `restored`, and `deleted`
changes. A hard deletion produces a tombstone change record; it does not leave
event content in the change feed.

## Goals

- Make the published state of an event explicit rather than inferred only from
  its dates and archive flag.
- Give consumers a durable way to detect an event change.
- Support reviewed cancellation, postponement, and rescheduling without
  changing stable event IDs or slugs.
- Preserve the current recurrence model: one base event row, bounded generated
  occurrences, and no occurrence rows created for ordinary recurrence.

## Implemented additive model

The following additive `events` columns are created by the existing SQLite
startup migration:

| Column | Purpose |
| --- | --- |
| `lifecycleState` | `scheduled`, `cancelled`, `postponed`, `rescheduled`, or `archived`; it defaults to `scheduled`. |
| `lifecycleReason` | Optional reviewer-authored public-safe explanation. |
| `replacementEventId` | Optional stable ID of the rescheduled/replacement event. |
| `revision` | Integer, starts at `1` for newly changed records and increments atomically on public-data changes. |
| `publishedAt` | First time a record becomes public. |
| `lifecycleUpdatedAt` | Timestamp of the latest lifecycle transition. |

Do not overload `endDateTime`, `expireDate`, `recurrenceUntilDate`, or
`archived` for lifecycle meanings. `recurrenceUntilDate` remains the only
schedule cutoff; `endDateTime` remains the occurrence duration template.

For a future exceptional recurring-occurrence need, use a separate additive
`event_occurrence_overrides` table only after a real workflow requires it:

```
eventId, occurrenceDate, state, replacementStartDateTime,
replacementEndDateTime, note, revision, createdAt, updatedAt
```

Its unique key should be `(eventId, occurrenceDate)`. It should represent
only exceptions, never materialize every normal recurrence occurrence.

## Change log and consumer synchronization

The startup migration also creates an append-only `event_changes` table:

```
id, eventId, city, revision, changeType, occurredAt, actorUserId,
publicPayloadVersion
```

`id` is a monotonic cursor. Every public event mutation and lifecycle change
should transactionally increment `events.revision` and append one change row.
No analytics-only write (view, ticket click, going/interested) should create a
publication change.

Later consumers can use a city-scoped cursor endpoint such as:

```
GET /events/changes?city=Enumclaw&after=123&limit=100
```

The response should contain changed stable IDs/slugs, revision, change type,
and cursor metadata. Consumers then fetch current event detail when needed.
Archived and cancelled changes must remain visible in this feed so clients can
remove or update previously rendered content.

## Backward-compatible public contract

Keep current event fields and date-derived `status` unchanged during the first
rollout. Add, rather than replace, an object like:

```json
{
  "lifecycle": {
    "state": "scheduled",
    "revision": 7,
    "updatedAt": "2026-10-18T19:00:00Z",
    "reason": null,
    "replacement": null
  }
}
```

Existing clients continue to use `status`, `eventEnded`, and lifecycle date
summary fields. WordPress can opt into explicit lifecycle rendering only after
it supports the additive fields.

## Deployment and migration sequence

1. Deploy this compatible code. The existing startup migration adds columns,
   indexes, and `event_changes` with no destructive backfill.
2. Existing records receive the database defaults (`scheduled`, revision `1`)
   and retain their present date-derived behavior.
3. New public-content writes, approvals, archive actions, restores, lifecycle
   transitions, and deletions append a transactional change record. Public
   reports remain moderator input, not automatic state changes.
4. Consumers may adopt the additive detail fields and change feed at their own
   pace; existing response fields remain available.
5. Design occurrence overrides only if a real recurring-event exception
   workflow requires them.

## Guardrails

- Preserve numeric ID and slug through cancellation/rescheduling.
- Require authorized city-scoped staff to transition state.
- Keep public reasons intentionally safe; retain internal notes separately.
- Never infer cancellation from a public report.
- Do not emit a change merely because analytics counters changed.
- Ensure all transition and change-log writes share one database transaction.
- Retain archived/tombstone changes for at least the longest supported consumer
  polling interval plus a documented recovery period.
