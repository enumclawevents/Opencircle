# Managed website credentials — Phase A

Phase B now supplies the gated HTTP authorization flow and production authority
checker. See [website-connection-authorization.md](website-connection-authorization.md).
The Phase A-only boundaries below describe the registry layer, not all routes in
the integrated Phase B checkout.

This internal registry is based on API main `8b34c28b1bd8bf0df7897610bb0e3338628817a6`.
It adds no HTTP endpoints, dashboard controls, OAuth, website verification or
WordPress changes. A URL, installation ID or city supplied by an untrusted caller
never grants access by itself. Existing manual clients require no changes.

## One-time Render configuration

Managed issuance, activation and decryption require these two settings:

```text
WEBSITE_CREDENTIAL_ENCRYPTION_KEYS={"v1":"<64 hexadecimal characters representing 32 cryptographically random bytes>"}
WEBSITE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY=v1
```

Replace the bracketed placeholder with a securely generated key. The JSON value
is a version-to-key map; the active version must exist in it. Use separate random
material from signing secrets and `OCCURRENCE_ENGAGEMENT_IDENTITY_KEY`. Reusing the
identity key as an encryption key is explicitly rejected. Nothing generates a
master key on startup. No per-site environment entries are needed for managed
credentials. No configuration was changed as part of this implementation.

Missing/malformed keys make managed issuance/activation fail with a sanitized
`UNAVAILABLE` error; managed request authentication fails closed with the existing
generic 401. Existing `OCCURRENCE_ENGAGEMENT_CREDENTIALS` entries continue working
without an encryption key. Keep the independent occurrence identity key exactly
as configured; its existing 503 behavior remains unchanged.

To rotate the encryption master key, retain old versions in the key map, add a
new independently random version and select it for future issuance. Old ciphertext
continues using its recorded version. Removing a version makes its credentials
unusable. Automated re-encryption and a master-key recovery workflow are not part
of Phase A. Back up keys separately and securely; a database backup alone is not
sufficient to recover managed signing secrets.

## Storage and invariants

Startup idempotently creates four additive tables and one supporting index:

- `website_installations`: random UUID, canonical HTTPS site URL, responsible
  account ID, registered/active/revoked status and timestamps.
- `website_authorized_cities`: explicit single event-city grants, authorizing
  account ID and grant/revocation times; composite installation/city key.
- `website_signing_credentials`: reserved random ID, installation/city, encrypted
  secret and encryption-key version, pending/active/revoked status, issue/activation/
  revocation times, optional expiry in Unix milliseconds and predecessor ID.
- `website_connection_audit`: fixed action names, installation/credential/city,
  actor ID and timestamp. It stores no secret, ciphertext, token, arbitrary error,
  request body or caller-supplied metadata.

New tables declare installation/scope/predecessor foreign keys without cascades.
Registry operations also validate these relationships explicitly, independent of
whether a connection enables SQLite foreign-key enforcement. No existing table,
event, counter, selection, nonce or account is rewritten. Issuer IDs remain audit
references; account deletion does not cascade through these tables.

Secrets are 32 random bytes encoded as 43 unpadded base64url characters. Each uses
AES-256-GCM, a fresh random 12-byte IV and a 16-byte authentication tag. Associated
data binds the format, credential ID, installation ID, exact city and key version.
Changing ciphertext or bound metadata makes decryption fail closed. Plaintext is
returned only by the internal issuance operation and briefly recovered for HMAC
verification. It is never returned by status or audit operations.

## Lookup, scope and compatibility

Managed IDs are `ocm_` plus 32 base64url characters. This namespace is reserved:
unknown, malformed, pending, expired, revoked or undecryptable managed IDs never
fall back to environment credentials, even if JSON contains an identical ID.
Existing manual IDs outside that namespace retain their lookup and validation.
Before rollout, confirm no existing manual ID uses this new reserved prefix; if
one does, arrange an explicit ID transition rather than silently treating it as
managed. This task did not inspect live secrets or Render settings.

An active credential requires an active installation and an unrevoked matching
city grant. Each credential covers one exact event city; a regional installation
has separate grants and credentials for its component cities. `Plateau Regional`
and `Plateau Area` are rejected as grant city labels. Phase B must additionally
validate requested cities against the account's existing effective permissions.

The existing WordPress request format is unchanged: `POST /events/:idOrSlug/engagement`,
existing occurrence body, `X-OC-Key-Id`, timestamp, nonce and HMAC-SHA256 signature.
The signed message, timestamp tolerance, replay table, rate limits, event city
lookup, recurrence validation and response payload are unchanged.

Credential resolution and HMAC verification now occur inside the same existing
SQLite write transaction as event lookup, nonce claim and engagement mutation.
Revocation and engagement serialize: a request that obtains the transaction first
may finish before revocation; a request following committed revocation fails.
There is no credential cache or per-request last-use/audit write. Existing nonce
writes remain. This follows the application's current SQLite transaction model;
it does not add multi-instance deployment support.

Visitor hashing still uses only the persistent identity key and
`[stored event city, event ID, visitor token]`. Neither managed installation nor
credential IDs enter that derivation. Issuing, rotating, expiring and revoking
signing credentials do not delete or rewrite visitor selections or legacy totals.

## Phase B internal contract

Import `createWebsiteCredentialRegistry` from `lib/website-credentials.js` with:

```js
const registry = createWebsiteCredentialRegistry({
  transaction,
  authorize: async ({ tx, actorUserId, city, installationId }) => {
    // Phase B must implement current account/role/community and
    // connection-management authorization here. No network calls in tx.
    // Return true only when this actor is authorized for this operation's scope.
  },
});
```

The factory has no permissive default. All management/status operations require
an explicit successful authorizer and a positive numeric actor ID. Phase A does
not export dashboard permission helpers, invent organizer rights, or wire any
production authorizer. Its tests use disposable accounts and a fixture authorizer.

Phase B must enforce Administrator/authorized Developer rules using current
permissions, stable session identity, connection responsibility and verified site
ownership before invoking operations. The callback receives `city: null` for
installation-level checks and an installation ID when one already exists. A
successful cryptographic signature is not authority to issue or revoke credentials.

| Method | Input / behavior |
| --- | --- |
| `registerInstallation` | `{actorUserId, siteUrl}` → `{id, siteUrl}`; HTTPS, no userinfo/query/fragment; URL normalization is not ownership verification. Creates no city grant. |
| `grantCity` | `{actorUserId, installationId, city}`; explicit authorization, records the grant. Regrant does not reactivate revoked credentials. |
| `issueCredential` | `{actorUserId, installationId, city, expiresAt?, replacesCredentialId?}` → `{id, secret, city}`; creates pending credential. The predecessor must be active and match installation/city. |
| `activateCredential` | `{actorUserId, credentialId}`; checks current grant, expiry and decryptability, activates credential/installation atomically; active retry is idempotent, revoked/expired retry is rejected. |
| `revokeCredential` | `{actorUserId, credentialId}`; terminal, idempotent revocation; works even if encryption keys are missing. |
| `revokeCity` | `{actorUserId, installationId, city}`; revokes grant and all its pending/active credentials atomically. |
| `revokeInstallation` | `{actorUserId, installationId}`; requires all its city scopes; revokes installation, grants and credentials together. |
| `getStatus` | `{actorUserId, installationId}`; authorized metadata only; evaluate `expiresAt` for effective expiry, which does not rewrite status on every request. |
| `recordAuditEvent` | `{actorUserId, installationId, credentialId?, action}`; allowlists `connection.checked`, `connection.check_failed`, `provisioning.acknowledged`; no arbitrary metadata. |

Management operations own their transaction; do not call them from an already
open transaction. Each mutation and its audit row commit together. A database or
audit failure rolls the complete operation back. Errors use fixed RegistryError
codes: INVALID, FORBIDDEN, NOT_FOUND, CONFLICT, UNAVAILABLE, STORAGE. Raw database
errors are not surfaced. Failed transactions do not persist a misleading success
audit. There is no general failed-operation logging endpoint.

For signature verification, use `resolveSigningCredential(tx, id)` only inside
an existing transaction. It returns `{city, secret}` or null and is not a status
or provisioning API. Never serialize its result to an HTTP response.

Phase B must implement short-lived authorization state, code/PKCE validation,
atomic code redemption and delivery acknowledgement. Persist the issued secret
on WordPress before activation; lost issuance responses require fresh controlled
issuance rather than a secret-read endpoint. Issuing a replacement does not revoke
the predecessor. Activate, verify provisioning, then explicitly revoke the old ID.
Pending credentials without an explicit expiry do not authenticate but remain
stored; Phase B should supply expiry and establish cleanup/retention policy.

Account permission changes, account deletion, domain verification/migration,
connection ownership transfer and automatic grant suspension are Phase B policy
hooks, not implemented account lifecycle changes in Phase A. HMAC credentials
remain usable from any host possessing their secret; storing a site URL does not
provide cryptographic sender/domain binding. API database-write or process
compromise remains outside the encryption-at-rest protection boundary.

## Deployment and rollback

No deployment is included. Before a future rollout, take a SQLite-consistent
backup and protect the versioned encryption keys and unchanged identity key.
Registry initialization is additive; older builds ignore these tables. Keep the
current database on code rollback; never drop registry tables or restore an older
backup over new writes. An older verifier cannot authenticate managed IDs, so
retain registry-aware verification in the rollback candidate or plan an explicit
manual-client transition first. Existing manual clients remain compatible.

No OAuth/pairing endpoints, WordPress Connect UI, public credential operations,
website proof, key-generation command, dependency changes, versions or Release
Notes are included in this phase.
