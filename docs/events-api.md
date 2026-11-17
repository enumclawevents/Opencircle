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
| `organizer` or `org` | Normalized exact match against primary or additional organizer names; URL encode spaces, apostrophes, and ampersands. Unknown values return an empty collection. |
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

## Organizer suggestions and public submissions

### Suggestions

Use `GET /events/organizer-suggestions?q=arts&city=Enumclaw`. No account
or credentials are required. Send the community's event city (for example,
`Enumclaw` or `Buckley`). The lookup is case-insensitive for city names and
scoped to that one city. A regional WordPress form should use the actual
event community for suggestions, even if it sends the submission to the
Plateau review queue.

Search starts at two characters after trimming and collapsing spaces. The
query is a literal substring. Exact matches rank first, followed by
prefix matches. The API returns up to eight deduplicated primary and
additional organizer names from available public event records in that
city, including past events. Each name retains its stored spelling.
Primary names use SQLite's built-in case folding, which is ASCII-only.

```json
{"data":[{"name":"Arts Council"},{"name":"Friends & Arts, Inc."}]}
```

A short search, unknown city, or no matches returns `200` with
`{"data":[]}`. Missing or blank `city`, repeated or malformed parameters,
or a trimmed parameter longer than 100 characters returns `400` with
`{"error":"..."}`. The anonymous endpoint permits up to 60 requests per
minute per client IP per API process. A throttled request returns `429`
with `Retry-After` in seconds. Debounce lookups, cancel stale requests,
and keep free-text entry usable when suggestions are unavailable.

### Submission

Send the required primary organizer as the `organizer` string in the
existing `POST /events/submit` payload. JSON callers can optionally include
`additionalOrganizers`, an ordered array of up to 10 nonempty strings,
each at most 200 characters. Omission and an empty array are accepted.
Additional names are trimmed at the edges. Internal spacing, spelling and
punctuation are retained. The API rejects invalid arrays and duplicates
of the primary or other additional names after case and whitespace
normalization with `400` and `{"ok":false,"error":"..."}`.

Suggestions provide display names only. Submit the selected or manually
entered names as strings without IDs. Existing event validation, submission
responses, spam protection, and pending approval continue to apply.

### Published event reads

Event lists and details keep the legacy primary `organizer` string and
include `organizers`, an ordered array such as:

```json
[
  {"name":"Arts Council","role":"primary"},
  {"name":"Friends & Arts, Inc.","role":"additional"}
]
```

Both `organizer` and `org` collection filters match the primary or an
additional organizer by normalized exact name. An organizer association
adds attribution without creating another event or granting account
permissions. Recurrence expansion still follows the collection's `expand`
parameter.
