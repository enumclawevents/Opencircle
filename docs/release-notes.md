# Release notes workflow

Release Notes reads curated copy from `data/release-notes.json`. Historical entries keep their original recorded dates. They have no version where the original record had none.

For a release with meaningful changes, bump the app version in `package.json` and `package-lock.json`. Add a matching version key under `releases` with an optional summary and a list of changes. Each change uses a `category` of `new`, `improved`, `fixed`, or `security`, plus a short `title` and `description`. Review the copy with the feature and use plain language. Combine related work and omit maintenance or private implementation details.

Deploy through the normal Render workflow. The running version uses the existing `APP_VERSION` override when set and otherwise uses `package.json`. If you use the override, set it to the same version for the release. Publication requires the configured and packaged versions to agree.

The running build registers its own version in SQLite once it serves authenticated admin traffic. Render only routes that traffic to the new instance after it passes its health checks. Startup and health probes never publish notes. The first authenticated Release Notes request can register and display the release immediately. The recorded date is the Pacific date when publication was first observed. Retries, restarts, and subsequent visits preserve that date. Each build reads only the versions in its bundled catalog, so rolling back hides notes for versions absent from that build.

For internal changes, skip the release metadata. The deployment leaves the changelog as it is. No external AI service, webhook, or dashboard markup changes are required.
