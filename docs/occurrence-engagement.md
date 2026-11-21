# Occurrence engagement contract

## Existing behavior and compatibility

Events keep their existing goingCount and interestedCount counters. The
legacy POST /events/:idOrSlug/engagement accepts absolute going/interested
counts or goingDelta/interestedDelta, without authentication. It still
does so for single and recurring events. Public event lists, details, and
dashboard analytics continue using those counters. New occurrence records
never change or include them.

The inspected Community plugin stores independent WordPress option totals
and per-event/type cookie flags, then sends absolute totals to the API.
It does not currently support mutually exclusive selections or deselection.
That plugin requires a separate implementation against this contract.

Occurrences are generated from recurrence rules, including custom items,
cutoff dates and the existing timezone behavior. There is no independently
identified exception/reschedule record. This feature validates against the
current generator and does not change it.

## Identity and request authorization

Configure OCCURRENCE_ENGAGEMENT_CREDENTIALS as a server-only JSON object:

    {"community-site":{"city":"Enumclaw","secret":"at-least-32-random-characters"}}

Use a cryptographically random secret per community/site. Store the same
credential ID and secret in server-side WordPress configuration. Keep
credentials out of browser JavaScript, HTML, logs, and public endpoints.
The API fails closed with 401 if a credential is missing or invalid.
A credential authorizes only its configured city, including event slug
lookups. Multiple signing credentials for the same community resolve the same visitor
identity when the visitor cookie token is the same.

The WordPress server must generate a random 32-byte visitor token, encoded
as unpadded base64url (43 characters), in an HttpOnly, Secure, SameSite=Lax,
first-party cookie. Read this cookie on the server, never accept an
arbitrary visitorToken supplied in the public browser form. Protect the
WordPress mutation action with its existing nonce and same-origin checks.
A valid site signature plus possession of this unguessable cookie token is
the authority to edit that visitor's selection. The API cannot verify how
a trusted site obtained a token. A compromised credential can fabricate
responses within its city; keep it server-only and revoke it if compromised.

The API derives visitor hashes using HMAC-SHA256 with a separate API-only key:

    OCCURRENCE_ENGAGEMENT_IDENTITY_KEY=<64 hexadecimal characters>

Generate 32 cryptographically random bytes once, encoded as hex. Keep this
key in the API's secret configuration, independent of WordPress credentials.
The HMAC input is JSON of [stored event city, numeric event ID, visitor token].
Neither the signing credential ID nor signing secret affects this identity.
Hashes cannot be linked across event/community scopes without the secret.

Missing, malformed, or wrong-length identity configuration rejects signed
occurrence reads and writes with 503. An actionable diagnostic names the
environment variable without printing its value. Legacy engagement continues
working. There is no default, credential fallback or automatic key generation.
Syntax validation cannot establish entropy; operators must generate random keys.

Signing credentials can rotate while keeping the identity key and cookie
stable. Configure the replacement credential for the same exact community,
switch WordPress signing configuration, verify, and retire the old credential.
Nonce replay protection remains scoped to each signing credential ID.

Preserve the identity key across deployments and all instances serving the
same database. Back it up securely alongside configuration backups, separately
from database exports. Losing or changing it makes old selections inaccessible
to their visitors while historical counts remain stored. A restored database
needs the matching key. Arbitrary identity-key rotation can create duplicate
responses and requires a separately reviewed migration/recovery plan.

Old local test rows derived from signing credentials remain in the same table
but are not discoverable through the new identity derivation. Raw visitor
tokens were not stored, so those hashes cannot be automatically rederived.
No production migration is included because occurrence engagement is undeployed.
Do not delete records or copy old counts to new identities as a workaround.

## Occurrence identity

Use e{numericEventId}_{occurrenceStart}, for example:

    e42_2030-03-13T19:00:00.000Z

This matches the event feed's existing instanceId convention. The API
accepts an explicit ISO timestamp with Z or numeric offset and canonicalizes
it to UTC with milliseconds in responses. Use the actual API-supplied
occurrence start, not a locally guessed date. The ID must include the
resolved parent event ID even when requesting the event by slug.
Different start instants create different scopes. A time or date edit
does not transfer engagement. End-time-only edits retain the identity.

## Signed request

Both reads and writes use the existing POST /events/:idOrSlug/engagement.
POST avoids placing private visitor tokens in URLs or shared caches.

Read body:

    {"mode":"occurrence_read","occurrenceId":"e42_2030-03-13T19:00:00.000Z","visitorToken":"43-character-random-base64url-token"}

Write body:

    {"mode":"occurrence_set","occurrenceId":"e42_2030-03-13T19:00:00.000Z","visitorToken":"43-character-random-base64url-token","selection":"going"}

Selection is going, interested, or JSON null to deselect. Do not send
legacy counters alongside occurrence fields. Unknown fields are rejected.

Required headers:

- Content-Type: application/json
- X-OC-Key-Id: community-site
- X-OC-Timestamp: current Unix seconds, decimal
- X-OC-Nonce: fresh random base64url string, 22–64 characters
- X-OC-Signature: lowercase hexadecimal HMAC-SHA256

The signed message is the following five strings joined by a newline:

1. POST
2. Exact request path, including query string if present
3. Timestamp header
4. Nonce header
5. Lowercase hexadecimal SHA256 of JSON.stringify(parsed request body)

Serialize the body using JSON.stringify-compatible compact JSON, including
key order and UTF-8 encoding. Fields use ASCII values. In PHP, use
JSON_UNESCAPED_SLASHES and avoid adding whitespace. Reproduce the body
exactly when signing. Prefer numeric event IDs and no query parameters.
Clocks must be synchronized within five minutes. A consumed nonce cannot
be replayed and is retained for ten minutes. Expired nonce rows are pruned
on subsequent authorized requests.

Never proxy a browser-supplied arbitrary API path/body through the signer.
Resolve the selected public event and occurrence, allowlist selection,
and take the visitor token from the server-managed cookie.

## Response and failures

    {
      "ok": true,
      "id": 42,
      "occurrenceId": "e42_2030-03-13T19:00:00.000Z",
      "occurrenceStart": "2030-03-13T19:00:00.000Z",
      "available": true,
      "goingCount": 1,
      "interestedCount": 0,
      "selection": "going"
    }

Counts derive from active selection rows; selection is this visitor's
current value or null. Raw tokens and hashes never appear in responses.
All occurrence responses have Cache-Control: private, no-store.

Errors use {"error":"message"}:

- 400: invalid body, selection, token or occurrence ID; non-recurring event
- 401: invalid, missing or expired request authentication
- 404: event outside the credential's city, missing/archived event, or an
  unknown removed occurrence without historical engagement
- 409: used nonce, or occurrence unavailable for mutation
- 429: request throttled, with Retry-After: 60
- 500: storage or processing failure

Repeat a selection with a fresh nonce to retry safely. Setting the same
selection is idempotent. Concurrent updates serialize through the existing
SQLite transaction helper and one database primary key per visitor/scope.
Concurrent different choices are applied in transaction order. WordPress
must prevent duplicate clicks and ignore responses from a previously
selected occurrence.

Limits are 120 occurrence requests per client IP per minute and 60 per
visitor/event hash per minute, per process. WordPress proxy traffic shares
an IP budget; debounce reads and honor Retry-After. These process-local
budgets reset on restart; nonce replay protection persists in SQLite.

## Availability and history

New writes require a generated occurrence which has not ended and a series
that is neither archived, cancelled nor postponed. In-progress occurrences
are supported. An unavailable occurrence rejects all writes, including
deselection. Reads can return historical counts and selection with
available:false for past, removed or cancelled occurrences when the parent
event remains public. Archived/deleted parents return 404; their selection
rows remain stored. Never display historical counts as replacement-date
counts. A future policy may provide deletion of historical responses.

## Database and rollout

Startup creates occurrence_engagement (composite primary key and choice
constraint) and occurrence_engagement_nonces. There are no counter backfills,
foreign-key cascades, or rewrites of legacy events, reports or selections.
Back up SQLite consistently before rollout. Deploy the API and configure
scoped signing credentials and the stable identity key before activating the
new Community integration. Multi-instance deployments must share the identity
key and persistent database. Rate limits remain process-local, and this release
does not establish multi-instance SQLite deployment support.

The old Community plugin continues using legacy counters. A new plugin
must treat a missing API capability, authentication failure or unavailability
as an error and must not fall back to writing occurrence totals into legacy
fields. No new API counts have been added to Sharing or Sharing Pro.

Rollback application code while preserving the current database. Older
builds ignore the additive tables, but cannot safely process occurrence
payloads: deactivate the new plugin integration before rollback. Do not
restore an old backup over production writes.

Decide cookie lifetime/renewal and visitor-record retention before launch.
Cookie loss creates a new anonymous identity and does not remove the old
selection. Update privacy disclosures to describe this storage and its
purpose. Legal review and live deployment verification are separate.
