# Event change feed API

`GET /events/changes` is OpenCircle's incremental synchronization feed. It is
public-safe and community scoped: it returns event identity and change state,
not event descriptions, private users, moderation information, or analytics.

Consumers should first perform a normal city-scoped bootstrap with `GET
/events?city=...`, retain the highest received cursor, then poll this feed.

```text
GET /events/changes?city=Enumclaw&after=0&limit=50
```

## Parameters

| Parameter | Required | Notes |
| --- | --- | --- |
| `city` | Yes | Case-insensitive exact community scope. A feed never combines communities. |
| `after` | No | Non-negative numeric cursor; defaults to `0`. Return only records with a larger cursor. |
| `limit` | No | `1`–`100`; defaults to `50`. |

## Response

```json
{
  "data": [
    {
      "cursor": 102,
      "eventId": 42,
      "slug": "harvest-festival",
      "revision": 4,
      "changeType": "updated",
      "occurredAt": "2026-10-18 19:00:00",
      "lifecycleState": "scheduled",
      "availability": "available"
    }
  ],
  "meta": {
    "city": "Enumclaw",
    "cursor": 102,
    "nextCursor": null,
    "hasMore": false
  }
}
```

`changeType` is one of `created`, `updated`, `lifecycle`, `archived`,
`restored`, or `deleted`. Deleted records are tombstones: `slug` is `null` and
`availability` is `deleted`. Archived records remain identifiable with
`availability: "archived"`, allowing consumers to remove or noindex pages.

The feed is append-only and ordered by globally monotonic `cursor`. A consumer
must advance its stored cursor only after it has processed every item in the
returned page. `nextCursor` is non-null only when another page is available.

Existing public event endpoints are unchanged. The event detail lifecycle
summary now adds explicit lifecycle `state`, `revision`, `updatedAt`, `reason`,
and `replacementEventId` fields alongside its existing date-derived `status`.
