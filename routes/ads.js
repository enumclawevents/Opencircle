"use strict";

const express = require("express");
const router = express.Router();
const { all, get, run } = require("../db");

let _schemaEnsured = false;
let _colsCache = null;

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

function safeParseJson(val, fallback) {
  if (val === null || val === undefined || val === "") return fallback;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch (_) {
    return fallback;
  }
}

function normalizeAdPlacements(input, fallbackPlacement = "") {
  const allowed = new Set([
    "homepage-top",
    "homepage-bottom",
    "events-top",
    "events-bottom",
    "venues-top",
    "single-event-main",
    "single-event-side",
  ]);
  const rawItems = Array.isArray(input) ? input : [input];
  const parsedJson = !Array.isArray(input) && typeof input === "string" ? safeParseJson(input, null) : null;
  const source = Array.isArray(parsedJson) ? [...rawItems, ...parsedJson] : rawItems;
  if (fallbackPlacement) source.push(fallbackPlacement);

  const out = [];
  const seen = new Set();
  for (const item of source) {
    const v = String(item || "").trim();
    if (!v || seen.has(v)) continue;
    if (allowed.has(v) || v === fallbackPlacement) {
      out.push(v);
      seen.add(v);
    }
  }
  return out;
}

async function getAdColumns() {
  if (_colsCache) return _colsCache;
  try {
    const rows = await all("PRAGMA table_info(ads)");
    _colsCache = new Set((rows || []).map((r) => String(r.name)));
    return _colsCache;
  } catch (_) {
    _colsCache = new Set();
    return _colsCache;
  }
}

async function ensureAdSchema() {
  if (_schemaEnsured) return;

  await run(`
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL DEFAULT 'Enumclaw',
      slug TEXT,
      name TEXT NOT NULL,
      placement TEXT NOT NULL DEFAULT 'default',
      placementsJson TEXT,
      imageUrl TEXT,
      targetUrl TEXT,
      altText TEXT,
      visibilityPercent REAL NOT NULL DEFAULT 100,
      status TEXT NOT NULL DEFAULT 'active',
      startsAt TEXT,
      endsAt TEXT,
      notes TEXT,
      viewCount INTEGER NOT NULL DEFAULT 0,
      clickCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);

  const cols = await getAdColumns();
  const migrations = [
    ["city", "ALTER TABLE ads ADD COLUMN city TEXT NOT NULL DEFAULT 'Enumclaw'"],
    ["slug", "ALTER TABLE ads ADD COLUMN slug TEXT"],
    ["placement", "ALTER TABLE ads ADD COLUMN placement TEXT NOT NULL DEFAULT 'default'"],
    ["placementsJson", "ALTER TABLE ads ADD COLUMN placementsJson TEXT"],
    ["imageUrl", "ALTER TABLE ads ADD COLUMN imageUrl TEXT"],
    ["targetUrl", "ALTER TABLE ads ADD COLUMN targetUrl TEXT"],
    ["altText", "ALTER TABLE ads ADD COLUMN altText TEXT"],
    ["visibilityPercent", "ALTER TABLE ads ADD COLUMN visibilityPercent REAL NOT NULL DEFAULT 100"],
    ["status", "ALTER TABLE ads ADD COLUMN status TEXT NOT NULL DEFAULT 'active'"],
    ["startsAt", "ALTER TABLE ads ADD COLUMN startsAt TEXT"],
    ["endsAt", "ALTER TABLE ads ADD COLUMN endsAt TEXT"],
    ["notes", "ALTER TABLE ads ADD COLUMN notes TEXT"],
    ["viewCount", "ALTER TABLE ads ADD COLUMN viewCount INTEGER NOT NULL DEFAULT 0"],
    ["clickCount", "ALTER TABLE ads ADD COLUMN clickCount INTEGER NOT NULL DEFAULT 0"],
    ["createdAt", "ALTER TABLE ads ADD COLUMN createdAt TEXT DEFAULT (datetime('now'))"],
    ["updatedAt", "ALTER TABLE ads ADD COLUMN updatedAt TEXT DEFAULT (datetime('now'))"],
  ];

  for (const [name, sql] of migrations) {
    if (!cols.has(name)) await run(sql);
  }

  await run(`
    CREATE TABLE IF NOT EXISTS ad_metric_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adId INTEGER NOT NULL,
      metric TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_ads_city ON ads(city)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ads_slug ON ads(slug)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ads_placement ON ads(placement)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(status)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ad_metric_events_adId ON ad_metric_events(adId)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ad_metric_events_metric ON ad_metric_events(metric)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ad_metric_events_createdAt ON ad_metric_events(createdAt)`);
  } catch (_) {}

  _colsCache = null;
  _schemaEnsured = true;
}

async function incrementAdMetric(adId, metric) {
  const id = Number(adId || 0);
  if (!Number.isInteger(id) || id <= 0) return;
  if (!["view", "click"].includes(String(metric || ""))) return;
  const field = metric === "click" ? "clickCount" : "viewCount";
  try {
    await run(
      `UPDATE ads
          SET ${field} = COALESCE(${field}, 0) + 1,
              updatedAt = datetime('now')
        WHERE id = ?`,
      [id]
    );
    await run("INSERT INTO ad_metric_events (adId, metric) VALUES (?, ?)", [id, metric]);
  } catch (_) {}
}

function buildAdPayload(req, row) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const baseUrl = `${proto}://${host}`;
  const placements = normalizeAdPlacements(row.placementsJson, row.placement || "");
  return {
    id: Number(row.id || 0),
    city: String(row.city || ""),
    slug: String(row.slug || ""),
    name: String(row.name || ""),
    placement: String(placements[0] || row.placement || "default"),
    placements,
    imageUrl: String(row.imageUrl || ""),
    altText: String(row.altText || row.name || ""),
    targetUrl: normalizeHttpUrl(row.targetUrl || ""),
    visibilityPercent: Number(row.visibilityPercent || 0),
    clickUrl: `${baseUrl}/ads/${encodeURIComponent(String(row.id || ""))}/click`,
    viewCount: Number(row.viewCount || 0),
    clickCount: Number(row.clickCount || 0),
  };
}

router.get("/serve", async (req, res) => {
  try {
    await ensureAdSchema();

    const city = String(req.query.city || "").trim();
    const placement = String(req.query.placement || "default").trim() || "default";
    const where = [
      "lower(COALESCE(status, 'active')) = 'active'",
      "(startsAt IS NULL OR trim(startsAt) = '' OR datetime(startsAt) <= datetime('now'))",
      "(endsAt IS NULL OR trim(endsAt) = '' OR datetime(endsAt) >= datetime('now'))",
      "COALESCE(visibilityPercent, 0) > 0",
    ];
    const params = [];
    if (city) {
      where.push("city = ?");
      params.push(city);
    }

    const rows = await all(
      "SELECT id, city, slug, name, placement, placementsJson, imageUrl, targetUrl, altText, visibilityPercent, viewCount, clickCount " +
      "FROM ads WHERE " + where.join(" AND ") + " ORDER BY id ASC",
      params
    );
    const ads = (rows || []).map((row) => ({
      ...row,
      placements: normalizeAdPlacements(row.placementsJson, row.placement || ""),
      visibilityPercent: Math.max(0, Math.min(100, Number(row.visibilityPercent || 0))),
    })).filter((row) => row.placements.includes(placement));

    if (!ads.length) {
      return res.json({ ok: true, data: null });
    }

    const totalVisibility = ads.reduce((sum, ad) => sum + Number(ad.visibilityPercent || 0), 0);
    let chosen = null;
    if (totalVisibility > 0 && totalVisibility <= 100) {
      let roll = Math.random() * 100;
      if (roll < totalVisibility) {
        for (const ad of ads) {
          roll -= Number(ad.visibilityPercent || 0);
          if (roll < 0) {
            chosen = ad;
            break;
          }
        }
      }
    } else if (totalVisibility > 100) {
      let roll = Math.random() * totalVisibility;
      for (const ad of ads) {
        roll -= Number(ad.visibilityPercent || 0);
        if (roll < 0) {
          chosen = ad;
          break;
        }
      }
    }

    if (!chosen) {
      return res.json({ ok: true, data: null });
    }

    await incrementAdMetric(chosen.id, "view");
    return res.json({ ok: true, data: buildAdPayload(req, chosen) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to serve ad." });
  }
});

router.get("/:id/click", async (req, res) => {
  try {
    await ensureAdSchema();
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ad ID.");

    const row = await get("SELECT id, targetUrl FROM ads WHERE id = ? LIMIT 1", [id]);
    const targetUrl = normalizeHttpUrl(row?.targetUrl || "");
    if (!row || !targetUrl) return res.status(404).send("Ad not found.");

    await incrementAdMetric(id, "click");
    return res.redirect(targetUrl);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to track ad click.");
  }
});

module.exports = router;
