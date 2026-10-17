"use strict";

// Text venues are a legacy relationship, so matching must stay conservative.
// Normalize case, whitespace, punctuation, and diacritics, but never perform
// substring matching or infer a venue from the event organizer.
function normalizeVenueIdentifier(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function venueLocationLabels(venue) {
  const seen = new Set();
  const labels = [];
  for (const candidate of [venue?.name, venue?.address]) {
    const label = String(candidate || "").trim();
    const normalized = normalizeVenueIdentifier(label);
    if (!label || !normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    labels.push(label);
  }
  return labels;
}

function venueLocationIdentifiers(venue) {
  return venueLocationLabels(venue).map(normalizeVenueIdentifier);
}

function matchesVenueLocation(location, identifiers) {
  const normalizedLocation = normalizeVenueIdentifier(location);
  return !!normalizedLocation && new Set(identifiers || []).has(normalizedLocation);
}

module.exports = {
  matchesVenueLocation,
  normalizeVenueIdentifier,
  venueLocationIdentifiers,
  venueLocationLabels,
};
