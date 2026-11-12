# Plateau Regional billing in Square Sandbox

This pilot is sandbox-only. It creates one Plateau Regional test subscription
for a designated OpenCircle Admin account, at USD $100 per month on the 8th
(Pacific time). Square stores the test card. OpenCircle stores Square IDs
and the card's last four digits.

In a local or test deployment, set these server environment variables:

| Variable | Value |
| --- | --- |
| `SQUARE_SANDBOX_BILLING_ENABLED` | `1` |
| `SQUARE_SANDBOX_APPLICATION_ID` | Sandbox Application ID from Square Credentials |
| `SQUARE_SANDBOX_LOCATION_ID` | Sandbox Location ID from Square Locations |
| `SQUARE_SANDBOX_ACCESS_TOKEN` | Sandbox access token, stored as a server secret |
| `SQUARE_SANDBOX_BILLING_ADMIN_EMAIL` | Sign-in email of the Admin testing billing |

Setting `SQUARE_SANDBOX_BILLING_ADMIN_EMAIL` shows **Admin → Billing** only
for that Admin. The page shows a setup notice until the other settings are
configured. Other accounts cannot open the page or enroll.

Use an isolated test database with an Admin account. Open
`/admin/billing` over HTTPS or localhost while signed into the designated Admin account.
Use Square's [no-challenge test Visa](https://developer.squareup.com/docs/devtools/sandbox/payments#sca-testing-in-the-web-payments-sdk)
`4800 0000 0000 0004`, CVV `111`, a future expiration, and ZIP `98022`.
On enrollment, the app creates a test catalog plan and monthly variation in
the configured location, then schedules the subscription for the next 8th.
The billing screen reads the subscription status from Square when reopened.

Before enabling any production billing, verify the Sandbox subscription is
pending, the start date and billing anchor are correct, and no invoice is
charged at enrollment. Production credentials are not supported by this
pilot's enrollment flow. The same admin tab has a read-only production setup
section. Set `SQUARE_PRODUCTION_LOCATION_ID` and
`SQUARE_PRODUCTION_ACCESS_TOKEN` separately in Render, then select
**Check Square connection** to verify that the live location is active, uses
USD, and supports card processing. The connection check only reads the
location from Square.

Production rollout also needs Meagan's account verified, an existing
Square invoice/subscription check, and a plan for payment notifications,
card replacement, and cancellation.

## Production payment methods

Signed-in OpenCircle accounts with an email can add a card in **Admin → Billing**.
This uses the existing production Square Application ID, Location ID, and access
token. No customer-specific settings are required. OpenCircle creates and links
a Square customer profile to the signed-in OpenCircle user ID on the first card
save. It stores Square IDs and masked card details. Existing Square customer
profiles, invoices, and subscriptions are not imported.

Saving a card does not create a charge or subscription. The designated admin
can still open **Sandbox billing and diagnostics** from the Billing page.

## Organization subscriptions

The designated billing admin can use **Admin → Billing → Organization Billing
Setup** to create a billing account, assign its billing contact, and verify
the shared Square plan and item variation. Each billing account starts with
enrollment closed. Use **Open enrollment** when the organization is ready.
No new Render settings are required.

The contact adds a card, selects it for the organization, and explicitly
authorizes $100 monthly on the 1st. The first charge is the next 1st in Pacific
time. Square handles recurring charges and receipts. OpenCircle shows status
and billing history for the linked subscription. Closing enrollment only
blocks new enrollment and does not cancel an existing subscription. Billing
does not grant, revoke, or otherwise change access to OpenCircle.
