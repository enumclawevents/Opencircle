# Events API contract

`GET /events` is OpenCircle's canonical event collection endpoint. It is
community-agnostic: callers should always provide `city` rather than relying
on the legacy default of `Enumclaw`.

## Response shape

Successful requests, including zero-result searches, return HTTP `200`:

```json
{
  "data": [{ "id": 42, "title": "Example event" }],
  "meta": {
    "total": 1,
    "limit": 40,
    "offset": 0,
    "hasMore": false,
    "nextOffset": null
  }
}
```

`total` and pagination metadata apply after every supplied filter. `offset`
is zero-based; `nextOffset` is either the next usable offset or `null`.

Malformed collection parameters return HTTP `400` with the same top-level
shape plus an error message:

```json
{
  "data": [],
  "meta": { "total": 0, "limit": 0, "offset": 0, "hasMore": false, "nextOffset": null },
  "error": "Invalid query parameter: sort"
}
```

## Parameters

| Parameter | Notes |
| --- | --- |
| `city` | Community constraint. Use on all plugin requests. Case-insensitive exact match. |
| `category` or `cat` | Category display name or normalized slug. `Food & Drink` may be requested as `food-and-drink`. Unknown values return an empty collection. |
| `organizer` or `org` | Case-insensitive exact organizer match; URL encode spaces, apostrophes, and ampersands. Unknown values return an empty collection. |
| `venue` or `location` | Case-insensitive exact event location match. |
| `q` | Case-insensitive literal substring search of title and location. It composes with all filters. |
| `from`, `to` | ISO-8601 instants. Results overlap the inclusive interval: an event that began before `from` but ends during the range is included. |
| `status` | `upcoming` (default), `past`, `all`, or authenticated `archived`. Ongoing events are included by `upcoming`. |
| `windowDays` | `1`–`3650`; bounds the collection's lifecycle window. |
| `featured` | `1` limits results to active featured events. |
| `sort` | `soonest`, `latest`, `recent`, `trending`, or `id_desc`. Ties are deterministic by event ID. |
| `limit`, `offset` | `limit` is `1`–`100`; offset is zero-based. |
| `expand` | `1` (default) expands recurring events into occurrence records. `0` returns base event rows. |

Repeated array-style parameters, invalid numeric values, unsupported enum
values, invalid dates, impossible ranges, and overlong filter values return
HTTP `400`; they never silently fall back to an unfiltered collection.

## Plugin request examples

```text
# Upcoming events in one community
/events?city=Community%20A

# Category by display name and normalized slug
/events?city=Community%20A&category=Music
/events?city=Community%20A&category=food-and-drink

# Organizer, venue, search, and filters composed together
/events?city=Community%20A&organizer=Riley%27s%20Arts%20%26%20Co.
/events?city=Community%20A&venue=Community%20Hall
/events?city=Community%20A&q=harvest&category=Family%20Events

# Events occurring during a period, including overlapping multi-day events
/events?city=Community%20A&from=2026-10-01T00%3A00%3A00Z&to=2026-10-31T23%3A59%3A59Z

# Featured, past, and paged requests
/events?city=Community%20A&featured=1
/events?city=Community%20A&status=past&sort=latest
/events?city=Community%20A&category=music&limit=10&offset=10

# A valid zero-result request remains a 200 response
/events?city=Community%20A&category=not-a-real-category
```

Timestamps are stored and returned as ISO-8601 strings. Callers should send
offset-bearing ISO instants for `from`/`to`; date-only input is interpreted by
the JavaScript runtime as UTC and should be avoided where a local-day boundary
matters.

`expand=1` performs in-memory recurrence expansion from the already
community/category/organizer/venue-constrained rows. It does not issue a query
per event. Expanded recurring records include occurrence-specific start/end
times and `isOccurrence`; `expand=0` returns the base rows.

## `/events/past`

`GET /events/past` remains a compatibility archive endpoint with a separate
cached `{ data, meta: { page, limit, total, pages, hasPrev, hasNext } }`
response. It supports only city and one-based `page`, and is not a substitute
for the general `/events` filtering contract. Existing consumers should keep
using it until a separately planned deprecation and migration.
