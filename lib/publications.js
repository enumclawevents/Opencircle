"use strict";
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const invalid = () => { throw new Error("Invalid publication catalog configuration"); };
function keys(value, allowed) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) invalid();
}
function text(value, max) {
  if (typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > max || /[\x00-\x1f\x7f]/.test(value)) invalid();
  return value;
}
const cityKey = city => city.trim().toLowerCase();
function buildPublicationCatalog(config) {
  keys(config, ["schemaVersion", "approvedHosts", "publications", "canonicalCityPublications"]);
  if (config.schemaVersion !== 1 || !Array.isArray(config.approvedHosts) || !Array.isArray(config.publications) || !Array.isArray(config.canonicalCityPublications) || config.publications.length > 100 || config.approvedHosts.length > 100) invalid();
  const hosts = new Set();
  for (const host of config.approvedHosts) {
    if (typeof host !== "string" || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/.test(host) || hosts.has(host)) invalid();
    hosts.add(host);
  }
  function httpsUrl(value) {
    text(value, 2048);
    let url; try { url = new URL(value); } catch { invalid(); }
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || !hosts.has(url.hostname)) invalid();
    return url;
  }
  const publications = new Map();
  for (const entry of config.publications) {
    keys(entry, ["id", "name", "websiteUrl", "calendarUrl", "cities", "eventRoute", "enabled", "nearbyCommunities"]);
    if (typeof entry.id !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(entry.id) || publications.has(entry.id) || typeof entry.enabled !== "boolean" || typeof entry.nearbyCommunities !== "boolean") invalid();
    text(entry.name, 120);
    const website = httpsUrl(entry.websiteUrl), calendar = httpsUrl(entry.calendarUrl);
    if (website.origin !== calendar.origin || website.pathname !== "/") invalid();
    if (!Array.isArray(entry.cities) || !entry.cities.length || entry.cities.length > 100) invalid();
    const cities = new Set();
    for (const city of entry.cities) { text(city, 100); if (cities.has(cityKey(city))) invalid(); cities.add(cityKey(city)); }
    keys(entry.eventRoute, ["pathPrefix", "identifier", "trailingSlash"]);
    if (entry.eventRoute.identifier !== "slug-or-id" || typeof entry.eventRoute.trailingSlash !== "boolean" || typeof entry.eventRoute.pathPrefix !== "string" || !/^\/(?:[A-Za-z0-9_-]+\/)+$/.test(entry.eventRoute.pathPrefix) || entry.eventRoute.pathPrefix.length > 200) invalid();
    publications.set(entry.id, { id: entry.id, name: entry.name, websiteUrl: website.href, calendarUrl: calendar.href, cities: [...entry.cities], eventRoute: { ...entry.eventRoute }, enabled: entry.enabled, nearbyCommunities: entry.nearbyCommunities });
  }
  const canonical = new Map();
  for (const mapping of config.canonicalCityPublications) {
    keys(mapping, ["city", "publicationId"]); text(mapping.city, 100);
    const key = cityKey(mapping.city), publication = publications.get(mapping.publicationId);
    if (canonical.has(key) || !publication || !publication.cities.some(city => cityKey(city) === key)) invalid();
    canonical.set(key, publication.id);
  }
  const eligible = publication => publication?.enabled && publication.nearbyCommunities;
  // Only explicitly allowlisted public metadata is serialized. Routing internals,
  // website connections, and any installation/account/credential IDs are absent.
  const data = [...publications.values()].filter(eligible).map(({id,name,websiteUrl,calendarUrl,cities}) => ({id,name,websiteUrl,calendarUrl,cities:[...cities]}));
  const revision = crypto.createHash("sha256").update(JSON.stringify(config)).digest("hex");
  return {
    directory: () => ({ data: data.map(p => ({...p,cities:[...p.cities]})), meta: { schemaVersion: 1, total: data.length, revision } }),
    eventSource: event => {
      const unavailable = { sourcePublicationId: null, sourceEventUrl: null };
      if (typeof event?.city !== "string") return unavailable;
      const publication = publications.get(canonical.get(cityKey(event.city)));
      if (!eligible(publication)) return unavailable;
      const key = String(event.slug || event.id || "").trim();
      if (!key) return unavailable;
      try {
        const target = publication.eventRoute.pathPrefix + encodeURIComponent(key) + (publication.eventRoute.trailingSlash ? "/" : "");
        const url = new URL(target, publication.websiteUrl);
        if (url.protocol !== "https:" || url.origin !== new URL(publication.websiteUrl).origin || !hosts.has(url.hostname) || url.pathname !== target) return unavailable;
        return { sourcePublicationId: publication.id, sourceEventUrl: url.href };
      } catch { return unavailable; }
    },
  };
}
let bundledCatalog;
try {
  bundledCatalog = buildPublicationCatalog(JSON.parse(fs.readFileSync(path.join(__dirname, "../data/publications.json"), "utf8")));
} catch {
  // Invalid publication configuration must not take existing event services down
  // or publish guessed links. Directory reads fail explicitly; event links are null.
  console.error("[publications] Catalog unavailable: invalid publication configuration");
}
function eventSource(event) {
  return bundledCatalog ? bundledCatalog.eventSource(event) : { sourcePublicationId: null, sourceEventUrl: null };
}
function publicationDirectory() {
  if (!bundledCatalog) throw new Error("Publication directory unavailable");
  return bundledCatalog.directory();
}
module.exports = { buildPublicationCatalog, eventSource, publicationDirectory };
