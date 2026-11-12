# OpenCircle dashboard UI standards

| Area | Use in the dashboard |
| --- | --- |
| Page structure | Use the shared admin shell and its main landmark. Keep content full-width and left-aligned. Put the page title and optional subtitle above the primary content, with page actions alongside on wide screens and below on narrow screens. Use `sectionTitle` for card headings. |
| Typography | Inherit the shell font and text colors. Follow the dashboard’s 28px page heading and 20px section heading for new pages. Use `sub` for supporting copy and `muted` for secondary text. Keep numerical metrics visually prominent and right-align comparable table values. |
| Spacing and cards | Use `--gap` between sections and `card` for standalone sections. Use `metric` or the existing dashboard KPI card for a single measurement. Use `mini` for inset content. Reuse `--panel`, `--panel2`, `--line`, `--radius`, `--radius-inner`, `--radius-mid`, and `--shadow`. |
| Forms | Use `ctrl` and the shared `--ctrl-h` for regular fields. Give each field an associated label and connect helper text or validation with `aria-describedby`. Keep optional advanced settings in a disclosure. Use the parent event picker as the reference for searchable selection. |
| Actions | Use `btn btn-primary` for the main action, `btn` for secondary actions, and `btn btn-danger` for destructive actions. Keep destructive confirmations. Place related actions together and give every icon-only control an accessible name. Use the existing Lucide icons for new controls where available. |
| Tables | Keep native headings and table cells. Use a named, keyboard-scrollable region if columns need more space than the viewport provides. Render the empty message outside the scroller so it stays readable. Keep search and filters above results. |
| Feedback | Use `mini admin-notice admin-notice--success` with `role="status"` and `mini admin-notice admin-notice--error` with `role="alert"`. Keep feedback near the action or section that produced it. Use the existing loading skeleton for route transitions and honor reduced-motion settings. |
| Navigation and dialogs | Use the shared role-aware sidebar and current-page treatment. Keep the main-content skip link. Restore keyboard focus when a popup closes. Use the Users native dialog pattern for new modal actions, including an accessible name, an explicit close button, and a scrollable panel. |
| Responsive and dark themes | Let grid tracks shrink with `minmax(0, …)`. Stack long controls and cards when they no longer fit. Check narrow screens with real row data and with empty results. Use semantic foreground and surface tokens and test keyboard focus in both themes. |

The shared shell, layout, and component rules live in `routes/admin.js`. Dashboard interaction colors, keyboard focus, notices, and responsive refinements live in `public/admin-ui.css`. Billing and Release Notes use their existing page-specific styles for specialized components.
