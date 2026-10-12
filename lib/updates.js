"use strict";

const { all, get, run, slugify } = require("../db");
const { DateTime } = require("luxon");

const DEFAULT_TIMEZONE = "America/Los_Angeles";
const DEFAULT_CATEGORIES = ["Community News", "Announcements", "Local Business", "Events & Festivals", "Community Stories", "Things to Do"];
const UPDATE_STATUSES = new Set(["draft", "scheduled", "published", "archived"]);
let schemaReady = false;

function communityTimezone(_city) {
  // Keep the fallback explicit until community-level timezone settings exist.
  return DEFAULT_TIMEZONE;
}

async function ensureUpdatesSchema() {
  if (schemaReady) return;
  await run(`CREATE TABLE IF NOT EXISTS update_categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL, name TEXT NOT NULL, slug TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')), updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(city, slug)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS updates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, city TEXT NOT NULL, title TEXT NOT NULL, slug TEXT NOT NULL,
    summary TEXT, bodyHtml TEXT NOT NULL DEFAULT '', featuredImageUrl TEXT, imageAlt TEXT,
    categoryId INTEGER, tagsJson TEXT, authorId INTEGER, status TEXT NOT NULL DEFAULT 'draft',
    seoTitle TEXT, metaDescription TEXT, createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')), publishedAt TEXT, scheduledFor TEXT,
    FOREIGN KEY(categoryId) REFERENCES update_categories(id), UNIQUE(city, slug)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS update_event_links (updateId INTEGER NOT NULL, eventId INTEGER NOT NULL, PRIMARY KEY(updateId, eventId))`);
  await run(`CREATE TABLE IF NOT EXISTS update_venue_links (updateId INTEGER NOT NULL, venueId INTEGER NOT NULL, PRIMARY KEY(updateId, venueId))`);
  await run(`CREATE TABLE IF NOT EXISTS update_metric_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, updateId INTEGER NOT NULL, occurredAt TEXT NOT NULL DEFAULT (datetime('now')),
    source TEXT, referrerHost TEXT, visitorKey TEXT
  )`);
  await run("CREATE INDEX IF NOT EXISTS idx_updates_public ON updates(city, status, publishedAt DESC, id DESC)");
  await run("CREATE INDEX IF NOT EXISTS idx_updates_category ON updates(city, categoryId, status, publishedAt DESC)");
  await run("CREATE INDEX IF NOT EXISTS idx_update_metrics_update_time ON update_metric_events(updateId, occurredAt DESC)");
  for (const city of ["Enumclaw", "Buckley", "Wilkeson", "Carbonado", "South Prairie"]) {
    for (const name of DEFAULT_CATEGORIES) {
      const slug = slugify(name);
      await run("INSERT OR IGNORE INTO update_categories (city, name, slug) VALUES (?, ?, ?)", [city, name, slug]);
    }
  }
  schemaReady = true;
}

async function categoriesForCity(city) {
  await ensureUpdatesSchema();
  return all("SELECT id, city, name, slug FROM update_categories WHERE city = ? ORDER BY lower(name), id", [city]);
}

async function ensureUniqueUpdateSlug(city, proposed, excludeId = null) {
  const base = slugify(proposed) || "community-update";
  let slug = base; let suffix = 2;
  while (true) {
    const row = await get(`SELECT id FROM updates WHERE city = ? AND slug = ? ${excludeId ? "AND id <> ?" : ""} LIMIT 1`, excludeId ? [city, slug, excludeId] : [city, slug]);
    if (!row) return slug;
    slug = `${base}-${suffix++}`;
  }
}

function sanitizeUpdateHtml(value) {
  const raw = String(value || "").replace(/\u0000/g, "").trim();
  // Small, deliberately restrictive server-side allowlist. Strip scripts, style blocks, event attributes and unsafe URLs.
  return raw
    .replace(/<\/?(?:script|style|iframe|object|embed|form|input|button)[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|src)\s*=\s*(?:"\s*javascript:[^"]*"|'\s*javascript:[^']*'|\s*javascript:[^\s>]+)/gi, "")
    .replace(/<(?!\/?(?:p|br|strong|b|em|i|a|ul|ol|li|h2|h3|h4|img)\b)[^>]*>/gi, "")
    .slice(0, 100000);
}

function normalizeTags(value) {
  return [...new Set(String(value || "").split(",").map((tag) => tag.trim()).filter(Boolean).map((tag) => tag.slice(0, 60)))].slice(0, 15);
}

function parseScheduleLocal(value, city) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const parsed = DateTime.fromISO(raw, { zone: communityTimezone(city) });
  if (!parsed.isValid) return null;
  return parsed.toUTC().toISO({ suppressMilliseconds: true });
}

async function publishDueUpdates(now = DateTime.utc().toISO({ suppressMilliseconds: true })) {
  await ensureUpdatesSchema();
  const result = await run(`UPDATE updates
    SET status = 'published', publishedAt = COALESCE(publishedAt, scheduledFor, ?), updatedAt = datetime('now')
    WHERE status = 'scheduled' AND scheduledFor IS NOT NULL AND scheduledFor <= ?`, [now, now]);
  return { published: result.changes || 0 };
}

function publicUpdateRow(row) {
  if (!row) return null;
  return {
    id: row.id, city: row.city, slug: row.slug, title: row.title, summary: row.summary || "", bodyHtml: row.bodyHtml || "",
    featuredImageUrl: row.featuredImageUrl || null, imageAlt: row.imageAlt || "", category: row.categoryName ? { name: row.categoryName, slug: row.categorySlug } : null,
    tags: safeJson(row.tagsJson, []), relatedEventIds: safeJson(row.relatedEventIds, []), relatedVenueIds: safeJson(row.relatedVenueIds, []),
    publishedAt: row.publishedAt, updatedAt: row.updatedAt, seo: { title: row.seoTitle || row.title, description: row.metaDescription || row.summary || "", canonicalUrl: null },
  };
}
function safeJson(value, fallback) { try { const parsed = JSON.parse(value || ""); return parsed == null ? fallback : parsed; } catch (_) { return fallback; } }

module.exports = { DEFAULT_TIMEZONE, UPDATE_STATUSES, categoriesForCity, communityTimezone, ensureUniqueUpdateSlug, ensureUpdatesSchema, normalizeTags, parseScheduleLocal, publishDueUpdates, publicUpdateRow, sanitizeUpdateHtml };
