# Nearby Communities API foundation

## Baseline and activation decisions

Implemented from GitHub main `8eb6979a3757a4cd9ad8e972c784f3163254966a` in the
isolated `codex/publication-directory` checkout. GitHub revision is not proof of
Render's running revision. The primary API folder has unrelated mixed local work
and was not used as the implementation baseline.

The supplied Phase 1 audit request was available, but its completed findings were
not present in the inspected source/attachments. This phase therefore confirmed
its relevant facts through targeted source inspection: geographic cities are not
publication identities, global SEO URLs are not per-publication routing, and the
upcoming feed can include cancelled records unless explicitly filtered.

The reviewed catalog now explicitly approves these Nearby Communities participants:

| Publication ID | Name | Website and calendar | Canonical cities |
| --- | --- | --- | --- |
| `enumclaw-events` | EnumclawEvents | `https://enumclawevents.org/`, `/events/` | Enumclaw |
| `plateau-events` | PlateauEvents | `https://plateauevents.org/`, `/events/` | Buckley, Carbonado, South Prairie, Wilkeson |

Both entries are enabled and opted in. Their event routes use `/events/`, the
existing `slug-or-id` identifier, and no trailing slash. Participation and routing
are explicit approvals, never inferred from website connections, credentials,
request headers or city names. Unmapped cities retain null source fields.
Disabled or opted-out entries remain excluded. No database migration is involved.

## Catalog configuration

Example only; example.test is not a production destination or participation grant:

```json
{
  "schemaVersion": 1,
  "approvedHosts": ["community.example.test"],
  "publications": [{
    "id": "community-publication",
    "name": "Example Community Publication",
    "websiteUrl": "https://community.example.test/",
    "calendarUrl": "https://community.example.test/events/",
    "cities": ["Example City"],
    "eventRoute": {
      "pathPrefix": "/events/",
      "identifier": "slug-or-id",
      "trailingSlash": false
    },
    "enabled": true,
    "nearbyCommunities": true
  }],
  "canonicalCityPublications": [{
    "city": "Example City",
    "publicationId": "community-publication"
  }]
}
```

IDs are explicit stable lowercase identifiers, not generated city slugs or account
IDs. Flags must be booleans. A publication can cover multiple geographic cities.
Coverage by itself does not establish canonical routing: the separate mapping
must name exactly one configured publication that covers that city. Multiple
coverage candidates are allowed only with one explicit canonical assignment;
there is no first-match or inferred ownership fallback.

Validation rejects duplicate publication IDs, host entries, case-equivalent city
coverage and duplicate city assignments, missing publications, out-of-coverage
assignments, unknown fields, invalid flags, unapproved hosts, HTTP, credentials in
URLs, non-default ports, publication-level queries/fragments, and unsafe dynamic/traversal routes.
Website URLs are HTTPS origins with a root path. Calendar and event routes must
stay on that exact approved origin. Event routing supports only a fixed safe path
prefix plus the existing encoded slug-or-ID convention and an explicit trailing
slash policy. It does not accept arbitrary templates, query routing, ticket URLs
or request-dependent hosts. Limits are 100 publications/hosts and 100 cities per
publication. Keep display names, host approvals and city spellings explicit.

Configuration is loaded once per API process. Changes require a reviewed release
and process restart through the existing deployment workflow; this task does not
deploy anything. Tests validate invalid configurations and regional mappings.
A malformed bundled catalog logs a fixed diagnostic, makes directory reads fail
with 503, and leaves existing event services available with null source fields.

## Public directory

```http
GET /publications
```

No login, managed connection or signing credentials are required. The trailing
slash variant also works. No administrative route is made public.

Response:

```json
{
  "data": [{
    "id": "community-publication",
    "name": "Example Community Publication",
    "websiteUrl": "https://community.example.test/",
    "calendarUrl": "https://community.example.test/events/",
    "cities": ["Example City"]
  }],
  "meta": {
    "schemaVersion": 1,
    "total": 1,
    "revision": "<opaque catalog revision>"
  }
}
```

Only enabled AND explicitly opted-in publications appear. Internal routing rules,
flags, credential/installation IDs, account data and audit records are not
serialized. The public result is allowlisted and does not read the managed
connection registry. This endpoint lists participating publications; it does not
track a visitor's location or calculate geographic distance.

Headers include `Cache-Control: public, max-age=60` and an opaque ETag. Normal
conditional requests can return 304. An empty approved catalog returns 200 with
`data: []` and `meta.total: 0`. Invalid catalog configuration returns 503 with
`{"data":[],"error":"Publication directory unavailable"}` and no-store.

## Geographic areas (additive directory extension)

`GET /publications` also returns `areas`. Existing `data` publication records and
`meta.schemaVersion: 1` / `meta.total` (publication count) are unchanged. No
credentials are required. This extension does not imply production activation.

Sanitized example (the ID is illustrative; always use the returned opaque ID):

```json
{
  "data": [{
    "id": "plateau-events",
    "name": "PlateauEvents",
    "websiteUrl": "https://plateauevents.org/",
    "calendarUrl": "https://plateauevents.org/events/",
    "cities": ["Buckley", "Carbonado", "South Prairie", "Wilkeson"]
  }],
  "areas": [{
    "id": "city-0123456789abcdef01234567",
    "name": "Buckley",
    "city": "Buckley",
    "publicationId": "plateau-events",
    "calendarUrl": null
  }],
  "meta": {"schemaVersion": 1, "total": 1, "revision": "<opaque revision>"}
}
```

Each area comes from one explicit `canonicalCityPublications` mapping. Only
mappings to enabled, opted-in publications appear. Coverage without a canonical
mapping produces no area. Missing, duplicate/case-equivalent, or out-of-coverage
canonical assignments remain configuration errors. Four Plateau cities remain
four discovery areas pointing to one publication, not four publications.

Area IDs are `city-` plus the first 24 lowercase hex characters of SHA-256 of the
trimmed, lowercase mapping city. Treat them as opaque stable selection keys; they
do not change with display name, publication assignment, or calendar URL. A city
rename changes its key. `city` preserves the exact configured event-filter value;
`name` defaults to that city. No venue city, account ID, or ownership permission
is inferred. Canonical publication assignments designate routing destinations,
not event authorship, moderation ownership, or editing rights.

Mappings optionally accept `name` (nonempty display text, at most 120 characters),
`enabled` (boolean, defaults true), and `calendarUrl` (defaults null). For example:

```json
{
  "city": "Buckley",
  "publicationId": "plateau-events",
  "name": "Buckley",
  "enabled": true,
  "calendarUrl": "https://plateauevents.org/events/buckley/"
}
```

That URL is an example only, not approval or a claim that this route exists.
The bundled approved catalog has no city-specific URLs; all five return null.
Area `enabled: false` hides only geographic discovery; it does not remove the
existing canonical event source assignment or publication-level directory entry.

City calendar destinations must use HTTPS on the publication's approved origin,
with no credentials or fragment. Paths must be the publication calendar path or
its descendants, using ordinary alphanumeric/hyphen/underscore path segments.
Traversal, encoded separators/double encoding, whitespace/control characters,
and API/wp-json/graphql path segments are rejected. The only supported query is
one optional `city` parameter whose decoded value exactly matches the mapping
city. Duplicate, redirect, unknown, or mismatched parameters are rejected. Query
values must be URL-encoded. No city URL or query is generated automatically;
additional query conventions require a separately reviewed validator extension.
Existing publication-level URLs retain their existing validation.

WordPress should select tabs by area ID and fetch events using the area's exact
`city` value, encoded with URLSearchParams or an equivalent query builder. Send
one city per request. Use `sourcePublicationId` and `sourceEventUrl` on each event
for authoritative event links; do not reconstruct links from the tab name. Resolve
`publicationId` against `data` for publication metadata and general calendar links.
When the area calendar is null, use honest wording such as “View all events at
PlateauEvents,” not “View all Buckley events.” Handle absent `areas` on older API
builds gracefully; publication-only consumers can ignore the additive collection.

The revision covers configuration plus the derived geographic projection, so
mapping, display name, calendar URL, eligibility and participation changes alter
the ETag. Including the projection also invalidates pre-extension ETags. Existing
60-second directory caching and 30-second event caching remain unchanged. Refresh
area/publication selections and destinations on revision changes and remove
unavailable selections rather than guessing replacements. Catalog edits still
require a process restart. No database or public event response changes are needed.

## Authoritative event destinations

Public event list items, ID/slug detail responses, past-list items and related
event summaries add:

```json
{
  "id": 42,
  "slug": "example-event-2027",
  "city": "Example City",
  "sourcePublicationId": "community-publication",
  "sourceEventUrl": "https://community.example.test/events/example-event-2027"
}
```

The fields are null when the city has no canonical assignment, the publication
is disabled/not opted in, the catalog is invalid, or a safe event key cannot be
constructed. Never substitute ticketUrl, canonicalUrl, a local WordPress virtual
page, a guessed city domain or a different publication's calendar as an event URL.

The API preserves slug spelling and encodes it as one path segment using its
existing encodeURIComponent convention; absent slugs use the stored event ID.
The result is checked against the approved origin and exact configured path.
Dot-segment traversal and malformed Unicode fail closed. Regional event cities
can share the same publication ID and host. Recurring occurrences of one event
link to the same event detail page; no new occurrence-specific deep-link convention
is invented.

Existing fields, global SEO/canonical URL configuration, JSON-LD, ticket tracking,
parent relationships and public projection privacy rules are unchanged. Source
fields indicate the APPROVED CANONICAL ROUTING publication for the city, not proof
of which website/user originally created an event. No per-event publication owner
is currently stored.

These guarantees validate generated destinations. The API does not fetch sites
on each read, establish live WordPress route availability, or guarantee that a
publication will never redirect/change its website. Platform approval must verify
the destination and existing slug/ID routing before activation.

Future explicit ownership would require a separately reviewed optional publication
ID on events and corresponding submission/draft/approval validation, with stable
publication references and deliberate treatment of historical records. Do not
blindly backfill authorship from geographic city. This phase introduces neither
that schema nor multi-publication event ownership.

## Event queries and cancellation

For each selected publication's geographic cities, use the existing single-city
feed independently, for example:

```http
GET /events?city=Example%20City&status=upcoming&expand=1&sort=soonest&excludeCancelled=1&limit=20&offset=0
```

Existing options remain: city, category/cat, organizer/org, venue/location, q,
featured, expand, status, sort, from/to, windowDays, limit and offset. Default
expansion, chronological ordering, limit=40, offset=0, and the default upcoming
window are unchanged. Limit remains at most 100. Do not send comma-joined cities:
regional publications require one query per actual city. There is no new
publicationId filter or distinct-series endpoint.

`excludeCancelled` is optional and accepts exactly 0 or 1. Absence and 0 preserve
previous eligibility; 1 excludes records whose normalized lifecycleState is
`cancelled`. Filtering occurs before recurrence expansion, totals and pagination.
Cache keys include the option, preventing filtered/unfiltered responses mixing.
Invalid/duplicate values return the existing 400 data/error/meta convention.
No rows are changed or deleted, and historical detail pages remain available
under existing rules. Existing archived-list authorization is unchanged.

Cancellation is currently a series/event-record state. Filtering a cancelled
recurring record removes all its generated occurrences. There is no supported
occurrence-cancellation exception table/status contract in the inspected model;
this filter does not invent or interpret custom item cancellation flags. It does
not exclude postponed/rescheduled records or change lifecycle semantics elsewhere.
The legacy /events/past shortcut keeps its existing filtering behavior; use the
main /events query when this optional filter is needed.

## Four distinct listings: WordPress selection guidance

Use the existing expanded feed and bounded pagination rather than a new API
recurrence implementation:

1. Load the fresh eligible directory and take the selected publication's cities.
2. Query each city with status=upcoming, expand=1, sort=soonest and
   excludeCancelled=1. Optionally use a fixed from=<current ISO instant> for the
   request batch to discard the existing five-minute upcoming grace overlap.
3. Accept rows only when sourcePublicationId equals the selected publication ID
   and sourceEventUrl is non-null. Display the API URL unchanged; do not construct
   local destinations. Validate its HTTPS origin against that publication's
   approved website metadata as client-side defense in depth.
4. Retain only occurrences whose effective end has not passed, including an
   occurrence currently in progress. Merge the city's batches chronologically.
5. Deduplicate on the numeric event id, keeping its next eligible occurrence.
   Do NOT deduplicate on instanceId: that identifies individual occurrences.
6. Follow meta.hasMore/meta.nextOffset when needed, under a configured request
   budget (for example three pages of 20 per city), stopping at four distinct
   records. If the budget/horizon has fewer, display fewer and offer calendarUrl.

The relevant response shape remains data plus meta.total, limit, offset, hasMore
and nextOffset. Totals count occurrences when expanded, not distinct records.
Repeated weekly/dense schedules can fill several pages with one event ID; four
distinct results are a target, not guaranteed by a finite request budget. There is
no snapshot cursor guarantee across concurrent event updates. Recurrence timing,
DST, occurrence identities and legacy formats continue using the current engine.

## Cache, failure and rollout contract

Cache directory metadata briefly (at most its 60-second advertised lifetime),
revalidate with ETag, and key event caches by publication, city, filters and catalog
revision. Existing API event-list caching is 30 seconds. Invalidate client source
links when directory revision changes. Remove opted-out/disabled publications on
refresh rather than retaining indefinitely stale participation. Do not treat an
unavailable directory as proof of consent or invent links on an event/network
error. Show a concise unavailable/empty state and retry within a bounded policy.

Before deployment: run focused tests; confirm the intended Git/Render baseline
and preserve the ordinary database backup procedure. The catalog is loaded once
per process: activating reviewed JSON changes requires deployment and a process
restart through the existing workflow. No database migration, dependency, version
bump, credentials or Render configuration changes are required.

Representative slug and numeric-ID routes on both approved websites were checked
successfully during local configuration review. This does not establish Render's
running revision or verify every existing event destination. After activation,
allow the short directory cache to expire, then select publications under
OpenCircle → Settings → Nearby Communities in WordPress and save. WordPress files
are unchanged.
