"use strict";

const { all, get } = require("../db");
const { normalizeVenueName } = require("./event-input");

async function resolveEventVenue(city, nameInput, idInput) {
  const name = normalizeVenueName(nameInput);
  const hasId = idInput != null && idInput !== "";
  if (!hasId && !name) return { venueName: null, venueId: null };

  const venueCity = city === "Plateau Area" ? "Buckley" : city;
  if (hasId && (
    !["string", "number"].includes(typeof idInput) || !/^[1-9]\d{0,14}$/.test(String(idInput))
  )) return null;
  // Venue tables are initialized lazily. Submissions can run before any venue page.
  if (await get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'venues'")) {
    const rows = await all(
      `SELECT id, name FROM venues WHERE LOWER(city) = LOWER(?) AND ${hasId ? "id = ?" : "LOWER(TRIM(name)) = LOWER(?)"} LIMIT 2`,
      [venueCity, hasId ? Number(idInput) : name]
    );
    if (rows.length === 1) return { venueName: rows[0].name, venueId: rows[0].id };
  }
  return hasId ? null : { venueName: name, venueId: null };
}

module.exports = { resolveEventVenue };
