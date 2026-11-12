# OpenCircle dashboard UI audit

The audit uses the existing dashboard shell as the design reference. It covers dashboard HTML routes and their embedded controls. Public site previews, newsletter email templates, and machine API responses have distinct requirements.

| Priority | Area and evidence | Recommended standard | Implementation location |
| --- | --- | --- | --- |
| High | Primary buttons use white text on the bright green brand fill. General content links and placeholders also use light colors against white. The main control rule removes outlines, and its replacement focus shadow is faint. | Use readable foreground colors on existing fills, an explicit keyboard focus ring, and visible disabled states. Keep decorative brand colors separate from functional text. | Shared control styles in `routes/admin.js` and `public/admin-ui.css` |
| High | At 390px the dashboard and organizer analytics extend past the viewport. The dashboard header search has a mobile minimum width and the layout includes several minimum-content grid tracks. Updates has a wide management table without a bounded scroll area. | Allow grid items and the search field to shrink. Keep wide tables in named, keyboard-accessible scroll regions. | Shared shell, dashboard and table styles |
| High | User management overlays display a dialog visually but leave focus on the opener, allow background tabbing, and lack an independently scrollable panel. | Use native dialog focus and Escape handling, restore focus to the opener, and constrain panel height on short screens. | Users markup, styles, and handlers in `routes/admin.js` |
| High | Users panels and dialogs retain white surfaces in dark mode. Feedback in Preferences, Newsletter, Reports, Users, and Messages mixes dark green or red text with inherited dark surfaces. | Use semantic surface, text, and border tokens for both themes. Give feedback an appropriate status or alert role. | Users and notice templates, shared theme styles |
| Medium | Approval and invite primary actions use `btn primary`, while several destructive actions use `btn danger`. The shared stylesheet defines `btn-primary` and `btn-danger`. | Use the existing button variants and keep destructive confirmations. Use the same readable disabled and focus states for links and buttons where applicable. | Approvals, reports, invites, users, newsletter |
| Medium | Some text fields, searches, and sort controls rely on an adjacent label or placeholder. The event editor and other long forms also have different input spacing. | Give each control an associated label or accessible name. Reuse the shared 44px control height and the event editor’s grouped sections. Associate helper text with the field it describes. | Global search, event location, update filters, long-form templates |
| Medium | The account dropdown closes on Escape without returning focus. The shared shell has no skip link. | Return focus when dismissing a keyboard-operated popup and offer a direct route to the main content. | Shared header and navigation handlers |
| Medium | Table typography and empty states differ between analytics, Updates and Billing. Billing’s dense histories have a useful scroll wrapper. Updates and analytics should follow the same containment pattern where tables are too wide. | Preserve real table semantics, numeric alignment and meaningful empty messages. Contain scrolling to the table instead of the page. | Updates list, analytics tables, Billing |
| Medium | Inline and full-page error responses vary. Some legacy actions return plain text or navigate away, while the event editor keeps feedback next to Save. | For future workflow changes, use the event editor’s inline feedback pattern and keep entered values on failure. | Mutation routes and page-specific scripts |
| Low | Headers use several title sizes, and management cards mix ad hoc padding with the existing token scale. Specialized KPI and billing layouts are useful. | Use `sectionTitle`, `card`, `mini`, and the existing gap and radius tokens. Keep compact analytics and specialized charts where appropriate. | Shared shell and individual render branches |
| Low | The shell mixes Lucide with existing Font Awesome chart and message icons. | Use the current Lucide convention for new navigation and actions. Replace existing icons only where meaning or alignment is unclear. | Sidebar, header and action controls |

## Route inventory

The following suffixes are relative to `/admin`. The inventory is taken from the route handlers. JSON-only lookups and downloads were reviewed as dependencies of the HTML flows.

| Family | Screens and states reviewed |
| --- | --- |
| Overview | `/`, dashboard scope and date controls, chart toggles, asynchronous summary, quick links and sidebar |
| Events | `/create-events`, `/existing-events`, `/approve-events`, `/event-reports`, `/upload-events`, `/events-analytics`, `/events-organizers`; Advanced settings, parent picker, recurrence, duplicate warning, lifecycle controls |
| Venues, Jobs and Ads | `/venues`, `/venues/create`, `/venues/analytics`, `/jobs`, `/jobs/create`, `/jobs/applicants`, `/jobs/analytics`, `/ads`, `/ads/create`, `/ads/analytics`; listing, edit form, filtering, role visibility |
| Newsletter | `/newsletter`, `/newsletter/preview`, `/newsletter/analytics`, `/newsletter/audience`; settings, preview, campaign and audience views |
| Updates | `/updates`, `/updates/create`, `/updates/analytics`, `/updates-log`; management table, entry form, release filtering and pagination |
| Account and administration | `/preferences`, `/messages`, `/users`, `/invites`, `/billing`; profile, account popup, user modal, roles, billing access and payment state |
| Role-specific | Organizer menu and event-only routes, developer management routes, administrator-only user/invite screens and designated billing access |

Preserve the event editor’s grouped sections, native disclosures, the parent picker’s keyboard actions, the role-aware navigation, responsive KPI cards, the release notes’ filter and pagination, and reduced-motion-aware loading feedback.

Accessibility review criteria include contrast, keyboard focus, reflow, labels, and status messages. This is a targeted audit, not a WCAG conformance certification. [WCAG 2.2](https://www.w3.org/TR/WCAG22/)

## Implemented changes

- Added shared keyboard focus, link and action colors, disabled styling, and success and error notices. Corrected legacy primary and destructive button classes in approvals, reports, invites, Users, and Newsletter.
- Fixed narrow layout overflow in Dashboard, Events Analytics, and Updates. Metric explanations stay inside the viewport on narrow screens, the calendar keeps event counts readable, and the Dashboard activity list wraps. Updates has a named, keyboard-scrollable table for populated results and a visible empty state for filtered results.
- Made Users surfaces, header controls, and calendar days theme-aware. Users now uses a native, scrollable dialog and search hides nonmatching rows. The sidebar and account popup return keyboard focus when dismissed. The shell has a skip link, and global search, Updates filters, and venue fields have accessible names.
- Kept the existing shell and page-specific workflows. See [Dashboard UI standards](dashboard-ui-standards.md) for the conventions to reuse.

## Validation

- All 31 dashboard HTML routes returned HTTP 200 and rendered the main shell when opened with an authorized local fixture account. Developer, administrator, and organizer access were used across route and browser checks.
- Chrome sampled 37 page and viewport combinations across 1440px, 1280px, 768px, 390px, and 320px, plus seven organizer page checks at 390px. The sampled pages fit the viewport. The populated Updates table scrolled inside its own region and submitting an unmatched filter showed the empty state.
- Verified Escape dismissal and focus restoration for the Users dialog, account dropdown and mobile sidebar. The Users dialog and mobile sidebar also moved focus inside on opening. Verified skip-link focus, user filtering, and light and dark Users surfaces. Visually reviewed screenshots of the mobile Users dialog and Updates list.
- All 34 existing tests passed, including event form structure, recurrence saves, parent-event approval and edits, lifecycle, reports, filters, roles, billing management, and release notes. JavaScript syntax and diff checks passed. The repository has no build or lint script.
- Browser checks used synthetic data and blocked external assets. Third-party fonts and icons, populated production analytics and billing states, Square card entry, newsletter delivery, assistive technology, and browsers other than Chrome remain unverified. The temporary fresh-database fixture logged an email-report scheduler schema warning at startup. Dashboard route checks still completed.

## Follow-up recommendations

- Apply the event editor’s inline error and value-preservation pattern to legacy mutation flows after reviewing each flow’s redirects and permissions.
- Audit remaining specialized tables with populated production-like fixtures, particularly analytics and billing. Compare the shared Updates wrapper with existing billing and analytics scrollers before consolidating them.
- Apply the documented heading and spacing conventions as older templates are touched. Review screen-reader behavior, long translated labels, and remaining dark-theme status badges with representative data.
