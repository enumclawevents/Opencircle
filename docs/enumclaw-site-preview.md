# Enumclaw website preview

The standalone site runs in the existing Express API process at
`/preview/enumclaw`. It uses the API's event, recurrence, venue, job, newsletter,
and submission logic. It needs no additional service, runtime, or hosting plan.

The preview includes the existing site's main event sections, filtering,
individual event pages, venue pages, jobs and applications, newsletter signup,
event submissions, and editorial pages. Nine pages and eight posts were copied
from the public WordPress API on November 10, 2026 into
`data/enumclaw-site-content.json`. Their images and the logo are bundled in
`public/enumclaw-site`. The editorial copy is a snapshot. New OpenCircle
updates appear through the existing Updates API.

Event and venue content stays live from OpenCircle. Event images in the
current Enumclaw API sample use the existing R2 image hosting. No WordPress
request is made to render the preview.

All preview pages are marked `noindex,nofollow`. They do not record page-view
metrics while comparing with the public site. Newsletter and event submission
forms are functional and use the existing approval and subscription flows.
Job application forms use the existing job application endpoint.

Event detail pages offer occurrence-specific ICS calendar downloads, native
sharing or a copy-link fallback, and directions links. Calendar downloads use
the same city and archive checks as event pages. Mobile navigation supports an
expandable menu and Escape to close; links remain visible without JavaScript.
Date shortcuts retain the active search, category, venue, and featured filters.

## Before replacing WordPress hosting

- Review all pages and links against the current public website.
- Decide the final URL mapping and redirects for existing event and post links.
- Configure the public domain on the existing API service and its DNS.
- Update canonical URLs, sitemap generation, robots rules, and preview branding
  together when making the site public.
- Confirm that every media asset is served independently of WordPress.
- Review any store, cart, payment, advertisement, or third-party forms still
  used on the WordPress site. WordPress checkout and plugin widgets are not
  migrated by this preview.
- Confirm domain registration and email arrangements before ending a hosting
  subscription. These can be separate from website hosting.

Billing work in the same workspace is separate from this frontend preview.
