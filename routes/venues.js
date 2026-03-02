"use strict";

const express = require("express");
const router = express.Router();
const { all, get, run } = require("../db");

let _schemaEnsured = false;
let _colsCache = null;

function safeParseJson(v, fallback) {
  try {
    const out = typeof v === "string" ? JSON.parse(v) : v;
    return out == null ? fallback : out;
  } catch (_) {
    return fallback;
  }
}

function normalizeVenueCategories(input) {
  const out = [];
  const seen = {};
  const arr = Array.isArray(input) ? input : [];
  for (const item of arr) {
    const v = String(item || "").trim();
    if (!v) continue;
    const k = v.toLowerCase();
    if (seen[k]) continue;
    seen[k] = true;
    out.push(v);
  }
  return out;
}

function normalizeGalleryImages(input, max = 3) {
  const out = [];
  const seen = new Set();
  const arr = Array.isArray(input) ? input : [input];
  for (const item of arr) {
    const u = normalizeHttpUrl(item);
    if (!u) continue;
    const k = u.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

function normalizeHttpUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^(none|null|undefined)$/i.test(raw)) return "";

  let out = raw;
  if (out.startsWith("//")) out = "https:" + out;
  else if (!/^https?:\/\//i.test(out) && /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[\/:?#].*)?$/i.test(out)) out = "https://" + out;

  out = out.replace(/^http:\/\//i, "https://");

  try {
    const u = new URL(out);
    if (!/^https?:$/i.test(u.protocol)) return "";
    return u.toString();
  } catch (_) {
    return "";
  }
}

async function getVenueColumns() {
  if (_colsCache) return _colsCache;
  try {
    const rows = await all("PRAGMA table_info(venues)");
    _colsCache = new Set((rows || []).map((r) => String(r.name)));
    return _colsCache;
  } catch (_) {
    _colsCache = new Set();
    return _colsCache;
  }
}

async function ensureVenueSchema() {
  if (_schemaEnsured) return;

  await run(`
    CREATE TABLE IF NOT EXISTS venues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL DEFAULT 'Enumclaw',
      slug TEXT,
      name TEXT NOT NULL,
      address TEXT,
      website TEXT,
      phone TEXT,
      description TEXT,
      galleryJson TEXT,
      viewCount INTEGER NOT NULL DEFAULT 0,
      phoneClickCount INTEGER NOT NULL DEFAULT 0,
      websiteClickCount INTEGER NOT NULL DEFAULT 0,
      socialClickCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);

  const cols = await getVenueColumns();
  const migrations = [
    ["hoursJson", "ALTER TABLE venues ADD COLUMN hoursJson TEXT"],
    ["categoriesJson", "ALTER TABLE venues ADD COLUMN categoriesJson TEXT"],
    ["socialJson", "ALTER TABLE venues ADD COLUMN socialJson TEXT"],
    ["imageUrl", "ALTER TABLE venues ADD COLUMN imageUrl TEXT"],
    ["seoTitle", "ALTER TABLE venues ADD COLUMN seoTitle TEXT"],
    ["metaDescription", "ALTER TABLE venues ADD COLUMN metaDescription TEXT"],
    ["focusKeyphrase", "ALTER TABLE venues ADD COLUMN focusKeyphrase TEXT"],
    ["imageAlt", "ALTER TABLE venues ADD COLUMN imageAlt TEXT"],
    ["galleryJson", "ALTER TABLE venues ADD COLUMN galleryJson TEXT"],
    ["viewCount", "ALTER TABLE venues ADD COLUMN viewCount INTEGER NOT NULL DEFAULT 0"],
    ["phoneClickCount", "ALTER TABLE venues ADD COLUMN phoneClickCount INTEGER NOT NULL DEFAULT 0"],
    ["websiteClickCount", "ALTER TABLE venues ADD COLUMN websiteClickCount INTEGER NOT NULL DEFAULT 0"],
    ["socialClickCount", "ALTER TABLE venues ADD COLUMN socialClickCount INTEGER NOT NULL DEFAULT 0"],
  ];

  for (const [name, sql] of migrations) {
    if (!cols.has(name)) {
      await run(sql);
    }
  }

  _colsCache = null;
  _schemaEnsured = true;
}

function mapVenueRow(r) {
  const cats = normalizeVenueCategories(safeParseJson(r.categoriesJson, []));
  const social = safeParseJson(r.socialJson, {});
  const hours = safeParseJson(r.hoursJson, {});
  const galleryImages = normalizeGalleryImages(safeParseJson(r.galleryJson, []), 3);
  return {
    id: Number(r.id || 0),
    city: String(r.city || ""),
    slug: String(r.slug || ""),
    name: String(r.name || ""),
    address: String(r.address || ""),
    website: normalizeHttpUrl(r.website || ""),
    phone: String(r.phone || ""),
    description: String(r.description || ""),
    imageUrl: String(r.imageUrl || ""),
    galleryImages,
    categories: cats,
    social,
    hours,
    seoTitle: String(r.seoTitle || ""),
    metaDescription: String(r.metaDescription || ""),
    focusKeyphrase: String(r.focusKeyphrase || ""),
    imageAlt: String(r.imageAlt || ""),
    viewCount: Number(r.viewCount || 0),
    phoneClickCount: Number(r.phoneClickCount || 0),
    websiteClickCount: Number(r.websiteClickCount || 0),
    socialClickCount: Number(r.socialClickCount || 0),
    createdAt: r.createdAt || null,
    updatedAt: r.updatedAt || null,
  };
}

async function incrementVenueCounter(venueId, field) {
  const id = Number(venueId || 0);
  if (!Number.isInteger(id) || id <= 0) return;

  const allowed = new Set(["viewCount", "phoneClickCount", "websiteClickCount", "socialClickCount"]);
  if (!allowed.has(String(field || ""))) return;

  try {
    await run(
      `UPDATE venues
          SET ${field} = COALESCE(${field}, 0) + 1,
              updatedAt = datetime('now')
        WHERE id = ?`,
      [id]
    );
  } catch (_) {}
}

async function incrementVenueView(venueId) {
  await incrementVenueCounter(venueId, "viewCount");
}

async function getVenueRowByIdOrSlug(idOrSlug) {
  const raw = String(idOrSlug || "").trim();
  if (!raw) return null;

  const asId = Number(raw);
  const isId = Number.isInteger(asId) && asId > 0;

  return isId
    ? await get("SELECT * FROM venues WHERE id = ? LIMIT 1", [asId])
    : await get("SELECT * FROM venues WHERE LOWER(slug) = LOWER(?) LIMIT 1", [raw]);
}

function normalizeSocialPlatform(input) {
  const k = String(input || "").trim().toLowerCase();
  if (k === "twitter") return "x";
  return k;
}

function dedupeByKey(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows || []) {
    const key = String(r.slug || r.id || "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

async function getUpcomingEventsForVenue(venue, limit) {
  const lim = Math.max(1, Math.min(50, parseInt(String(limit || 12), 10) || 12));
  const city = String(venue.city || "").trim();
  const name = String(venue.name || "").trim();
  const address = String(venue.address || "").trim();
  const needles = [name, address].map((s) => s.toLowerCase()).filter(Boolean);
  if (!city || !needles.length) return [];

  const rows = await all(
    `SELECT id, slug, title, startDateTime, endDateTime, location, imageUrl, categories, archived
       FROM events
      WHERE LOWER(city) = LOWER(?)
        AND COALESCE(archived, 0) = 0
      ORDER BY datetime(startDateTime) ASC`,
    [city]
  );

  const nowTs = Date.now() - 5 * 60 * 1000;
  const out = [];
  for (const r of rows || []) {
    const loc = String(r.location || "").trim().toLowerCase();
    if (!loc) continue;
    const match = needles.some((n) => loc === n || loc.includes(n) || n.includes(loc));
    if (!match) continue;

    const st = Date.parse(String(r.startDateTime || ""));
    const en = Date.parse(String(r.endDateTime || ""));
    const effectiveEnd = Number.isFinite(en) ? en : st;
    if (!Number.isFinite(effectiveEnd) || effectiveEnd < nowTs) continue;

    out.push({
      id: Number(r.id || 0),
      slug: String(r.slug || ""),
      title: String(r.title || ""),
      startDateTime: String(r.startDateTime || ""),
      endDateTime: String(r.endDateTime || ""),
      location: String(r.location || ""),
      imageUrl: String(r.imageUrl || ""),
      categories: Array.isArray(safeParseJson(r.categories, [])) ? safeParseJson(r.categories, []) : [],
    });
  }

  out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
  return dedupeByKey(out).slice(0, lim);
}

router.get("/", async (req, res) => {
  try {
    await ensureVenueSchema();

    const city = String(req.query.city || "").trim();
    const q = String(req.query.q || "").trim();
    const limit = Math.max(1, Math.min(100, parseInt(String(req.query.limit || "50"), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset || "0"), 10) || 0);
    const includeUpcoming = String(req.query.includeUpcoming || "0") === "1";
    const upcomingLimit = Math.max(1, Math.min(24, parseInt(String(req.query.upcomingLimit || "6"), 10) || 6));

    const where = [];
    const params = [];

    if (city) {
      where.push("LOWER(city) = LOWER(?)");
      params.push(city);
    }
    if (q) {
      where.push("(name LIKE ? OR slug LIKE ? OR address LIKE ?)");
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const totalRow = await get(`SELECT COUNT(*) AS n FROM venues ${whereSql}`, params);
    const rows = await all(
      `SELECT * FROM venues ${whereSql} ORDER BY name ASC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    const mapped = [];
    for (const r of rows || []) {
      const v = mapVenueRow(r);
      if (includeUpcoming) {
        v.upcomingEvents = await getUpcomingEventsForVenue(v, upcomingLimit);
      }
      mapped.push(v);
    }

    return res.json({
      data: mapped,
      meta: {
        total: Number(totalRow && totalRow.n ? totalRow.n : 0),
        limit,
        offset,
        hasMore: offset + mapped.length < Number(totalRow && totalRow.n ? totalRow.n : 0),
        nextOffset: offset + mapped.length < Number(totalRow && totalRow.n ? totalRow.n : 0) ? offset + mapped.length : null,
      },
    });
  } catch (err) {
    console.error("[/venues] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/resolve", async (req, res) => {
  try {
    await ensureVenueSchema();

    const q = String(req.query.q || "").trim();
    const city = String(req.query.city || "").trim();
    if (!q) return res.status(400).json({ error: "Missing q" });

    const qLower = q.toLowerCase();
    const whereCity = city ? "AND LOWER(city) = LOWER(?)" : "";
    const cityParams = city ? [city] : [];

    const exact = await get(
      `SELECT * FROM venues
        WHERE (LOWER(name) = LOWER(?) OR LOWER(address) = LOWER(?) OR LOWER(slug) = LOWER(?))
        ${whereCity}
        LIMIT 1`,
      [q, q, q, ...cityParams]
    );
    if (exact) return res.json({ data: mapVenueRow(exact) });

    const like = `%${q}%`;
    const rows = await all(
      `SELECT * FROM venues
        WHERE (name LIKE ? OR address LIKE ? OR slug LIKE ?)
        ${whereCity}
        ORDER BY
          CASE
            WHEN LOWER(name) LIKE LOWER(?) THEN 0
            WHEN LOWER(address) LIKE LOWER(?) THEN 1
            ELSE 2
          END,
          name ASC
        LIMIT 20`,
      [like, like, like, `${qLower}%`, `${qLower}%`, ...cityParams]
    );

    const best = (rows || [])[0] || null;
    if (!best) return res.status(404).json({ error: "Venue not found" });

    return res.json({ data: mapVenueRow(best) });
  } catch (err) {
    console.error("[/venues/resolve] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/slug/:slug", async (req, res) => {
  try {
    await ensureVenueSchema();

    const slug = String(req.params.slug || "").trim().toLowerCase();
    if (!slug) return res.status(400).json({ error: "Invalid slug" });

    const row = await get("SELECT * FROM venues WHERE LOWER(slug) = LOWER(?) LIMIT 1", [slug]);
    if (!row) return res.status(404).json({ error: "Venue not found" });

    const shouldTrack = String(req.query.track || "1") !== "0";
    if (shouldTrack) {
      await incrementVenueView(row.id);
      row.viewCount = Number(row.viewCount || 0) + 1;
    }

    const venue = mapVenueRow(row);
    const upcomingLimit = Math.max(1, Math.min(24, parseInt(String(req.query.upcomingLimit || "12"), 10) || 12));
    venue.upcomingEvents = await getUpcomingEventsForVenue(venue, upcomingLimit);

    return res.json({ data: venue });
  } catch (err) {
    console.error("[/venues/slug/:slug] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Server error" });
  }
});

router.get("/:idOrSlug/out/phone", async (req, res) => {
  try {
    await ensureVenueSchema();

    const row = await getVenueRowByIdOrSlug(req.params.idOrSlug);
    if (!row) return res.status(404).send("Venue not found");

    const phoneRaw = String(row.phone || "").trim();
    if (!phoneRaw) return res.status(404).send("Phone not available");

    const digits = phoneRaw.replace(/\D+/g, "");
    const tel = digits ? `tel:${digits}` : `tel:${phoneRaw}`;

    await incrementVenueCounter(row.id, "phoneClickCount");
    return res.redirect(302, tel);
  } catch (err) {
    console.error("[/venues/:idOrSlug/out/phone] error:", err && err.stack ? err.stack : err);
    return res.status(500).send("Server error");
  }
});

router.get("/:idOrSlug/out/website", async (req, res) => {
  try {
    await ensureVenueSchema();

    const row = await getVenueRowByIdOrSlug(req.params.idOrSlug);
    if (!row) return res.status(404).send("Venue not found");

    const website = normalizeHttpUrl(row.website || "");
    if (!website) return res.status(404).send("Website not available");

    await incrementVenueCounter(row.id, "websiteClickCount");
    return res.redirect(302, website);
  } catch (err) {
    console.error("[/venues/:idOrSlug/out/website] error:", err && err.stack ? err.stack : err);
    return res.status(500).send("Server error");
  }
});

router.get("/:idOrSlug/out/social/:platform", async (req, res) => {
  try {
    await ensureVenueSchema();

    const row = await getVenueRowByIdOrSlug(req.params.idOrSlug);
    if (!row) return res.status(404).send("Venue not found");

    const social = safeParseJson(row.socialJson, {});
    const platform = normalizeSocialPlatform(req.params.platform);
    const allowed = new Set(["facebook", "instagram", "x", "tiktok", "youtube", "linkedin"]);
    if (!allowed.has(platform)) return res.status(404).send("Social platform not supported");

    const socialUrl = normalizeHttpUrl((social && typeof social === "object") ? social[platform] : "");
    if (!socialUrl) return res.status(404).send("Social link not available");

    await incrementVenueCounter(row.id, "socialClickCount");
    return res.redirect(302, socialUrl);
  } catch (err) {
    console.error("[/venues/:idOrSlug/out/social/:platform] error:", err && err.stack ? err.stack : err);
    return res.status(500).send("Server error");
  }
});

router.get("/:idOrSlug", async (req, res) => {
  try {
    await ensureVenueSchema();

    const raw = String(req.params.idOrSlug || "").trim();
    if (!raw) return res.status(400).json({ error: "Missing id/slug" });

    const row = await getVenueRowByIdOrSlug(raw);

    if (!row) return res.status(404).json({ error: "Venue not found" });

    const shouldTrack = String(req.query.track || "1") !== "0";
    if (shouldTrack) {
      await incrementVenueView(row.id);
      row.viewCount = Number(row.viewCount || 0) + 1;
    }

    const venue = mapVenueRow(row);
    const upcomingLimit = Math.max(1, Math.min(24, parseInt(String(req.query.upcomingLimit || "12"), 10) || 12));
    venue.upcomingEvents = await getUpcomingEventsForVenue(venue, upcomingLimit);

    return res.json({ data: venue });
  } catch (err) {
    console.error("[/venues/:idOrSlug] error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ error: "Server error" });
  }
});

module.exports = router;
