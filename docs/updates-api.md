# Updates API

Updates are community-scoped articles and announcements. Public endpoints expose only records with `status = published` and a non-null `publishedAt`.

## Collection

`GET /updates?city=Enumclaw`

`city` is required. Optional parameters are `category` (name or slug), `q`, `eventId`, `venueId`, `limit` (1–100), and zero-based `offset`.

The response follows the existing collection shape:

```json
{ "data": [{ "id": 1, "slug": "town-hall-update", "title": "Town Hall Update" }], "meta": { "total": 1, "limit": 20, "offset": 0, "hasMore": false, "nextOffset": null } }
```

## Detail

`GET /updates/:slug?city=Enumclaw`

City is required because update slugs are unique within a community, not globally. The response includes public article fields, related public IDs, SEO fields, and Article structured data. It never returns author account data, unpublished records, or internal publication controls.

## View tracking

`POST /updates/:id/view`

Only published records may be tracked. Tracking rejects likely bots and prefetches using the shared public-traffic protections and suppresses repeated matching visitor requests for 30 minutes.

## Sitemap

`GET /updates/sitemap.xml`

The sitemap contains published Updates only when `PUBLIC_UPDATES_CANONICAL_BASE_URL` is configured. With no configured canonical public host, it deliberately returns an empty sitemap to avoid inventing production URLs.
