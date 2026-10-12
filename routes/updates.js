"use strict";
const express = require("express");
const crypto = require("crypto");
const { all, get, run } = require("../db");
const { buildSeoDescriptor, buildPublicUrl } = require("../lib/public-seo");
const { shouldTrackPublicView } = require("../lib/public-traffic");
const { ensureUpdatesSchema, publicUpdateRow } = require("../lib/updates");
const router = express.Router();
const viewBuckets = new Map();

function bad(res, message) { return res.status(400).json({ data: [], meta: { total: 0, limit: 0, offset: 0, hasMore: false, nextOffset: null }, error: message }); }
function cityValue(value) { const city = String(value || "").trim(); return city && city.length <= 100 ? city : ""; }
function baseSelect() { return `SELECT u.*, c.name AS categoryName, c.slug AS categorySlug,
  COALESCE((SELECT json_group_array(eventId) FROM update_event_links WHERE updateId = u.id), '[]') AS relatedEventIds,
  COALESCE((SELECT json_group_array(venueId) FROM update_venue_links WHERE updateId = u.id), '[]') AS relatedVenueIds FROM updates u LEFT JOIN update_categories c ON c.id = u.categoryId`; }

router.get("/sitemap.xml", async (req, res) => {
  await ensureUpdatesSchema();
  const canonicalBase = String(process.env.PUBLIC_UPDATES_CANONICAL_BASE_URL || "").replace(/\/$/, "");
  res.type("application/xml");
  if (!canonicalBase) return res.send('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>');
  const rows = await all("SELECT city, slug, updatedAt FROM updates WHERE status = 'published' AND publishedAt IS NOT NULL ORDER BY updatedAt DESC");
  const urls = rows.map((row) => `<url><loc>${escapeXml(`${canonicalBase}/updates/${encodeURIComponent(row.slug)}?city=${encodeURIComponent(row.city)}`)}</loc><lastmod>${escapeXml(row.updatedAt)}</lastmod></url>`).join("");
  res.send(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}</urlset>`);
});

router.get("/", async (req, res) => {
  await ensureUpdatesSchema();
  const city = cityValue(req.query.city); if (!city) return bad(res, "city is required.");
  const category = String(req.query.category || "").trim(); const q = String(req.query.q || "").trim();
  if (category.length > 120 || q.length > 200) return bad(res, "Invalid query parameter.");
  const limit = Number(req.query.limit || 20); const offset = Number(req.query.offset || 0);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) return bad(res, "Invalid pagination.");
  const where = ["u.city = ?", "u.status = 'published'", "u.publishedAt IS NOT NULL"]; const params = [city];
  if (category) { where.push("(c.slug = ? OR c.name = ?)"); params.push(category, category); }
  if (q) { where.push("(u.title LIKE ? ESCAPE '\\' OR u.summary LIKE ? ESCAPE '\\')"); const like = `%${q.replace(/[%_\\]/g, "\\$&")}%`; params.push(like, like); }
  const relatedEventId = Number(req.query.eventId || 0); if (relatedEventId) { where.push("EXISTS (SELECT 1 FROM update_event_links l WHERE l.updateId = u.id AND l.eventId = ?)"); params.push(relatedEventId); }
  const relatedVenueId = Number(req.query.venueId || 0); if (relatedVenueId) { where.push("EXISTS (SELECT 1 FROM update_venue_links l WHERE l.updateId = u.id AND l.venueId = ?)"); params.push(relatedVenueId); }
  const clause = where.join(" AND "); const count = await get(`SELECT COUNT(*) AS total FROM updates u LEFT JOIN update_categories c ON c.id=u.categoryId WHERE ${clause}`, params);
  const rows = await all(`${baseSelect()} WHERE ${clause} ORDER BY u.publishedAt DESC, u.id DESC LIMIT ? OFFSET ?`, [...params, limit, offset]); const total = Number(count?.total || 0);
  res.json({ data: rows.map(publicUpdateRow), meta: { total, limit, offset, hasMore: offset + rows.length < total, nextOffset: offset + rows.length < total ? offset + rows.length : null } });
});

router.post("/:id/view", express.json({ limit: "16kb" }), async (req, res) => {
  await ensureUpdatesSchema(); const id = Number(req.params.id); if (!Number.isSafeInteger(id) || id < 1) return res.status(400).json({ ok: false, error: "invalid_update" });
  const update = await get("SELECT id FROM updates WHERE id = ? AND status = 'published' AND publishedAt IS NOT NULL", [id]); if (!update) return res.status(404).json({ ok: false, error: "not_found" });
  if (!shouldTrackPublicView(req)) return res.json({ ok: true, tracked: false });
  const ip = String(req.ip || req.socket?.remoteAddress || ""); const key = crypto.createHash("sha256").update(`${ip}|${String(req.headers['user-agent'] || '')}`).digest("hex").slice(0, 32); const bucketKey = `${id}:${key}`; const now = Date.now();
  if (now - Number(viewBuckets.get(bucketKey) || 0) < 30 * 60 * 1000) return res.json({ ok: true, tracked: false });
  viewBuckets.set(bucketKey, now); const referrerHost = (() => { try { return new URL(String(req.headers.referer || "")).hostname.slice(0, 255); } catch (_) { return null; } })();
  await run("INSERT INTO update_metric_events (updateId, source, referrerHost, visitorKey) VALUES (?, ?, ?, ?)", [id, referrerHost ? "referral" : "direct", referrerHost, key]); res.json({ ok: true, tracked: true });
});

router.get("/:slug", async (req, res) => {
  await ensureUpdatesSchema(); const city = cityValue(req.query.city); if (!city) return res.status(400).json({ error: "city is required." });
  const slug = String(req.params.slug || "").trim(); if (!slug || slug.length > 180) return res.status(400).json({ error: "Invalid slug." });
  const row = await get(`${baseSelect()} WHERE u.city = ? AND u.slug = ? AND u.status = 'published' AND u.publishedAt IS NOT NULL LIMIT 1`, [city, slug]); if (!row) return res.status(404).json({ error: "Update not found." });
  const data = publicUpdateRow(row); const canonicalBase = String(process.env.PUBLIC_UPDATES_CANONICAL_BASE_URL || "").replace(/\/$/, "");
  if (canonicalBase) data.seo.canonicalUrl = `${canonicalBase}/updates/${encodeURIComponent(slug)}?city=${encodeURIComponent(city)}`;
  data.structuredData = { "@context": "https://schema.org", "@type": "Article", headline: data.title, description: data.seo.description, datePublished: data.publishedAt, dateModified: data.updatedAt, image: data.featuredImageUrl ? [data.featuredImageUrl] : undefined, url: data.seo.canonicalUrl || undefined };
  res.json({ data });
});
function escapeXml(value) { return String(value || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;").replace(/'/g,"&apos;"); }
module.exports = router;
