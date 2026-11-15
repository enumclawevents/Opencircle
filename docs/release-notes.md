# OpenCircle API release workflow

## Version policy

API versions mark explicitly approved release milestones. Routine code changes can ship through the normal deployment workflow without incrementing the API version.

- **Patch** releases address fixes and minor corrections.
- **Minor** releases introduce backward-compatible functionality.
- **Major** releases require explicit review of compatibility changes and their effect on existing users and integrations.

OpenCircle API, OpenCircle Community, OpenCircle Sharing, and OpenCircle Sharing Pro each have an independent version.

## Official release checklist

1. Confirm the exact revision currently deployed in Render.
2. Review the Git diff from that deployed revision to the intended release candidate.
3. Confirm the included changes and use that list to draft the notes.
4. Select the approved API version.
5. Set `version` in `package.json`.
6. Set the same version in both root fields in `package-lock.json`, `version` and `packages[""].version`.
7. Add a matching version key under `releases` in `data/release-notes.json`. Include a nonempty `changes` list and an optional summary.
8. Give each change a category, short title, and concise description. Use plain language and describe only work included in the candidate.
9. Run `node --test tests/release-notes.test.js` to verify the package, lockfile, catalog, and dashboard behavior.
10. Review the final candidate diff for unrelated changes and record the exact approved commit.
11. Deploy the approved commit through the established GitHub-to-Render workflow.
12. Confirm Render marks the approved commit as live.
13. Open the authenticated Release Notes page and verify that **Current Version** and the **Latest release** entry show the approved version.
14. Record the version, exact live commit, and actual deployment date from Render in the deployment record. If the dashboard's first-publication date differs, record that difference and preserve the dashboard date.

## Release note categories

- **New** (`new`) covers newly introduced functionality.
- **Improved** (`improved`) covers enhancements to existing functionality.
- **Fixed** (`fixed`) covers corrections to existing behavior.
- **Security** (`security`) covers security improvements and corrections. These entries appear under **All Updates**.

Include only categories with changes. If you add a summary, describe the main user-visible changes in that release. Preserve historical entries and dates, including entries whose original records had no version.

## Dashboard behavior and rollback

`package.json` is authoritative for the displayed API version. A legacy `APP_VERSION` setting that differs from the package version produces a server warning. The dashboard marks the packaged version as **Latest release** once its notes are published. Missing or empty notes for that version show a notice and leave the history accessible.

The running build registers its version in SQLite when it serves successful authenticated dashboard traffic. Opening Release Notes can register it immediately. Startup and health probes leave publication to authenticated dashboard traffic. SQLite preserves the Pacific calendar date of first publication across retries, restarts, and later visits. Render's successful deployment record supplies the actual deployment date.

Before rolling back, confirm the target revision can read the live SQLite schema and verify every password-hash format the newer build may have written. Use the current production database with a compatible target to preserve writes made since deployment. Each build displays only the versioned notes it bundles, so a rollback may temporarily hide newer entries. Preserve the historical notes and deployment records for those releases.
