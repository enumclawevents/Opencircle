# Public venue API (Phase 4A.1)

WordPress owns venue-page routing, canonical URLs, metadata, structured data,
and sitemap entries. The API supplies community-scoped public venue data and
recurrence-aware event results.

## Resolve a venue

```text
GET /venues/slug/:slug?city=Enumclaw
GET /venues/:idOrSlug?city=Enumclaw
```

`city` is optional on these established detail routes for backward
compatibility. New integrations should always provide it. If the slug or ID
does not belong to the requested city, the API returns `404` rather than
returning a similarly named venue from another community.

The public response includes the stable numeric `id`, `slug`, `name`, `city`,
description, image, address, website, phone, hours, categories, social links,
and gallery images when present. It does not include venue ownership or venue
traffic metrics.

## List venue events

```text
GET /venues/:idOrSlug/events?city=Enumclaw&limit=24&offset=0
```

`city` is required. The response is the existing `GET /events` response shape:

```json
{
  "data": ["recurrence-aware upcoming event items"],
  "meta": {
    "total": 42,
    "limit": 24,
    "offset": 0,
    "hasMore": true,
    "nextOffset": 24
  }
}
```

The endpoint always returns upcoming items and reuses the established event
filtering, recurrence expansion, date-range filters, sorting, and pagination
logic. It does not create occurrence records.

## Current matching limitation

Events do not yet have a `venueId`. Venue event lookup therefore matches the
venue's current name against `events.location`, within the requested city.
This can be ambiguous when two venues share an address or overlapping location
labels. A future Phase 4A.2 `events.venueId` relationship should replace this
text matching; it is intentionally not introduced in this phase.

## Slug policy

New venues receive a generated unique slug. Existing venue slugs are retained
when a venue name changes, so ordinary edits do not break public links. A
future intentional rename workflow should retain the old slug in a dedicated
alias table and issue a permanent redirect. This phase does not create aliases
or rewrite existing URLs.
