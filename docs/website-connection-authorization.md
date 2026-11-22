# Website connections — Phase B / WordPress Phase C contract

Base: `8b34c28b1bd8bf0df7897610bb0e3338628817a6`, with the reviewed, uncommitted
Phase A registry copied from `/tmp/oc-managed-credentials`. Implementation is
isolated in `/tmp/oc-website-authorization` on `codex/website-authorization`.

This is an authorization-code/PKCE S256 based, OpenCircle-specific provisioning
protocol, not a general-purpose or certified OAuth authorization server. The
redemption response contains scoped HMAC credentials rather than standard OAuth
access/refresh tokens. There is no implicit grant, password grant or refresh token.
See RFC 9700 and RFC 7636 for the security patterns being applied.

## Configuration / default off

Existing manual credentials need no changes. The independent persistent
`OCCURRENCE_ENGAGEMENT_IDENTITY_KEY` must remain unchanged. Phase A encryption
configuration is still required for managed issuance and activation:

```text
WEBSITE_CREDENTIAL_ENCRYPTION_KEYS={"v1":"<64 hexadecimal characters for an independent random 32-byte key>"}
WEBSITE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY=v1
DASHBOARD_ORIGIN=https://admin.opencircleapi.com
```

New connection routes are disabled by default. A later, explicitly approved
rollout must set `WEBSITE_CONNECTIONS_ENABLED=true`. No setting was changed during
implementation. This is one platform-level feature switch, never a per-site key.
The flag gates all `/connections` endpoints; managed engagement verification stays
available independently and still checks current issuer authority. Missing keys
block new provisioning, activation and signed checks. Authorized revocation/status
management can operate without decryption keys while the connection routes are
enabled. Ordinary login and existing manual occurrence requests remain usable.

All production connection requests require HTTPS. Local test fixtures explicitly
use NODE_ENV=test; this is not evidence of production TLS/proxy correctness.

## Trust and account policy

The production router reuses the dashboard's actual `getUserAllowedCities` and
supported administrative cities. Administrators and Developers may authorize only
their effective supported cities; Organizers cannot authorize websites. Bootstrap
sessions resolve through the existing dedicated identity and receive no bypass.
Legacy Plateau permissions retain their existing expansion rules. Regional sites
request individual cities: Buckley, Wilkeson, Carbonado, South Prairie. Bonney Lake
is not currently in the API administrative city list.

Authorization is checked on consent and again on redemption/activation. Management
requires an Administrator or the responsible installation account, with authority
for all affected city scopes. Active managed credential lookup checks current
roles and city access for the installation owner, credential issuer and city-grant
authorizer. Deleted accounts or lost privileges cause effective suspension with a
generic authentication failure; restoration of their authority restores usability.
No event, account, session, grant or selection is rewritten just to suspend access.
Administrators can revoke suspended connections. Ownership transfer is not part of
this phase: reauthorize a new installation if responsibility must change.

The standalone registry resolver now fails closed for managed IDs unless an
explicit authority checker is supplied or configured. The production server wires
it at startup, even when provisioning is disabled. Tests inject fixture policies.
The registry must never be used as a public provisioning route by itself.

## 1. Initiate from the WordPress server

Require an authenticated WordPress administrator with manage_options and an
appropriate action nonce before making this request. Persist transaction data
server-side in a non-autoloaded option/record, bound to the initiating WordPress
user/session. Do not put the PKCE verifier or credentials in browser storage.

WordPress generates a persistent installation UUID plus, per attempt:

- 32 random bytes encoded as 43 unpadded base64url characters for `state`.
- A cryptographically random PKCE verifier (43–128 unreserved ASCII characters).
- `codeChallenge = BASE64URL(SHA256(verifier))`, without padding; only S256.

Server-to-server request (all bracketed values are placeholders):

```http
POST /connections/start
Content-Type: application/json

{
  "installationId": "<WordPress installation UUID>",
  "siteUrl": "https://example.org/wordpress/",
  "homeUrl": "https://example.org/",
  "redirectUri": "https://example.org/wordpress/wp-admin/admin-post.php?action=oc_connection_callback",
  "requesterLabel": "Website administrator",
  "cities": ["Enumclaw"],
  "state": "<43-character random base64url state>",
  "codeChallenge": "<43-character S256 challenge>",
  "codeChallengeMethod": "S256"
}
```

Response:

```json
{
  "requestId": "<opaque request ID>",
  "verificationChallenge": "<43-character random verification challenge>",
  "expiresIn": 600,
  "authorizationUrl": "https://admin.opencircleapi.com/connections/authorize?request=<request ID>"
}
```

The site URL is the canonical WordPress core installation location (site_url),
not necessarily home_url. The callback is exactly the installation URL plus
`wp-admin/admin-post.php?action=oc_connection_callback`. Home and installation
URLs must use the same HTTPS origin; query strings, fragments, userinfo, custom
ports and percent-encoded path components are unsupported. A custom/hidden admin
path or cross-domain WordPress admin setup requires separately reviewed support.
UUIDs and URLs are identifiers, not community authority. Requester label is
untrusted display text, not authenticated WordPress user identity.

The public start route creates only an expiring attempt. It creates no authorized
installation, city grant or signing credential. Unsupported cities fail outright;
they are not substituted. All connection routes have bounded process-local request
budgets. Start also caps live unapproved/approved attempts at 1,000 and prunes
expired, unprovisioned attempts. Provisioned attempts/audits are retained; a future
retention policy is still needed.

## 2. Serve the installation-control challenge

Before opening authorization, WordPress stores the API challenge and the complete
attempt metadata under the returned request ID. Serve a public read-only endpoint
at exactly:

```text
https://example.org/wordpress/wp-json/opencircle/v1/connection-proof
```

The API requests it with `X-OC-Connection-ID: <request ID>`. WordPress returns only
the record for that pending, locally initiated connection, before its ten-minute
expiry:

```json
{
  "requestId": "<request ID>",
  "installationId": "<same WordPress UUID>",
  "siteUrl": "https://example.org/wordpress/",
  "homeUrl": "https://example.org/",
  "redirectUri": "https://example.org/wordpress/wp-admin/admin-post.php?action=oc_connection_callback",
  "challenge": "<API-generated verification challenge>"
}
```

Use application/json and no-store. Never return signing keys, visitor tokens,
PKCE verifiers or unrelated pending attempts. Do not reflect arbitrary caller
values into a proof response. The API stores only a hash of the expected challenge
and compares all installation metadata before displaying consent.

The verifier uses a fixed path, public-address validation, pinned IPv4 DNS lookup,
normal certificate/hostname validation, a fresh connection, no redirects, bounded
headers/body (8 KiB), and five-second DNS and transport deadlines. Private,
loopback, metadata, mapped and special-use addresses are rejected. IPv6-only
installations are currently unsupported; conservative IPv6 filtering can reject
some dual-stack destinations. Proxy/CDN or security-plugin challenges must not
redirect the proof endpoint. Reaching it proves current installation control, not
that a plugin or administrator is trustworthy. Live WordPress ownership has not
been verified by these fixture tests.

## 3. Browser authorization and login

Redirect the administrator to authorizationUrl. Do not embed it in an iframe.
The API uses existing oc_auth sessions. An anonymous request gets a Secure,
HttpOnly, SameSite=Lax opaque continuation cookie and the existing /login page.
Successful login resumes only the server-recorded, unexpired connection URL.
Ordinary login still goes to /admin. The latest continuation cookie supersedes an
older one; WordPress should restart an expired/interrupted attempt.

After proof verification, the page shows the website, verified installation URL,
signed-in API user, website-provided administrator label, requested communities,
and only authorized requested cities as checkboxes. The consent CSP permits form submission to self and the verified installation
origin so browsers can follow the callback redirect; server-side validation still
requires the exact registered callback URI. Consent is intentional and
bound to the current API user/session by a per-attempt CSRF token. Refreshing the
page replaces the earlier consent token. Account/community rights are rechecked
on POST. Cancel issues no credentials.

Success redirects only to the registered callback with:

```text
? action=oc_connection_callback & state=<original state> & iss=<trusted dashboard origin> & code=<one-time code>
```

(Spaces above are explanatory, not actual URL syntax.) Cancellation uses
`error=access_denied` instead of code. The callback never contains signing secrets.
Codes expire after two minutes and are also bounded by the original ten-minute
attempt lifetime.

WordPress must verify the initiating administrator/session, exact state, expected
issuer and pending attempt before redemption. Strip code/state from visible URLs
immediately after processing; do not load third-party assets or log callback query
strings. Failed/cancelled callbacks must not alter working manual credentials.

## 4. Redeem once, server-to-server

```http
POST /connections/redeem
Content-Type: application/json

{
  "requestId": "<request ID>",
  "installationId": "<original WordPress UUID>",
  "redirectUri": "https://example.org/wordpress/wp-admin/admin-post.php?action=oc_connection_callback",
  "state": "<original state>",
  "code": "<authorization code>",
  "codeVerifier": "<server-held verifier>"
}
```

Response:

```json
{
  "installationId": "<API registry UUID>",
  "siteUrl": "https://example.org/wordpress/",
  "credentials": [
    {
      "id": "ocm_<credential ID>",
      "city": "Enumclaw",
      "secret": "<server-only signing secret>",
      "activationChallenge": "<server-only activation challenge>"
    }
  ],
  "activationExpiresIn": 600
}
```

The WordPress installation UUID and API registry UUID are distinct identifiers;
store both. Each approved city gets an independent pending credential. Code claim,
registration, grants, encrypted credential creation and activation-proof hashes
commit in one SQLite transaction. A failed operation rolls everything back.
Concurrent redemption has exactly one winner. Plaintext signing keys are returned
only by this exchange. The API never offers a secret-read/retrieval endpoint.

These routes reject browser Origin-bearing requests; the exchange must occur in
WordPress PHP, with TLS certificate verification enabled. This is not proof of
server identity by itself: the server-held PKCE verifier and installation proof
are also essential. All responses are private/no-store, with no cross-origin
response access and no credential-bearing logs.

## 5. Persist and prove possession

Encrypt the bundle on the WordPress server before activation. Follow the Phase A
storage design: non-autoloaded storage, authenticated encryption under suitable
server key material, capability/CSRF checks, no HTML/JS/REST exposure or settings
exports. Do not save occurrence response totals alongside credentials.

For each credential, sign this body using its issued secret:

```http
POST /connections/activate
Content-Type: application/json
X-OC-Key-Id: ocm_<credential ID>
X-OC-Timestamp: <Unix seconds>
X-OC-Nonce: <fresh random nonce>
X-OC-Signature: <HMAC-SHA256 hex>

{"credentialId":"ocm_<credential ID>","activationChallenge":"<activation challenge>"}
```

Use the unchanged five-line occurrence signing format: method, exact path,
timestamp, nonce, SHA256(compact JSON body), separated by newline characters.
The signature path is `/connections/activate`, not an engagement path. Timestamp
tolerance is five minutes and persistent nonce replay prevention is reused.
Activation challenge validity is ten minutes after issuance. Only a verified,
approved, unrevoked installation with current account/city authority can activate.
Activation and audit commit atomically. Retrying with a fresh nonce is idempotent
within the activation window. Never retry an identical nonce.

Response: `{"ok":true,"credentialId":"ocm_<ID>","status":"active"}`.
Only activated keys can authenticate occurrence requests. Keep visitor cookies and
the API identity key unchanged. Single-event engagement remains unchanged.

## 6. Test connection / status

For a server-side connection check, sign:

```http
POST /connections/check
Content-Type: application/json
X-OC-Key-Id: ocm_<credential ID>
X-OC-Timestamp: <Unix seconds>
X-OC-Nonce: <fresh nonce>
X-OC-Signature: <signature using /connections/check>

{"installationId":"<API registry UUID>"}
```

Response includes only `ok`, installationId, the credential's city and active
status. It includes no secret, visitor record or other community's data. WordPress
checks each regional credential and stores its own last-success timestamp. Do not
use the engagement endpoint with a fabricated visitor just to test connectivity.

API account management uses GET `/connections/manage?action=list`, `pending`,
`status&installationId=...`, or `audit&installationId=...`. Read responses include
a session-bound CSRF value. GET cannot mutate. POST `/connections/manage` with the
same API session, exact dashboard Origin, csrf and installationId supports actions
`revokeCredential` (credentialId), `revokeCity` (city), and `revokeInstallation`.
Audit and lists are bounded to 100 records per response. Unauthorized accounts
cannot inspect or manage another developer's connection.

WordPress signing credentials do not grant administrative revocation rights.
Phase B.1 now provides the API-hosted disconnection confirmation and completion
exchange below. A site signature can initiate a transaction, but only fresh,
CSRF-protected OpenCircle account consent can execute revocation. The existing
JSON management operations remain available. No new dashboard navigation section
is added.

## 7. Replacement, failure recovery and migration

To replace credentials on an existing connection, send optional
`replaceInstallationId: <API registry UUID>` in a fresh start request. The same
site URL must be reverified; account ownership and city scope are rechecked.
New keys record the predecessor ID. Existing active keys stay active until an
administrator explicitly revokes them after successful replacement activation and
checks. No keys are rotated merely by starting or approving a connection.

A lost redemption response cannot be retrieved repeatedly: start a fresh authorized
attempt. Previously issued but unactivated keys do not authenticate. If WordPress
persisted a key but lost an activation response, use signed check or retry activation
with a fresh nonce before expiry. If the activation window expired, reauthorize.
An outage or pending connection never disables working manual settings.

Manual `OCCURRENCE_ENGAGEMENT_CREDENTIALS` and wp-config.php credentials remain
supported. Migration is an explicit Phase C action: authorize, persist, activate,
test, switch, and only then retire manual configuration with operator approval.
Never fall back from revoked/invalid managed keys to an environment ID. Do not
change the visitor identity key, cookies, selections, counters or historical data.

Connection/authorization records survive application restarts in the persistent
SQLite database. A browser session must still be valid after restart. Credential
lookup uses current database permissions without caching. Database restoration
must preserve encryption keys and reconcile newer revocations; code rollback
must retain managed-key verification once managed clients exist. Do not restore
an old database as the default rollback procedure.

## Errors and boundaries

JSON errors contain a fixed `error` code, never raw exceptions or secrets:

- 400: invalid_request, invalid_grant, expired_connection, installation_not_verified,
  activation_expired; production HTTP is rejected with https_required.
- 401: sign_in_required or invalid_signature.
- 403: not_authorized, invalid_consent, server_exchange_required.
- 404: not_found.
- 405: method_not_allowed (attempted GET mutation).
- 409: request_used or conflict.
- 415: invalid_request (incorrect media type).
- 429: try_later, with Retry-After: 60.
- 503: connections_disabled, configuration_unavailable, connection_unavailable.

Browser authorization errors use concise HTML feedback instead of raw diagnostics.
All token-bearing routes suppress shared caching and third-party assets. The
consent document uses same-origin referrer policy so native browser POSTs retain
their Origin for strict CSRF checks; cross-origin referrers remain suppressed.
Redirects, exchanges and other connection responses use no-referrer.
Proxy/web-server access logs still require deployment verification, especially the
WordPress callback; application redaction alone cannot guarantee host log policy.

No WordPress settings/button, live proof endpoint, production email, deployment,
version bump, real site activation, or production configuration change is included.
HMAC does not cryptographically bind a stolen key to its original host. DNS/HTTPS
proof does not establish honest visitor behavior. A compromised authorized website
can fabricate selections within its city scope. Encryption does not protect against
full application/server compromise. Pending credential/audit retention, ownership
transfer and broader IPv6/admin-path support remain explicit limitations, not
unrestricted fallbacks.


## Phase B.1 — API-hosted disconnection and rotation retirement

This completes the Phase C lifecycle contract. `WEBSITE_CONNECTIONS_ENABLED`
remains disabled by default. There are no new environment keys, production changes
or WordPress changes. Startup idempotently adds `website_disconnection_attempts`
and its expiry index; existing events, engagement/identity data and manual
credentials are untouched. Keep the table on rollback.

### Initiation authenticates the WordPress server, not revocation authority

The initiating WordPress administrator must pass `manage_options`, a local action
nonce and a POST. WordPress creates a new 32-byte base64url state and server-held
PKCE verifier/challenge. Do not reuse the onboarding transaction.

Send the following **server-to-server**, signed with an active managed credential
belonging to the target API installation. Use the existing five-line HMAC format,
five-minute timestamp tolerance and fresh nonce. The signature path is exactly
`/connections/disconnect/start`.

```http
POST /connections/disconnect/start
Content-Type: application/json
X-OC-Key-Id: ocm_<active credential ID>
X-OC-Timestamp: <Unix seconds>
X-OC-Nonce: <fresh random nonce>
X-OC-Signature: <HMAC-SHA256 hex>

{
  "installationId": "<API registry UUID>",
  "clientInstallationId": "<persistent WordPress installation UUID>",
  "redirectUri": "https://example.org/wordpress/wp-admin/admin-post.php?action=oc_connection_callback",
  "operation": "installation",
  "state": "<43-character random base64url state>",
  "codeChallenge": "<43-character S256 challenge>",
  "codeChallengeMethod": "S256"
}
```

The API validates the signing credential's current account/city authority. Its
installation must match the target. The client installation ID, site URL and
callback must match the verified provisioning record associated with that exact
credential. Caller-provided IDs/URLs alone are insufficient. The callback is not
registered or changed by this request. Manual keys and revoked/inactive managed
keys cannot initiate it. Ordinary manual engagement keeps working.

This also corrects an activation lookup ambiguity: activation now resolves the
exact credential's provisioning record, rather than selecting the latest record
for an installation. Multiple provisioning attempts with equal timestamps cannot
select each other's proof records.

Select exactly one operation:

| operation | Additional fields | Effect after human confirmation |
| --- | --- | --- |
| `installation` | None | Revoke installation, all its grants and all managed credentials. |
| `city` | `city` | Revoke only that exact existing city grant and its pending/active keys. Other cities stay connected. |
| `credential` | `credentialId` | Revoke only that credential, preserving other keys and the city grant. |
| `rotation` | `credentialId`, `replacementCredentialId` | Retire only the old key after checking that its linked replacement is already activated, unexpired and in the same installation/city. |

Rotation is not a full disconnection and never revokes the replacement. Both the
start request and final confirmation recheck replacement state. Do not use `city`
or `installation` to retire a predecessor during rotation.

Response:

```json
{
  "requestId": "<opaque disconnection transaction ID>",
  "requestProof": "<43-character server-only random proof>",
  "expiresIn": 600,
  "confirmationUrl": "https://admin.opencircleapi.com/connections/disconnect?request=<request ID>"
}
```

Store requestProof, PKCE verifier, state, operation, target IDs and exact callback
in the encrypted WordPress pending transaction. Bind it to the initiating local
administrator/session. The API stores only hashes/challenges for the proof and
verifier. Never put requestProof, verifier or signing secrets in redirects, HTML,
JavaScript, notices or logs. An initiation request creates no revocation authority
and does not disable any credential.

### Browser confirmation

Open confirmationUrl on the trusted dashboard origin. An expired/missing API
session is directed through existing /login and a bounded opaque continuation
cookie. Ordinary login destinations remain unchanged.

The page displays “Disconnect OpenCircle Website”, the verified website URL,
affected cities and the exact operation's effect. It uses native accessible
Confirm and Cancel controls, a session-bound per-transaction CSRF token, strict
Origin checks, frame protection, private/no-store responses and the same safe
referrer/CSP treatment as onboarding consent.

The actor must be an OpenCircle Administrator or the responsible Developer with
authority for every affected city. Organizer ownership of events is insufficient.
Scope and connection ownership are checked both when showing the page and on
POST. Full-installation action requires all city scopes; city/key actions require
only their affected scopes plus installation management rights. No default city
is substituted. A transaction expires ten minutes after initiation. Refreshing
confirmation replaces its earlier CSRF token. GET never revokes anything.

On Confirm, registry revocation, sanitized audit and immutable completion result
commit in one SQLite transaction. Concurrent confirmations have one winner. A
failure rolls back revocation and produces no success receipt. Repeated requests
cannot revoke extra keys. Existing API management endpoints remain protected and
unchanged. Cancellation also creates a verifiable result but makes no credential
changes. Neither action deletes events, analytics, visitor identity or selections.

The registered callback receives only:

```text
https://example.org/wordpress/wp-admin/admin-post.php?action=oc_connection_callback&state=<original state>&iss=https%3A%2F%2Fadmin.opencircleapi.com&completion_code=<one-time completion code>
```

A `completion_code` is a short-lived receipt-exchange code, not a signing
credential or proof of success. The code expires two minutes after confirmation
or cancellation. The browser does not receive signing keys or the server-only
requestProof. WordPress must validate state, issuer, pending operation and local
administrator/session, then remove code/state from its visible URL before loading
other resources. Do not infer success or cancellation from query parameters alone.

### Verify completion after revocation

WordPress PHP redeems the code without its now-revoked signing credential:

```http
POST /connections/disconnect/result
Content-Type: application/json

{
  "requestId": "<disconnection transaction ID>",
  "installationId": "<API registry UUID>",
  "clientInstallationId": "<persistent WordPress UUID>",
  "redirectUri": "https://example.org/wordpress/wp-admin/admin-post.php?action=oc_connection_callback",
  "state": "<original state>",
  "codeVerifier": "<server-held verifier>",
  "requestProof": "<server-held initiation proof>",
  "completionCode": "<callback completion_code>"
}
```

The authorized redeemer is the original WordPress server. The API authenticates
it through BOTH the random requestProof and PKCE verifier bound during the signed
initiation, plus the exact installation, state, callback and completion code.
Browser possession of a code or installation ID is insufficient. Signing secrets
cannot themselves authorize the human revocation step. Browser Origin-bearing
exchange requests are rejected. TLS certificate verification remains required.

One transactional exchange consumes the code and returns:

```json
{
  "ok": true,
  "requestId": "<same disconnection transaction ID>",
  "installationId": "<same API registry UUID>",
  "operation": "installation",
  "status": "revoked",
  "affectedCities": ["Enumclaw"],
  "revokedCredentialIds": ["ocm_<revoked key>"],
  "replacementCredentialId": null,
  "completedAt": "<API completion timestamp>"
}
```

For Cancel, status is `cancelled` and revokedCredentialIds is empty. For rotation,
the result identifies the replacement kept active. WordPress must compare all
transaction/operation/target fields before changing local state. Clear only the
revoked city/key mapping or the whole managed connection as appropriate. Never
silently fall back to old manual settings. Keep cancellation's existing mode.
A replayed code returns 409 `completion_used`.

### Interrupted redirects and delivery recovery

If the browser callback is lost, the two-minute code expired, or the first server
exchange committed but its response was lost, WordPress can use one bounded,
authenticated recovery delivery:

```http
POST /connections/disconnect/recover
Content-Type: application/json

{
  "requestId": "<same transaction ID>",
  "installationId": "<same API registry UUID>",
  "clientInstallationId": "<same WordPress UUID>",
  "redirectUri": "<exact same callback URI>",
  "state": "<same state>",
  "codeVerifier": "<same server-held verifier>",
  "requestProof": "<same server-held initiation proof>"
}
```

Recovery is available for ten minutes after committed confirmation/cancellation.
It authenticates the same PHP server with the same proof and verifier; no browser
claim or signing key is sufficient. It returns the SAME immutable committed result
with `recovered:true`, never executes revocation again, invalidates any outstanding
completion code, and permits only one recovery delivery. This is explicitly one
extra authenticated delivery if a normal result was already claimed, not a second
completion or code redemption. A second recovery returns 409 `recovery_used`.
API restarts preserve the transaction, code claim and recovery budget in SQLite.

A forged callback cannot manufacture a result: both normal and recovery exchanges
require a committed human decision and the server-held proofs. Before confirmation
or after expiry, recovery fails. If all delivery attempts or the ten-minute recovery
window are exhausted, show Needs attention and preserve fail-closed local state;
do not claim verified revocation, reset identity, reconnect or restore manual mode.
An authorized OpenCircle administrator must inspect existing connection status
before local cleanup/reconnection. Never harvest their API session cookie or CSRF
token into WordPress. Missing/revoked credentials at initiation similarly require
existing authorized API management; this flow does not revive a revoked key.

### Additional errors and rollout

The new routes use the existing sanitized JSON/HTML handling and default-off flag.
Disconnection confirmation and receipt redemption do not need the encryption key;
initiation needs it to authenticate the managed signer. Codes include:

- 400: invalid_request, callback_mismatch, disconnect_expired, invalid_result,
  completion_expired.
- 401: invalid_signature or sign_in_required on expired confirmation POST.
- 403: not_authorized, invalid_consent, server_exchange_required.
- 409: request_used, replacement_not_active, completion_used, recovery_used.
- 429: try_later with Retry-After: 60; pending attempts are capped at 1,000.
- 503: existing configuration/feature/storage failures.

All proof/result responses remain private/no-store, without cross-origin response
access. Audit contains fixed actions and record IDs, never codes, secrets, proof or
verifier. Hosting/WordPress callback logs still need live redaction verification.
The completion path is intended for PHP, not a browser AJAX exchange.

No automatic manual-to-managed migration or old environment-key retirement occurs.
Deploy API support first only after explicit approval; the WordPress connector can
then implement this exact lifecycle contract. Preserve current SQLite writes and
keys on rollback. An older build may not understand outstanding disconnection
transactions, so retain this code until pending confirmations/results are finished
or expired; already-revoked keys remain revoked and must not be reactivated by
rollback. No production activation or deployment is included in Phase B.1.
