# Event category landing-page API

OpenCircle event categories remain stored on each event as their existing display
names in `events.categories` (a JSON array). The API supplies the stable URL
contract; WordPress owns routes, presentation copy, canonicals, and other SEO
metadata.

## Requesting a community category page

Use the existing public event feed endpoint, scoped to one community:

```text
GET /events?city=Enumclaw&category=food-and-drink&status=upcoming&expand=1&limit=24&offset=0
```

`category` accepts either the stable slug or the existing display name. Slugs
are derived from the canonical category names, for example:

- `Food & Drink` → `food-and-drink`
- `Arts & Culture` → `arts-and-culture`
- `Classes & Workshops` → `classes-and-workshops`

Always send `city` for a community page. The API applies that city constraint
before category filtering, recurrence expansion, and pagination; it never
combines results from other communities.

## Category response context

When `category` is present and valid, the existing response shape gains
additive metadata:

```json
{
  "data": [],
  "meta": {
    "total": 0,
    "eventCount": 0,
    "limit": 24,
    "offset": 0,
    "hasMore": false,
    "nextOffset": null,
    "category": { "name": "Food & Drink", "slug": "food-and-drink" },
    "community": { "city": "Enumclaw" }
  }
}
```

`total` and `eventCount` describe the filtered feed items before pagination.
With `expand=1`, recurring events contribute their matching upcoming
occurrences, matching the existing event-feed behavior. With `expand=0`, the
count describes matching base events.

An empty result for a valid category is a `200` response with `data: []` and a
zero count. An unknown category identifier receives a `400` response with an
empty data array, so WordPress can return a not-found page rather than render
an unrelated event list.

Descriptions are not stored for event categories today. WordPress should keep
category landing-page descriptions and other SEO presentation metadata in its
own rendering layer until there is a demonstrated cross-client API need.
