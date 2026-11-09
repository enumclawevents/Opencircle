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

Use an isolated test database with an Admin account. Open
`/admin/billing` over HTTPS or localhost while signed into the designated Admin account. Other accounts cannot open the page or enroll.
Use a [Square Sandbox test card](https://developer.squareup.com/docs/devtools/sandbox/payments).
On enrollment, the app creates a test catalog plan and monthly variation in
the configured location, then schedules the subscription for the next 8th.
The billing screen reads the subscription status from Square when reopened.

Before enabling any production billing, verify the Sandbox subscription is
pending, the start date and billing anchor are correct, and no invoice is
charged at enrollment. Production credentials are not supported by this
pilot. Production rollout also needs Meagan's account verified, an existing
Square invoice/subscription check, and a plan for payment notifications,
card replacement, and cancellation.
