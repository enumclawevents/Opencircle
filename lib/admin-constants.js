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
  ALLOWED_VENUE_CATEGORIES,
  DEFAULT_TZ,
};
