"use strict";

const { DateTime } = require("luxon");
const { all, run } = require("../db");
const { esc } = require("./html");
const { DEFAULT_TZ } = require("./admin-constants");
const { version } = require("../package.json");
const catalog = require("../data/release-notes.json");

const categories = { all: "All Updates", new: "New", improved: "Improved", fixed: "Fixed", security: "Security" };
const filters = ["all", "new", "improved", "fixed"];
const pageSize = 4;
const appVersion = `v${version}`;
const configuredVersion = String(process.env.APP_VERSION || "").trim().replace(/^v/i, "");
if (configuredVersion && configuredVersion !== version) {
  console.warn("[release notes] APP_VERSION differs from package.json. Using the packaged version.");
}
let publication;

function hasReleaseNotes(releaseVersion) {
  const entry = Object.hasOwn(catalog.releases, releaseVersion) && catalog.releases[releaseVersion];
  return Array.isArray(entry?.changes) && entry.changes.length > 0;
}

// Record a version only when its own build is serving authenticated traffic.
// Older builds can only render releases shipped in their bundled catalog.
function publishCurrentRelease() {
  if (!hasReleaseNotes(version)) return Promise.resolve();
  if (!publication) {
    publication = run(`INSERT OR IGNORE INTO published_releases (version, date) VALUES (?, ?)`,
      [version, DateTime.now().setZone(DEFAULT_TZ).toISODate()])
      .catch(error => {
        publication = undefined;
        throw error;
      });
  }
  return publication;
}

async function readReleaseNotes(query = {}) {
  const category = filters.includes(query.category) ? query.category : "all";
  const requestedPage = typeof query.page === "string" && /^\d{1,6}$/.test(query.page) ? Number(query.page) : 1;
  const published = await all("SELECT version, date FROM published_releases ORDER BY rowid DESC");
  const releases = [
    ...published.filter(item => hasReleaseNotes(item.version))
      .map(item => ({ ...catalog.releases[item.version], ...item })),
    ...catalog.history,
  ].sort((a, b) => b.date.localeCompare(a.date));
  const hasCurrentNotes = hasReleaseNotes(version);
  const latestVersion = hasCurrentNotes && published.some(item => item.version === version) ? version : undefined;
  const matching = releases.map(release => ({
    ...release,
    changes: release.changes.filter(change => category === "all" || change.category === category),
  })).filter(release => release.changes.length);
  const page = Math.min(Math.max(1, requestedPage), Math.max(1, Math.ceil(matching.length / pageSize)));
  return {
    category, page, latestVersion, missingCurrentNotes: !hasCurrentNotes,
    releases: matching.slice((page - 1) * pageSize, page * pageSize),
    hasMore: page * pageSize < matching.length,
  };
}

function renderReleaseEntries(notes) {
  const notice = notes.missingCurrentNotes && notes.page === 1
    ? '<p class="muted">Release notes for the current version are unavailable.</p>'
    : "";
  if (!notes.releases.length) return notice || '<p class="muted">No release notes match this filter.</p>';
  return notice + notes.releases.map(release => {
    const date = DateTime.fromISO(release.date).toFormat("MMMM d, yyyy");
    const grouped = Object.keys(categories).filter(key => key !== "all").map(key => {
      const changes = release.changes.filter(change => change.category === key);
      if (!changes.length) return "";
      return `<div class="release-change-group">
        <h4 class="release-category release-category--${key}">${categories[key]}</h4>
        <ul>${changes.map(change => `<li><strong>${esc(change.title)}</strong><p>${esc(change.description)}</p></li>`).join("")}</ul>
      </div>`;
    }).join("");
    return `<article class="release-entry">
      <div class="release-entry-meta">
        <h3>${release.version ? `Version ${esc(release.version)}` : esc(date)}</h3>
        ${release.version ? `<time datetime="${esc(release.date)}">${esc(date)}</time>` : ""}
        ${release.version && release.version === notes.latestVersion ? '<span class="release-latest">Latest release</span>' : ""}
      </div>
      <div class="release-entry-body">${release.summary ? `<p class="release-summary">${esc(release.summary)}</p>` : ""}${grouped}</div>
    </article>`;
  }).join("");
}

module.exports = { appVersion, categories, filters, publishCurrentRelease, readReleaseNotes, renderReleaseEntries };
