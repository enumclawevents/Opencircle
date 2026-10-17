"use strict";

const DEFAULT_TZ = "America/Los_Angeles";

const ALLOWED_CATEGORIES = [
  "Music",
  "Food & Drink",
  "Arts & Culture",
  "Games & Trivia",
  "Community",
  "Family & Kids",
  "Sports & Fitness",
  "Nightlife",
  "Markets & Shopping",
  "Classes & Workshops",
  "Outdoors",
  "Business & Networking",
  "Charity & Fundraising",
  "Seasonal & Holiday",
];

// Event categories are stored on events as display names. Keep that storage
// contract intact while exposing deterministic, URL-safe identifiers for API
// consumers such as community category landing pages.
function categorySlug(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const EVENT_CATEGORIES = Object.freeze(ALLOWED_CATEGORIES.map((name) => Object.freeze({
  name,
  slug: categorySlug(name),
  description: null,
})));

function findEventCategory(value) {
  const slug = categorySlug(value);
  if (!slug) return null;
  return EVENT_CATEGORIES.find((category) => category.slug === slug) || null;
}

const ALLOWED_VENUE_CATEGORIES = [
  "Bars & Breweries",
  "Restaurants & Cafés",
  "Wineries & Tasting Rooms",
  "Live Music Venues",
  "Theaters & Performance Spaces",
  "Event Centers & Banquet Halls",
  "Expo & Fairgrounds",
  "Community & Civic Spaces",
  "Parks & Outdoor Spaces",
  "Schools & Campus Venues",
  "Churches & Faith Centers",
  "Nonprofits & Community Orgs",
];

module.exports = {
  ALLOWED_CATEGORIES,
  EVENT_CATEGORIES,
  ALLOWED_VENUE_CATEGORIES,
  categorySlug,
  DEFAULT_TZ,
  findEventCategory,
};
