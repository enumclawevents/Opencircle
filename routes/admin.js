"use strict";

const express = require("express");
const router = express.Router();
const { run, all, get, slugify, ensureUniqueSlug, DB_PATH } = require("../db");
const path = require("path");
const fs = require("fs");
const { execSync } = require("child_process");
const multer = require("multer");
const { S3Client } = require("@aws-sdk/client-s3");
const multerS3 = require("multer-s3");
const { sendEmail } = require("../mailer");
const crypto = require("crypto");
const PASSWORD_ITER = 120000;

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(String(password || ""), salt, PASSWORD_ITER, 32, "sha256")
    .toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored || "").split(":");
  if (!salt || !hash) return false;
  const test = crypto
    .pbkdf2Sync(String(password || ""), salt, PASSWORD_ITER, 32, "sha256")
    .toString("hex");
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(test, "hex"));
  } catch {
    return false;
  }
}

/**
 * Fixed category list (12 total)
 * Admin must choose from these; max 3 per event.
 */
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

// --- Uploads (R2 preferred; fallback to local disk) ---
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "";

const useR2 =
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_URL;

const UPLOAD_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.RENDER_DISK_PATH
    ? path.join(process.env.RENDER_DISK_PATH, "uploads")
    : path.join(process.cwd(), "uploads"));

if (!useR2) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

const r2Client = useR2
  ? new S3Client({
      region: "auto",
      endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: R2_ACCESS_KEY_ID,
        secretAccessKey: R2_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    })
  : null;

function buildUploadKey(file) {
  const ext = path.extname(file.originalname || "").toLowerCase() || ".jpg";
  const base = path
    .basename(file.originalname || "image", ext)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const stamp = Date.now();
  return `${base || "event"}-${stamp}${ext}`;
}

const storage = useR2
  ? multerS3({
      s3: r2Client,
      bucket: R2_BUCKET,
      contentType: multerS3.AUTO_CONTENT_TYPE,
      key: (req, file, cb) => cb(null, buildUploadKey(file)),
    })
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, UPLOAD_DIR),
      filename: (req, file, cb) => cb(null, buildUploadKey(file)),
    });

function fileFilter(req, file, cb) {
  const ok = /^image\/(jpeg|jpg|png|webp|gif)$/i.test(file.mimetype || "");
  cb(ok ? null : new Error("Only image files are allowed."), ok);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB
});

function normalizeCategories(input) {
  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === "string" && input.trim() !== "") arr = [input.trim()];

  const uniq = [];
  for (const c of arr) {
    const v = String(c || "").trim();
    if (!v) continue;
    if (!ALLOWED_CATEGORIES.includes(v)) continue;
    if (!uniq.includes(v)) uniq.push(v);
    if (uniq.length >= 3) break;
  }
  return uniq;
}

function normalizeVenueCategories(input) {
  const arr = Array.isArray(input) ? input : [input];
  const uniq = [];
  for (const c of arr) {
    const v = String(c || "").trim();
    if (!v) continue;
    if (!ALLOWED_VENUE_CATEGORIES.includes(v)) continue;
    if (!uniq.includes(v)) uniq.push(v);
    if (uniq.length >= 3) break;
  }
  return uniq;
}

function normalizeGalleryImages(input, max = 3) {
  const arr = Array.isArray(input) ? input : [input];
  const uniq = [];
  const seen = new Set();
  for (const item of arr) {
    const url = normalizeHttpUrl(item);
    if (!url) continue;
    const key = url.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(url);
    if (uniq.length >= max) break;
  }
  return uniq;
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

function safeParseJson(val, fallback) {
  if (val === null || val === undefined || val === "") return fallback;
  if (typeof val === "object") return val;
  try {
    return JSON.parse(val);
  } catch {
    return fallback;
  }
}

function extractPlainUrl(str) {
  const s = String(str || "").trim();
  if (!s) return "";
  const paren = s.match(/\((https?:\/\/[^)]+)\)/i);
  if (paren && paren[1]) return paren[1];
  const raw = s.match(/https?:\/\/[^\s)]+/i);
  return raw ? raw[0] : "";
}

function stripHtml(str) {
  return String(str || "").replace(/<[^>]*>/g, "").trim();
}

function mapCategoriesFromJson(input) {
  const map = {
    family: "Family & Kids",
    kids: "Family & Kids",
    workshop: "Classes & Workshops",
    classes: "Classes & Workshops",
    food: "Food & Drink",
    drink: "Food & Drink",
    art: "Arts & Culture",
    arts: "Arts & Culture",
    market: "Markets & Shopping",
    shopping: "Markets & Shopping",
    nightlife: "Nightlife",
    music: "Music",
    community: "Community",
    sports: "Sports & Fitness",
    outdoors: "Outdoors",
    business: "Business & Networking",
    charity: "Charity & Fundraising",
    seasonal: "Seasonal & Holiday",
  };

  let arr = [];
  if (Array.isArray(input)) arr = input;
  else if (typeof input === "string" && input.trim() !== "") arr = [input.trim()];

  const out = [];
  for (const raw of arr) {
    const key = String(raw || "").trim().toLowerCase();
    if (!key) continue;
    const mapped = map[key] || raw;
    out.push(mapped);
  }
  return out;
}

function mapLocationFromJson(j) {
  const venue = String(j.venue_name || "").trim();
  if (venue) return venue;
  const loc = String(j.location_name || "").trim();
  if (loc) return loc;

  const addr1 = String(j.address_line1 || "").trim();
  const city = String(j.city || "").trim();
  const state = String(j.state || "").trim();
  const zip = String(j.postal_code || "").trim();

  const parts = [];
  if (addr1) parts.push(addr1);
  let cityLine = "";
  if (city) cityLine += city;
  if (state) cityLine += (cityLine ? ", " : "") + state;
  if (zip) cityLine += (cityLine ? " " : "") + zip;
  if (cityLine) parts.push(cityLine);
  return parts.join(", ");
}

function parseStoredCategories(stored) {
  const parsed = safeParseJson(stored, null);
  if (Array.isArray(parsed)) return parsed;
  if (!stored) return [];
  return String(stored)
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseStoredDates(stored) {
  const parsed = safeParseJson(stored, null);
  if (Array.isArray(parsed)) return parsed;
  return [];
}

function parseStoredRule(stored) {
  const parsed = safeParseJson(stored, null);
  if (parsed && typeof parsed === "object") return parsed;
  return null;
}

// Convert datetime-local (no timezone) into ISO with local timezone offset
function toLocalISOWithOffset(dtLocal) {
  const d = new Date(dtLocal);
  if (isNaN(d.getTime())) return null;

  const pad = (n) => String(n).padStart(2, "0");

  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = "00";

  const offsetMin = -d.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  const offH = pad(Math.floor(abs / 60));
  const offM = pad(abs % 60);

  return `${year}-${month}-${day}T${hours}:${minutes}:${seconds}${sign}${offH}:${offM}`;
}

function toDateTimeLocalValue(isoWithOffset) {
  if (!isoWithOffset) return "";
  return String(isoWithOffset).slice(0, 16);
}

function toDateValue(isoWithOffset) {
  if (!isoWithOffset) return "";
  return String(isoWithOffset).slice(0, 10); // YYYY-MM-DD
}

function addHoursIso(iso, hours) {
  try {
    const d = new Date(String(iso));
    if (Number.isNaN(d.getTime())) return iso;
    d.setHours(d.getHours() + hours);
    return d.toISOString();
  } catch {
    return iso;
  }
}

async function insertEventFromPending(p) {
  if (!p) return null;
  const cols = await getEventsColumns();

  const title = String(p.title || "").trim();
  if (!title) return null;

  const baseSlug = slugify(title);
  const slug = await ensureUniqueSlug(baseSlug, null);

  let startDateTime = String(p.startDateTime || "").trim();
  let endDateTime = String(p.endDateTime || "").trim();

  const startMs = Date.parse(startDateTime);
  let endMs = Date.parse(endDateTime);
  if (!Number.isFinite(startMs)) return null;
  if (!Number.isFinite(endMs) || endMs <= startMs) {
    endDateTime = addHoursIso(startDateTime, 1);
    endMs = Date.parse(endDateTime);
  }

  const cats = normalizeCategories(parseStoredCategories(p.categories));
  const catsJson = JSON.stringify(cats);

  const finalTicketLabel =
    p.ticketLabel && String(p.ticketLabel).trim()
      ? String(p.ticketLabel).trim()
      : "Tickets";

  const computedFeaturedUntil = String(p.featuredUntil || p.endDateTime || p.startDateTime || "").trim();
  const hasFeaturedOrder = String(p.featuredOrderId || "").trim() !== "";
  const featuredActive = hasFeaturedOrder && computedFeaturedUntil
    ? (Date.parse(computedFeaturedUntil) > Date.now())
    : false;

  const fields = [
    ["city", String(p.city || "Enumclaw")],
    ["slug", slug],
    ["title", title],
    ["description", String(p.description || "")],
    ["eventDetails", String(p.eventDetails || "")],
    ["goodToKnow", String(p.goodToKnow || "")],
    ["startDateTime", startDateTime],
    ["endDateTime", endDateTime],
    ["location", String(p.location || "")],
    ["organizer", String(p.organizer || "")],
    ["imageUrl", String(p.imageUrl || "") || null],
    ["ticketUrl", String(p.ticketUrl || "") || null],
    ["ticketLabel", finalTicketLabel],
    ["categories", catsJson],
    ["featured", featuredActive ? 1 : 0],
    ["eddiesPick", 0],
    ["seoTitle", String(p.seoTitle || "")],
    ["metaDescription", String(p.metaDescription || "")],
    ["focusKeyphrase", String(p.focusKeyphrase || "")],
    ["imageAlt", String(p.imageAlt || "")],
    ["hasRecurrence", 0],
    ["recurrenceRule", null],
    ["recurrenceDates", null],
    ["recurrenceStartDate", null],
    ["recurrenceUntilDate", null],
    ["submissionId", String(p.submissionId || "") || null],
    ["featuredOrderId", String(p.featuredOrderId || "") || null],
    ["featuredPurchasedAt", String(p.featuredPurchasedAt || "") || null],
    ["featuredUntil", computedFeaturedUntil || null],
  ];

  const insertCols = [];
  const placeholders = [];
  const insertVals = [];

  for (const [k, v] of fields) {
    if (!cols.size || cols.has(k)) {
      insertCols.push(k);
      placeholders.push("?");
      insertVals.push(v);
    }
  }

  const ins = await run(
    `INSERT INTO events (${insertCols.join(", ")}) VALUES (${placeholders.join(", ")})`,
    insertVals
  );

  return ins?.lastID || null;
}

function esc(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function bytesToHuman(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) {
    v = v / 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function getDiskInfo() {
  try {
    const target =
      process.env.RENDER_DISK_PATH ||
      process.env.UPLOADS_DIR ||
      process.cwd();
    const out = execSync(`df -k "${target}"`, { encoding: "utf8" });
    const lines = String(out || "").trim().split(/\r?\n/);
    if (lines.length < 2) return null;
    const parts = lines[1].split(/\s+/);
    // Filesystem 1K-blocks Used Available Use% Mounted on
    const totalKB = parseInt(parts[1] || "0", 10) || 0;
    const availKB = parseInt(parts[3] || "0", 10) || 0;
    return {
      totalBytes: totalKB * 1024,
      freeBytes: availKB * 1024,
    };
  } catch (_) {
    return null;
  }
}

function getDbSizeBytes() {
  try {
    if (!DB_PATH || !fs.existsSync(DB_PATH)) return 0;
    const st = fs.statSync(DB_PATH);
    return Number(st.size || 0);
  } catch (_) {
    return 0;
  }
}

/**
 * Optional: schema safety (so admin doesn't crash if columns don't exist)
 */
let _eventsColsCache = null;
async function getEventsColumns() {
  if (_eventsColsCache) return _eventsColsCache;
  try {
    const rows = await all("PRAGMA table_info(events)");
    _eventsColsCache = new Set((rows || []).map((r) => String(r.name)));
    return _eventsColsCache;
  } catch {
    _eventsColsCache = new Set();
    return _eventsColsCache;
  }
}

// --- Archive schema (soft-delete best practice) ---
let _archiveSchemaEnsured = false;
async function ensureArchiveSchema() {
  if (_archiveSchemaEnsured) return;

  const cols = await getEventsColumns();

  // Prefer "archived" naming; support legacy "isArchived" if present.
  if (!cols.has("archived") && !cols.has("isArchived")) {
    await run(`ALTER TABLE events ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
    cols.add("archived");
  }
  if (!cols.has("archived_at") && !cols.has("archivedAt")) {
    await run(`ALTER TABLE events ADD COLUMN archived_at TEXT`);
    cols.add("archived_at");
  }
  if (!cols.has("archived_reason") && !cols.has("archivedReason")) {
    await run(`ALTER TABLE events ADD COLUMN archived_reason TEXT`);
    cols.add("archived_reason");
  }

  // Optional index for faster filtering
  try {
    if (cols.has("archived")) await run(`CREATE INDEX IF NOT EXISTS idx_events_archived ON events(archived)`);
    if (cols.has("isArchived")) await run(`CREATE INDEX IF NOT EXISTS idx_events_isArchived ON events(isArchived)`);
  } catch (_) {}

  _archiveSchemaEnsured = true;
}

// --- Eddie's Pick schema (flag) ---
let _pickSchemaEnsured = false;
async function ensurePickSchema() {
  if (_pickSchemaEnsured) return;
  const cols = await getEventsColumns();
  if (!cols.has("eddiesPick")) {
    await run(`ALTER TABLE events ADD COLUMN eddiesPick INTEGER NOT NULL DEFAULT 0`);
    cols.add("eddiesPick");
  }
  _pickSchemaEnsured = true;
}

let _venueSchemaEnsured = false;
let _venueColsCache = null;
async function getVenueColumns() {
  if (_venueColsCache) return _venueColsCache;
  try {
    const rows = await all("PRAGMA table_info(venues)");
    _venueColsCache = new Set((rows || []).map((r) => String(r.name)));
    return _venueColsCache;
  } catch {
    _venueColsCache = new Set();
    return _venueColsCache;
  }
}

async function ensureVenueSchema() {
  if (_venueSchemaEnsured) return;

  await run(`
    CREATE TABLE IF NOT EXISTS venues (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL DEFAULT 'Enumclaw',
      slug TEXT,
      name TEXT NOT NULL,
      address TEXT,
      website TEXT,
      phone TEXT,
      imageUrl TEXT,
      categoriesJson TEXT,
      socialJson TEXT,
      hoursJson TEXT,
      seoTitle TEXT,
      metaDescription TEXT,
      focusKeyphrase TEXT,
      imageAlt TEXT,
      galleryJson TEXT,
      phoneClickCount INTEGER NOT NULL DEFAULT 0,
      websiteClickCount INTEGER NOT NULL DEFAULT 0,
      socialClickCount INTEGER NOT NULL DEFAULT 0,
      description TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_venues_city ON venues(city)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_venues_slug ON venues(slug)`);
  } catch (_) {}

  const cols = await getVenueColumns();
  if (!cols.has("hoursJson")) {
    await run(`ALTER TABLE venues ADD COLUMN hoursJson TEXT`);
  }
  if (!cols.has("categoriesJson")) {
    await run(`ALTER TABLE venues ADD COLUMN categoriesJson TEXT`);
  }
  if (!cols.has("socialJson")) {
    await run(`ALTER TABLE venues ADD COLUMN socialJson TEXT`);
  }
  if (!cols.has("imageUrl")) {
    await run(`ALTER TABLE venues ADD COLUMN imageUrl TEXT`);
  }
  if (!cols.has("seoTitle")) {
    await run(`ALTER TABLE venues ADD COLUMN seoTitle TEXT`);
  }
  if (!cols.has("metaDescription")) {
    await run(`ALTER TABLE venues ADD COLUMN metaDescription TEXT`);
  }
  if (!cols.has("focusKeyphrase")) {
    await run(`ALTER TABLE venues ADD COLUMN focusKeyphrase TEXT`);
  }
  if (!cols.has("imageAlt")) {
    await run(`ALTER TABLE venues ADD COLUMN imageAlt TEXT`);
  }
  if (!cols.has("galleryJson")) {
    await run(`ALTER TABLE venues ADD COLUMN galleryJson TEXT`);
  }
  if (!cols.has("viewCount")) {
    await run(`ALTER TABLE venues ADD COLUMN viewCount INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has("phoneClickCount")) {
    await run(`ALTER TABLE venues ADD COLUMN phoneClickCount INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has("websiteClickCount")) {
    await run(`ALTER TABLE venues ADD COLUMN websiteClickCount INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has("socialClickCount")) {
    await run(`ALTER TABLE venues ADD COLUMN socialClickCount INTEGER NOT NULL DEFAULT 0`);
  }

  await run(`
    CREATE TABLE IF NOT EXISTS venue_metric_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      venueId INTEGER NOT NULL,
      metric TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_venue_metric_events_venueId ON venue_metric_events(venueId)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_venue_metric_events_metric ON venue_metric_events(metric)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_venue_metric_events_createdAt ON venue_metric_events(createdAt)`);
  } catch (_) {}

  _venueColsCache = null;
  _venueSchemaEnsured = true;
}

async function ensureUniqueVenueSlug(baseSlug, venueId) {
  let base = String(baseSlug || "").trim();
  if (!base) base = "venue";
  let slug = base;
  let n = 2;

  while (true) {
    const row = venueId
      ? await get("SELECT id FROM venues WHERE slug = ? AND id <> ? LIMIT 1", [slug, venueId])
      : await get("SELECT id FROM venues WHERE slug = ? LIMIT 1", [slug]);
    if (!row) return slug;
    slug = `${base}-${n++}`;
  }
}

let _jobSchemaEnsured = false;
let _jobColsCache = null;
async function getJobColumns() {
  if (_jobColsCache) return _jobColsCache;
  try {
    const rows = await all("PRAGMA table_info(jobs)");
    _jobColsCache = new Set((rows || []).map((r) => String(r.name)));
    return _jobColsCache;
  } catch {
    _jobColsCache = new Set();
    return _jobColsCache;
  }
}

async function ensureJobSchema() {
  if (_jobSchemaEnsured) return;

  await run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL DEFAULT 'Enumclaw',
      slug TEXT,
      title TEXT NOT NULL,
      company TEXT,
      location TEXT,
      employmentType TEXT,
      salaryRange TEXT,
      applyUrl TEXT,
      imageUrl TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      viewCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_jobs_city ON jobs(city)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_jobs_slug ON jobs(slug)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`);
  } catch (_) {}

  const cols = await getJobColumns();
  if (!cols.has("company")) await run(`ALTER TABLE jobs ADD COLUMN company TEXT`);
  if (!cols.has("location")) await run(`ALTER TABLE jobs ADD COLUMN location TEXT`);
  if (!cols.has("employmentType")) await run(`ALTER TABLE jobs ADD COLUMN employmentType TEXT`);
  if (!cols.has("salaryRange")) await run(`ALTER TABLE jobs ADD COLUMN salaryRange TEXT`);
  if (!cols.has("applyUrl")) await run(`ALTER TABLE jobs ADD COLUMN applyUrl TEXT`);
  if (!cols.has("imageUrl")) await run(`ALTER TABLE jobs ADD COLUMN imageUrl TEXT`);
  if (!cols.has("description")) await run(`ALTER TABLE jobs ADD COLUMN description TEXT`);
  if (!cols.has("status")) await run(`ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  if (!cols.has("viewCount")) await run(`ALTER TABLE jobs ADD COLUMN viewCount INTEGER NOT NULL DEFAULT 0`);
  if (!cols.has("createdAt")) await run(`ALTER TABLE jobs ADD COLUMN createdAt TEXT DEFAULT (datetime('now'))`);
  if (!cols.has("updatedAt")) await run(`ALTER TABLE jobs ADD COLUMN updatedAt TEXT DEFAULT (datetime('now'))`);

  _jobColsCache = null;
  _jobSchemaEnsured = true;
}

async function ensureUniqueJobSlug(baseSlug, jobId) {
  let base = String(baseSlug || "").trim();
  if (!base) base = "job";
  let slug = base;
  let n = 2;

  while (true) {
    const row = jobId
      ? await get("SELECT id FROM jobs WHERE slug = ? AND id <> ? LIMIT 1", [slug, jobId])
      : await get("SELECT id FROM jobs WHERE slug = ? LIMIT 1", [slug]);
    if (!row) return slug;
    slug = `${base}-${n++}`;
  }
}

let _adSchemaEnsured = false;
let _adColsCache = null;
async function getAdColumns() {
  if (_adColsCache) return _adColsCache;
  try {
    const rows = await all("PRAGMA table_info(ads)");
    _adColsCache = new Set((rows || []).map((r) => String(r.name)));
    return _adColsCache;
  } catch {
    _adColsCache = new Set();
    return _adColsCache;
  }
}

async function ensureAdSchema() {
  if (_adSchemaEnsured) return;

  await run(`
    CREATE TABLE IF NOT EXISTS ads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL DEFAULT 'Enumclaw',
      slug TEXT,
      name TEXT NOT NULL,
      placement TEXT NOT NULL DEFAULT 'default',
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

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_ads_city ON ads(city)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ads_slug ON ads(slug)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ads_placement ON ads(placement)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ads_status ON ads(status)`);
  } catch (_) {}

  const cols = await getAdColumns();
  if (!cols.has("city")) await run(`ALTER TABLE ads ADD COLUMN city TEXT NOT NULL DEFAULT 'Enumclaw'`);
  if (!cols.has("slug")) await run(`ALTER TABLE ads ADD COLUMN slug TEXT`);
  if (!cols.has("placement")) await run(`ALTER TABLE ads ADD COLUMN placement TEXT NOT NULL DEFAULT 'default'`);
  if (!cols.has("imageUrl")) await run(`ALTER TABLE ads ADD COLUMN imageUrl TEXT`);
  if (!cols.has("targetUrl")) await run(`ALTER TABLE ads ADD COLUMN targetUrl TEXT`);
  if (!cols.has("altText")) await run(`ALTER TABLE ads ADD COLUMN altText TEXT`);
  if (!cols.has("visibilityPercent")) await run(`ALTER TABLE ads ADD COLUMN visibilityPercent REAL NOT NULL DEFAULT 100`);
  if (!cols.has("status")) await run(`ALTER TABLE ads ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  if (!cols.has("startsAt")) await run(`ALTER TABLE ads ADD COLUMN startsAt TEXT`);
  if (!cols.has("endsAt")) await run(`ALTER TABLE ads ADD COLUMN endsAt TEXT`);
  if (!cols.has("notes")) await run(`ALTER TABLE ads ADD COLUMN notes TEXT`);
  if (!cols.has("viewCount")) await run(`ALTER TABLE ads ADD COLUMN viewCount INTEGER NOT NULL DEFAULT 0`);
  if (!cols.has("clickCount")) await run(`ALTER TABLE ads ADD COLUMN clickCount INTEGER NOT NULL DEFAULT 0`);
  if (!cols.has("createdAt")) await run(`ALTER TABLE ads ADD COLUMN createdAt TEXT DEFAULT (datetime('now'))`);
  if (!cols.has("updatedAt")) await run(`ALTER TABLE ads ADD COLUMN updatedAt TEXT DEFAULT (datetime('now'))`);

  await run(`
    CREATE TABLE IF NOT EXISTS ad_metric_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      adId INTEGER NOT NULL,
      metric TEXT NOT NULL,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);
  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_ad_metric_events_adId ON ad_metric_events(adId)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ad_metric_events_metric ON ad_metric_events(metric)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_ad_metric_events_createdAt ON ad_metric_events(createdAt)`);
  } catch (_) {}

  _adColsCache = null;
  _adSchemaEnsured = true;
}

async function ensureUniqueAdSlug(baseSlug, adId) {
  let base = String(baseSlug || "").trim();
  if (!base) base = "ad";
  let slug = base;
  let n = 2;

  while (true) {
    const row = adId
      ? await get("SELECT id FROM ads WHERE slug = ? AND id <> ? LIMIT 1", [slug, adId])
      : await get("SELECT id FROM ads WHERE slug = ? LIMIT 1", [slug]);
    if (!row) return slug;
    slug = `${base}-${n++}`;
  }
}

let _jobApplicantSchemaEnsured = false;
async function ensureJobApplicantSchema() {
  if (_jobApplicantSchemaEnsured) return;

  await run(`
    CREATE TABLE IF NOT EXISTS job_applicants (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jobId INTEGER,
      firstName TEXT,
      lastName TEXT,
      email TEXT,
      phone TEXT,
      resumeUrl TEXT,
      coverLetter TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      source TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_job_applicants_jobId ON job_applicants(jobId)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_job_applicants_status ON job_applicants(status)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_job_applicants_createdAt ON job_applicants(createdAt)`);
  } catch (_) {}

  _jobApplicantSchemaEnsured = true;
}

let _userProfileSchemaEnsured = false;
async function ensureUserProfileSchema() {
  if (_userProfileSchemaEnsured) return;

  await run(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE,
      username TEXT UNIQUE,
      passwordHash TEXT,
      role TEXT DEFAULT 'creator',
      city TEXT DEFAULT 'Enumclaw',
      displayName TEXT,
      phone TEXT,
      photoUrl TEXT,
      bio TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT
    )
  `);

  const rows = await all("PRAGMA table_info(users)");
  const cols = new Set((rows || []).map((r) => String(r.name)));

  const addCol = async (name, ddl) => {
    if (cols.has(name)) return;
    try { await run(ddl); } catch (_) {}
  };

  await addCol("displayName", "ALTER TABLE users ADD COLUMN displayName TEXT");
  await addCol("phone", "ALTER TABLE users ADD COLUMN phone TEXT");
  await addCol("photoUrl", "ALTER TABLE users ADD COLUMN photoUrl TEXT");
  await addCol("bio", "ALTER TABLE users ADD COLUMN bio TEXT");
  await addCol("updatedAt", "ALTER TABLE users ADD COLUMN updatedAt TEXT");

  _userProfileSchemaEnsured = true;
}

async function resolveSessionUser(req) {
  await ensureUserProfileSchema();
  const rawKey = String(req.user?.user || "").trim();
  const role = String(req.user?.role || "creator").trim().toLowerCase();
  const city = String(req.user?.city || "Enumclaw").trim() || "Enumclaw";
  const lowerKey = rawKey.toLowerCase();

  const candidates = Array.from(
    new Set(
      [rawKey, req.user?.email, req.user?.username]
        .map((v) => String(v || "").trim())
        .filter(Boolean)
    )
  );

  for (const key of candidates) {
    const row = await get(
      "SELECT id, email, username, role, city, displayName, phone, photoUrl, bio, createdAt FROM users WHERE lower(COALESCE(username,'')) = lower(?) OR lower(COALESCE(email,'')) = lower(?) LIMIT 1",
      [key, key]
    );
    if (row?.id) return row;
  }

  if (role === "admin") {
    let adminRow = await get(
      "SELECT id, email, username, role, city, displayName, phone, photoUrl, bio, createdAt FROM users WHERE lower(COALESCE(role,'')) = 'admin' ORDER BY id ASC LIMIT 1"
    );
    if (adminRow?.id) return adminRow;

    const username = rawKey && !rawKey.includes("@") ? rawKey : "admin";
    const email = rawKey.includes("@") ? lowerKey : null;
    await run(
      "INSERT INTO users (email, username, passwordHash, role, city, createdAt, updatedAt) VALUES (?, ?, ?, 'admin', ?, datetime('now'), datetime('now'))",
      [email, username, "", city]
    );
    adminRow = await get(
      "SELECT id, email, username, role, city, displayName, phone, photoUrl, bio, createdAt FROM users WHERE lower(COALESCE(username,'')) = lower(?) OR lower(COALESCE(email,'')) = lower(?) LIMIT 1",
      [username, email || username]
    );
    if (adminRow?.id) return adminRow;
  }

  return null;
}

// GET /admin
async function renderAdmin(req, res, view) {
  try {
    await ensurePickSchema();
    await ensureVenueSchema();
    await ensureJobSchema();
    await ensureJobApplicantSchema();
    await ensureUserProfileSchema();
    // ✅ Pagination + total count + optional server-side search
const limit = Math.max(5, Math.min(200, parseInt(req.query.limit || "20", 10)));
const pg = Math.max(1, parseInt(req.query.pg || "1", 10));
const offset = (pg - 1) * limit;

const q = String(req.query.q || "").trim();
const sort = String(req.query.sort || "datetime"); // datetime | alpha | recent | id
const fromDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.from || "").trim())
  ? String(req.query.from).trim()
  : "";
const toDate = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.to || "").trim())
  ? String(req.query.to).trim()
  : "";

// Lifecycle filter for admin list:
// status=upcoming|past|archived, recurring=1 (optional)
// Back-compat: map old archived query values if present.
const archivedModeLegacy = String(req.query.archived || "").trim().toLowerCase();
let statusMode = String(req.query.status || "").trim().toLowerCase();
if (!["upcoming", "past", "archived"].includes(statusMode)) {
  if (archivedModeLegacy === "1") statusMode = "archived";
  else statusMode = "upcoming";
}
const recurringOnly =
  String(req.query.recurring || "0") === "1" || archivedModeLegacy === "recurring";

let whereParts = [];
let whereParams = [];

    const isCityViewer = req.user?.role === "creator";
    const isCityEditor = req.user?.role === "editor";
    const isAdminUser = req.user?.role === "admin";

    // City (from URL unless locked)
    const userCity = String(req.user?.city || "Enumclaw");
    const selectedCity = isAdminUser ? String(req.query.city || userCity) : userCity;

    // Search
    if (q) {
      const like = `%${q}%`;
      whereParts.push(`(title LIKE ? OR slug LIKE ? OR location LIKE ? OR CAST(id AS TEXT) LIKE ?)`);
      whereParams.push(like, like, like, like);
    }

    // City filter
    if (selectedCity) {
      whereParts.push(`city = ?`);
      whereParams.push(selectedCity);
    }

if (fromDate && toDate) {
  const rangeStart = fromDate <= toDate ? fromDate : toDate;
  const rangeEnd = fromDate <= toDate ? toDate : fromDate;
  whereParts.push(`date(startDateTime) >= date(?) AND date(startDateTime) <= date(?)`);
  whereParams.push(rangeStart, rangeEnd);
} else if (fromDate) {
  whereParts.push(`date(startDateTime) = date(?)`);
  whereParams.push(fromDate);
} else if (toDate) {
  whereParts.push(`date(startDateTime) = date(?)`);
  whereParams.push(toDate);
}

// Archive constraints (only if DB has the columns)
const colsForWhere = await getEventsColumns();
const colArchived = colsForWhere.has("archived")
  ? "archived"
  : (colsForWhere.has("isArchived") ? "isArchived" : null);

const colArchivedAt = colsForWhere.has("archived_at")
  ? "archived_at"
  : (colsForWhere.has("archivedAt") ? "archivedAt" : null);

const selectArchived = colArchived ? `COALESCE(${colArchived},0) as isArchived` : `0 as isArchived`;
const selectArchivedAt = colArchivedAt ? `${colArchivedAt} as archivedAt` : `NULL as archivedAt`;

const hasRecurrenceColsForWhere =
  colsForWhere.has("hasRecurrence") ||
  colsForWhere.has("recurrenceRule") ||
  colsForWhere.has("recurrenceDates");

function recurrenceWhereClause() {
  const parts = [];
  if (colsForWhere.has("hasRecurrence")) parts.push("hasRecurrence = 1");
  if (colsForWhere.has("recurrenceRule")) parts.push("(recurrenceRule IS NOT NULL AND trim(recurrenceRule) <> '')");
  if (colsForWhere.has("recurrenceDates")) parts.push("(recurrenceDates IS NOT NULL AND trim(recurrenceDates) <> '')");
  return parts.length ? `(${parts.join(" OR ")})` : "";
}

if (recurringOnly) {
  if (hasRecurrenceColsForWhere) {
    const recWhere = recurrenceWhereClause();
    if (recWhere) whereParts.push(recWhere);
  } else {
    whereParts.push("1=0");
  }
}

const hasEndCol = colsForWhere.has("endDateTime");
const hasStartCol = colsForWhere.has("startDateTime");
let lifecycleDateExpr = "";
if (hasEndCol && hasStartCol) {
  lifecycleDateExpr = `datetime(COALESCE(NULLIF(trim(endDateTime), ''), NULLIF(trim(startDateTime), '')))`;
} else if (hasEndCol) {
  lifecycleDateExpr = `datetime(endDateTime)`;
} else if (hasStartCol) {
  lifecycleDateExpr = `datetime(startDateTime)`;
}

if (statusMode === "archived") {
  if (colArchived) whereParts.push(`${colArchived} = 1`);
  else whereParts.push("1=0");
} else {
  if (colArchived) whereParts.push(`(${colArchived} IS NULL OR ${colArchived} = 0)`);

  if (!lifecycleDateExpr) {
    whereParts.push("1=0");
  } else if (statusMode === "past") {
    whereParts.push(`${lifecycleDateExpr} < datetime('now')`);
  } else {
    whereParts.push(`${lifecycleDateExpr} >= datetime('now')`);
  }
}

const whereSql = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";

const totalRow = await get(`SELECT COUNT(*) AS n FROM events ${whereSql}`, whereParams);
const total = Number(totalRow?.n || 0);
const pages = Math.max(1, Math.ceil(total / limit));
const hasPrev = pg > 1;
const hasNext = pg < pages;
const baseListPath = "/admin/existing-events";

    function adminUrl(nextPg) {
      const sp = new URLSearchParams(req.query);
      sp.set("pg", String(nextPg));
      sp.set("limit", String(limit));
      if (sort) sp.set("sort", sort);
      if (q) sp.set("q", q);
      if (statusMode) sp.set("status", statusMode);
      if (recurringOnly) sp.set("recurring", "1");
      if (fromDate) sp.set("from", fromDate);
      if (toDate) sp.set("to", toDate);
      if (selectedCity) sp.set("city", selectedCity);
      return `${baseListPath}?${sp.toString()}`;
    }

const showingFrom = total ? offset + 1 : 0;
const showingTo = Math.min(offset + limit, total);

const pagerHtml = `
  <div class="pager">
    <div class="pager-left">
      <span class="muted">Total: <strong style="color:var(--text)">${total}</strong></span>
      <span class="muted">Showing ${showingFrom}–${showingTo}</span>
    </div>
    <div class="pager-right">
      <a class="btn" href="${adminUrl(1)}" ${pg === 1 ? 'style="opacity:.45; pointer-events:none;"' : ""}>First</a>
      <a class="btn" href="${adminUrl(Math.max(1, pg - 1))}" ${!hasPrev ? 'style="opacity:.45; pointer-events:none;"' : ""}>Prev</a>
      <span class="muted" style="padding:0 8px;">Page <strong style="color:var(--text)">${pg}</strong> / ${pages}</span>
      <a class="btn" href="${adminUrl(Math.min(pages, pg + 1))}" ${!hasNext ? 'style="opacity:.45; pointer-events:none;"' : ""}>Next</a>
      <a class="btn" href="${adminUrl(pages)}" ${pg === pages ? 'style="opacity:.45; pointer-events:none;"' : ""}>Last</a>
    </div>
  </div>
`;


// Sort for listing
let orderBySql = "startDateTime ASC";
try {
  const colsForSort = await getEventsColumns();
  if (sort === "alpha") orderBySql = "title COLLATE NOCASE ASC";
  else if (sort === "recent") {
    orderBySql = colsForSort.has("createdAt") ? "datetime(createdAt) DESC" : "id DESC";
  } else if (sort === "id") orderBySql = "id DESC";
  else orderBySql = "startDateTime ASC";
} catch (_) {
  if (sort === "alpha") orderBySql = "title COLLATE NOCASE ASC";
  else if (sort === "recent") orderBySql = "id DESC";
  else if (sort === "id") orderBySql = "id DESC";
  else orderBySql = "startDateTime ASC";
}

// ✅ Resilient list query: supports optional columns
let events = [];
try {
  events = await all(
    `SELECT id, slug, title, startDateTime, location, featured, eddiesPick,
            goingCount, interestedCount, viewCount, uniqueViewCount, lastViewedAt, imageUrl,
            ${selectArchived}, ${selectArchivedAt}
     FROM events
     ${whereSql}
     ORDER BY ${orderBySql}
     LIMIT ? OFFSET ?`,
    [...whereParams, limit, offset]
  );
} catch (err) {
  events = await all(
    `SELECT id, slug, title, startDateTime, location, featured, eddiesPick
     FROM events
     ${whereSql}
     ORDER BY ${orderBySql}
     LIMIT ? OFFSET ?`,
    [...whereParams, limit, offset]
  );
  events = events.map((x) => ({
    ...x,
    goingCount: 0,
    interestedCount: 0,
    viewCount: 0,
    uniqueViewCount: 0,
    lastViewedAt: null,
    imageUrl: null,
    eddiesPick: 0,
    isArchived: 0,
    archivedAt: null,
    imageUrl: null,
  }));
}



// Per-event source stats for current page (All Events)
const eventSourceStats = new Map();
try {
  const eventIds = (events || []).map((e) => Number(e.id || 0)).filter((n) => Number.isInteger(n) && n > 0);
  if (eventIds.length) {
    const placeholders = eventIds.map(() => "?").join(",");
    const rows = await all(
      `SELECT
         eventId,
         COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:direct%' OR COALESCE(ref,'') = '__direct__' OR trim(COALESCE(ref,'')) = '' THEN 1 ELSE 0 END), 0) AS directCount,
         COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:referral%' THEN 1 ELSE 0 END), 0) AS referralCount,
         COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:internal%' THEN 1 ELSE 0 END), 0) AS internalCount,
         COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:campaign%' THEN 1 ELSE 0 END), 0) AS campaignCount
       FROM event_views
       WHERE eventId IN (${placeholders})
       GROUP BY eventId`,
      eventIds
    );
    for (const r of rows || []) {
      eventSourceStats.set(Number(r.eventId || 0), {
        direct: Number(r.directCount || 0),
        referral: Number(r.referralCount || 0),
        internal: Number(r.internalCount || 0),
        campaign: Number(r.campaignCount || 0),
      });
    }
  }
} catch (_) {
  // event_views table may not exist in some environments
}

    const editId = req.query.edit ? parseInt(req.query.edit, 10) : null;
    const pendingId = req.query.pending ? parseInt(req.query.pending, 10) : null;
    let editEvent = null;
    let pendingEvent = null;
    if (editId) editEvent = await get("SELECT * FROM events WHERE id = ?", [editId]);
    if (!editEvent && pendingId) {
      pendingEvent = await get("SELECT * FROM pending_events WHERE id = ?", [pendingId]);
      if (pendingEvent) {
        editEvent = {
          ...pendingEvent,
          featured: 0,
          eddiesPick: 0,
        };
      }
    }
    const fromPending = !!pendingEvent && !editId;

    const selectedCats = normalizeCategories(parseStoredCategories(editEvent?.categories));
    const isFeatured = Number(editEvent?.featured || 0) === 1;
    const isEddiesPick = Number(editEvent?.eddiesPick || 0) === 1;

    // ✅ recurrence values for UI (these existed in your file, UI block was missing)
    const hasRecurrence = Number(editEvent?.hasRecurrence || 0) === 1;
    const rule = parseStoredRule(editEvent?.recurrenceRule) || { type: "none", interval: 1 };
    const ruleType = String(rule.type || (hasRecurrence ? "weekly" : "none")).toLowerCase();
    const storedRecurrenceDates = parseStoredDates(editEvent?.recurrenceDates);

    const customDates = (function(){
      if (ruleType != "custom") return [];

      const items = Array.isArray(rule?.items) ? rule.items : [];
      if (items.length) {
        return items
          .map((it) => ({
            start: String(it?.start || "").trim(),
            end: String(it?.end || "").trim(),
          }))
          .filter((it) => it.start && it.end);
      }

      const baseStart = String(editEvent?.startDateTime || "").trim();
      const baseEnd   = String(editEvent?.endDateTime || "").trim();

      return (storedRecurrenceDates || [])
        .map((d) => {
          if (d && typeof d === "object") {
            const s = String(d.start || "").trim();
            const e = String(d.end || "").trim();
            if (s && e) return { start: s, end: e };
          }

          const date = String(d || "").trim();
          if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

          if (baseStart.length >= 16 && baseEnd.length >= 16) {
            return { start: date + baseStart.slice(10), end: date + baseEnd.slice(10) };
          }

          return { start: date + "T00:00:00+00:00", end: date + "T00:00:00+00:00" };
        })
        .filter(Boolean);
    })();
    const recurrenceStartDateVal = editEvent?.recurrenceStartDate || toDateValue(editEvent?.startDateTime) || "";
    const recurrenceUntilDateVal = editEvent?.recurrenceUntilDate || "";

    const weeklyByDay = Array.isArray(rule.byDay) ? rule.byDay : [];
    const monthlyMode = String(rule.mode || "monthday");
    const byMonthday = rule.byMonthday ? String(rule.byMonthday) : "";
    const setPos = rule.setPos ? String(rule.setPos) : "1";
    const monthlyByDay = (function(){
      if (Array.isArray(rule.byDay)) return rule.byDay.map((d) => String(d || "").trim().toUpperCase()).filter(Boolean);
      const one = String(rule.byDay || "").trim().toUpperCase();
      return one ? [one] : ["MO"];
    })();
    const recurrenceInterval = rule.interval ? String(rule.interval) : "1";

    const categorySelect = (idx) => {
      const current = selectedCats[idx] || "";
      return `
        <select name="categories" class="ctrl">
          <option value="">— None —</option>
          ${ALLOWED_CATEGORIES
            .map((c) => {
              const sel = current === c ? "selected" : "";
              return `<option value="${esc(c)}" ${sel}>${esc(c)}</option>`;
            })
            .join("")}
        </select>
      `;
    };

    const ALLOWED_CITIES = ["Enumclaw", "Buckley"];
    const allowedForUser = isAdminUser ? ALLOWED_CITIES : [selectedCity];
    const formCity = String(editEvent?.city || selectedCity);
    const cityOptions = allowedForUser.map((c) => {
      const sel = formCity === c ? "selected" : "";
      return `<option value="${esc(c)}" ${sel}>${esc(c)}</option>`;
    }).join("");
    const cityListHtml = allowedForUser.map((c) => {
      const active = selectedCity === c ? " is-active" : "";
      return `<button type="button" class="sb-city-opt${active}" data-city="${esc(c)}">${esc(c)}</button>`;
    }).join("");

    const listHtml = events.length
      ? events
          .map((e) => {
  const going = Number(e.goingCount || 0);
  const interested = Number(e.interestedCount || 0);
const views = Number(e.viewCount || 0);
const uniques = Number(e.uniqueViewCount || 0);
const sourceStats = eventSourceStats.get(Number(e.id || 0)) || { direct: 0, referral: 0, internal: 0, campaign: 0 };
const directViews = Number(sourceStats.direct || 0);
const referralViews = Number(sourceStats.referral || 0);

            const thumbHtml = e.imageUrl
              ? `
                <a class="thumb-link" href="${esc(e.imageUrl)}" target="_blank" rel="noopener" title="View image">
                  <img class="event-thumb-img" src="${esc(e.imageUrl)}" alt="${esc(e.title)} flyer" loading="lazy"
                       onerror="this.closest('.event-thumb').classList.add('broken'); this.style.display='none';" />
                  <div class="thumb-fallback">Image not found</div>
                </a>
              `
              : `<div class="thumb-empty">No image</div>`;

return `
  <div class="event-card" data-eid="${e.id}">
    <div class="event-thumb">${thumbHtml}</div>

    <div class="event-left">
      <div class="event-main">
        <div class="event-title">
          #${e.id} — ${esc(e.title)}
          ${
            Number(e.featured || 0) === 1
              ? `<span class="pill" style="margin-left:8px;">Featured</span>`
              : ""
          }
          ${
            Number(e.eddiesPick || 0) === 1
              ? `<span class="pill" style="margin-left:8px; background: rgba(59,130,246,.12); border-color: rgba(59,130,246,.22); color: #1e3a8a;">Eddie's Pick</span>`
              : ""
          }
          ${
            Number(e.isArchived || 0) === 1
              ? `<span class="pill" style="margin-left:8px; background: rgba(148,163,184,.12); border-color: rgba(148,163,184,.22); color: rgba(229,231,235,.85);">Archived</span>`
              : ""
          }
        </div>

        <div class="event-meta">
          <div><strong>Slug:</strong> ${esc(e.slug || "")}</div>
          <div><strong>Start:</strong> ${esc(e.startDateTime)}</div>
          <div><strong>Location:</strong> ${esc(e.location)}</div>
        </div>
      </div>

      <div class="event-actions">
        ${isAdminUser || isCityEditor ? `
	          <a class="btn btn-edit" href="/admin/create-events?edit=${e.id}&pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${statusMode ? `&status=${encodeURIComponent(statusMode)}` : ""}${recurringOnly ? `&recurring=1` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}">Edit</a>

	          <form method="POST"
	                action="/admin/events/${e.id}/delete?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${statusMode ? `&status=${encodeURIComponent(statusMode)}` : ""}${recurringOnly ? `&recurring=1` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}"
	                class="inline"
	                onsubmit="return confirm('Delete this event permanently? This cannot be undone.');">
	            <button type="submit" class="btn btn-danger">Delete</button>
          </form>

          ${
            Number(e.isArchived || 0) === 1
	              ? `
	                <form method="POST"
	                      action="/admin/events/${e.id}/unarchive?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${statusMode ? `&status=${encodeURIComponent(statusMode)}` : ""}${recurringOnly ? `&recurring=1` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}"
	                      class="inline"
	                      onsubmit="return confirm('Unarchive this event?');">
	                  <button type="submit" class="btn">Unarchive</button>
                </form>
              `
	              : `
	                <form method="POST"
	                      action="/admin/events/${e.id}/archive?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${statusMode ? `&status=${encodeURIComponent(statusMode)}` : ""}${recurringOnly ? `&recurring=1` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}"
	                      class="inline"
	                      onsubmit="return confirm('Archive this event? (It will be hidden from the public list)');">
	                  <button type="submit" class="btn">Archive</button>
                </form>
              `
          }
        ` : ``}

        <a href="${e.slug ? `/events/slug/${esc(e.slug)}` : `/events/${e.id}`}"
           target="_blank" rel="noopener">View JSON</a>
      </div>
    </div>
<div class="event-stats">
  <div class="stat"><span>Views</span><strong class="js-views">${views}</strong></div>
  <div class="stat"><span>Unique</span><strong class="js-unique">${uniques}</strong></div>
  <div class="stat"><span>Direct</span><strong>${directViews}</strong></div>
  <div class="stat"><span>Referral</span><strong>${referralViews}</strong></div>
  <div class="stat"><span>Going</span><strong class="js-going">${going}</strong></div>
  <div class="stat"><span>Interested</span><strong class="js-interested">${interested}</strong></div>
</div>

    </div>
  `;
})
          .join("")
      : `<div class="muted">No events yet.</div>`;

    const isChecked = (arr, code) => (arr.includes(code) ? "checked" : "");

    // ===== Dashboard metrics + widgets =====
    const cols = await getEventsColumns();

    // Apply archive + city filter to dashboard widgets when supported
    const hasArchiveCols2 = cols.has("isArchived") && cols.has("archivedAt");
    const dashParts = [];
    const dashParams = [];
    if (hasArchiveCols2) {
      if (statusMode === "archived") dashParts.push("isArchived = 1");
      else dashParts.push("(isArchived IS NULL OR isArchived = 0)");
    } else {
      if (statusMode === "archived") dashParts.push("1=0");
    }
    if (selectedCity) {
      dashParts.push("city = ?");
      dashParams.push(selectedCity);
    }

    const dashWhere = dashParts.length ? `WHERE ${dashParts.join(" AND ")}` : "";
    const dashWhereSql = dashWhere ? (dashWhere + " ") : "";
    const dashAnd = dashWhere ? (dashWhere + " AND ") : "WHERE ";


    // Counts
    const upcomingRow = await get(
      `SELECT COUNT(*) AS n FROM events ${dashAnd}datetime(startDateTime) >= datetime('now')`,
      dashParams
    );
    const pastRow = await get(
      `SELECT COUNT(*) AS n FROM events ${dashAnd}datetime(startDateTime) < datetime('now')`,
      dashParams
    );
    const featuredRow = await get(`SELECT COUNT(*) AS n FROM events ${dashAnd}featured = 1`, dashParams);

    const upcoming = Number(upcomingRow?.n || 0);
    const past = Number(pastRow?.n || 0);
    const featuredCount = Number(featuredRow?.n || 0);

    // Count occurrences for recurring events (dashboard only)
    let totalOccurrences = 0;
    try {
      const occRows = await all(
        `SELECT recurrenceRule, recurrenceDates FROM events ${dashWhereSql}`,
        dashParams
      );
      totalOccurrences = (occRows || []).reduce((sum, r) => {
        let n = 1;
        const rr = safeParseJson(r?.recurrenceRule, null);
        const rd = safeParseJson(r?.recurrenceDates, null);
        if (rr && Array.isArray(rr.items) && rr.items.length) n = rr.items.length;
        else if (Array.isArray(rd) && rd.length) n = rd.length;
        return sum + n;
      }, 0);
    } catch (_) {
      totalOccurrences = total;
    }

    // Optional sums (only if columns exist)
    let viewsSum = 0;
    let upcomingViews = 0;
    let pastViews = 0;
    if (cols.has("viewCount")) {
      const r = await get(`SELECT COALESCE(SUM(viewCount), 0) AS n FROM events ${dashWhereSql}`, dashParams);
      viewsSum = Number(r?.n || 0);
      const rvUp = await get(
        `SELECT COALESCE(SUM(viewCount), 0) AS n FROM events ${dashAnd}datetime(startDateTime) >= datetime('now')`,
        dashParams
      );
      const rvPast = await get(
        `SELECT COALESCE(SUM(viewCount), 0) AS n FROM events ${dashAnd}datetime(startDateTime) < datetime('now')`,
        dashParams
      );
      upcomingViews = Number(rvUp?.n || 0);
      pastViews = Number(rvPast?.n || 0);
    }


    // Source tracking rollups from event_views (direct/referral/internal/campaign)
    let sourceTracked = 0;
    let sourceDirect = 0;
    let sourceReferral = 0;
    let sourceInternal = 0;
    let sourceCampaign = 0;
    let sourceUnknown = 0;
    try {
      const srcRow = await get(
        `SELECT
           COUNT(*) AS tracked,
           COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:direct%' OR COALESCE(ref,'') = '__direct__' OR trim(COALESCE(ref,'')) = '' THEN 1 ELSE 0 END), 0) AS directCount,
           COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:referral%' THEN 1 ELSE 0 END), 0) AS referralCount,
           COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:internal%' THEN 1 ELSE 0 END), 0) AS internalCount,
           COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:campaign%' THEN 1 ELSE 0 END), 0) AS campaignCount,
           COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:%' THEN 0 WHEN COALESCE(ref,'') = '__direct__' OR trim(COALESCE(ref,'')) = '' THEN 0 ELSE 1 END), 0) AS unknownCount
         FROM event_views
         WHERE eventId IN (SELECT id FROM events ${whereSql})`,
        whereParams
      );
      sourceTracked = Number(srcRow?.tracked || 0);
      sourceDirect = Number(srcRow?.directCount || 0);
      sourceReferral = Number(srcRow?.referralCount || 0);
      sourceInternal = Number(srcRow?.internalCount || 0);
      sourceCampaign = Number(srcRow?.campaignCount || 0);
      sourceUnknown = Number(srcRow?.unknownCount || 0);
    } catch (_) {
      // event_views table may not exist in some environments
    }

    const fmt = (n) => Number(n || 0).toLocaleString("en-US");

    const diskInfo = getDiskInfo();
    const diskFree = diskInfo ? bytesToHuman(diskInfo.freeBytes) : "N/A";
    const diskTotal = diskInfo ? bytesToHuman(diskInfo.totalBytes) : "N/A";
    const dbSize = bytesToHuman(getDbSizeBytes());

const appVersion = String(process.env.APP_VERSION || "v0.0.4");
    let releaseUpdatedAt = new Date().toISOString().replace("T", " ").slice(0, 19) + "Z";
    try {
      const st = fs.statSync(__filename);
      if (st && st.mtime) {
        releaseUpdatedAt = new Date(st.mtime).toISOString().replace("T", " ").slice(0, 19) + "Z";
      }
    } catch (_) {}

    const hasVenueTable = !!(await get("SELECT name FROM sqlite_master WHERE type='table' AND name='venues'"));
    const hasJobsTable = !!(await get("SELECT name FROM sqlite_master WHERE type='table' AND name='jobs'"));
    const hasApplicantsTable = !!(await get("SELECT name FROM sqlite_master WHERE type='table' AND name='job_applicants'"));
    const hasSourceTrackingTable = !!(await get("SELECT name FROM sqlite_master WHERE type='table' AND name='event_views'"));
    const releaseItems = [];
    releaseItems.push("Events module");
    if (hasVenueTable) {
      releaseItems.push("Venues module");
    }
    if (hasJobsTable) {
      releaseItems.push("Jobs module");
    }
    if (hasApplicantsTable) {
      releaseItems.push("Applicants");
    }
    if (hasSourceTrackingTable) {
      releaseItems.push("Source tracking");
    }
    releaseItems.push("Venue gallery");
    releaseItems.push("Dashboard insights");
    const releaseSummary = String(process.env.RELEASE_NOTES || releaseItems.join(", "));

    const reqCount5m = Array.isArray(req.app?.locals?.reqTimes)
      ? req.app.locals.reqTimes.length
      : 0;
    const sourcePct = (n) => {
      if (!sourceTracked) return "0%";
      return Math.round((Number(n || 0) / sourceTracked) * 100) + "%";
    };

    const stats = {
      total: fmt(totalOccurrences || total),
      upcoming: fmt(upcoming),
      past: fmt(past),
      featured: fmt(featuredCount),
      views: fmt(viewsSum),
      upcomingViews: fmt(upcomingViews),
      pastViews: fmt(pastViews),
      sourceTracked: fmt(sourceTracked),
      sourceDirect: fmt(sourceDirect),
      sourceReferral: fmt(sourceReferral),
      sourceInternal: fmt(sourceInternal),
      sourceCampaign: fmt(sourceCampaign),
      sourceUnknown: fmt(sourceUnknown),
      sourceDirectPct: sourcePct(sourceDirect),
      sourceReferralPct: sourcePct(sourceReferral),
      sourceInternalPct: sourcePct(sourceInternal),
      sourceCampaignPct: sourcePct(sourceCampaign),
      sourceUnknownPct: sourcePct(sourceUnknown),
      serverTime: new Date().toISOString().replace("T", " ").slice(0, 19) + "Z",
      diskFree,
      diskTotal,
      appVersion,
      releaseSummary,
      releaseUpdatedAt,
      dbSize,
      reqCount5m: fmt(reqCount5m),
      autoArchive: cols.has("archived") ? "On" : "Off",
    };

    // Venue dashboard metrics
    const venueDashParams = [];
    const venueDashWhere = [];
    if (selectedCity) {
      venueDashWhere.push("city = ?");
      venueDashParams.push(selectedCity);
    }
    const venueDashWhereSql = venueDashWhere.length ? `WHERE ${venueDashWhere.join(" AND ")}` : "";
    const venueTotalRowDash = await get(`SELECT COUNT(*) AS n FROM venues ${venueDashWhereSql}`, venueDashParams);
    const venueWithImageRow = await get(
      `SELECT COUNT(*) AS n FROM venues ${venueDashWhereSql}${venueDashWhereSql ? " AND " : "WHERE "}imageUrl IS NOT NULL AND trim(imageUrl) <> ''`,
      venueDashParams
    );
    const venueWithSocialRow = await get(
      `SELECT COUNT(*) AS n FROM venues ${venueDashWhereSql}${venueDashWhereSql ? " AND " : "WHERE "}socialJson IS NOT NULL AND trim(socialJson) <> ''`,
      venueDashParams
    );
    const venueWithHoursRow = await get(
      `SELECT COUNT(*) AS n FROM venues ${venueDashWhereSql}${venueDashWhereSql ? " AND " : "WHERE "}hoursJson IS NOT NULL AND trim(hoursJson) <> ''`,
      venueDashParams
    );
    const venueWithWebsiteRow = await get(
      `SELECT COUNT(*) AS n FROM venues ${venueDashWhereSql}${venueDashWhereSql ? " AND " : "WHERE "}website IS NOT NULL AND trim(website) <> ''`,
      venueDashParams
    );
    const venueWithGalleryRow = await get(
      `SELECT COUNT(*) AS n FROM venues ${venueDashWhereSql}${venueDashWhereSql ? " AND " : "WHERE "}galleryJson IS NOT NULL AND trim(galleryJson) <> ''`,
      venueDashParams
    );
    const venueViewsRow = await get(
      `SELECT COALESCE(SUM(viewCount), 0) AS n FROM venues ${venueDashWhereSql}`,
      venueDashParams
    );
    const venuePhoneClicksRow = await get(
      `SELECT COALESCE(SUM(phoneClickCount), 0) AS n FROM venues ${venueDashWhereSql}`,
      venueDashParams
    );
    const venueWebsiteClicksRow = await get(
      `SELECT COALESCE(SUM(websiteClickCount), 0) AS n FROM venues ${venueDashWhereSql}`,
      venueDashParams
    );
    const venueSocialClicksRow = await get(
      `SELECT COALESCE(SUM(socialClickCount), 0) AS n FROM venues ${venueDashWhereSql}`,
      venueDashParams
    );

    const venueTopViewsRows = await all(
      `SELECT id, name, slug, COALESCE(viewCount, 0) AS viewCount
       FROM venues
       ${venueDashWhereSql}
       ORDER BY COALESCE(viewCount, 0) DESC, id DESC
       LIMIT 5`,
      venueDashParams
    );
    const venueTopClicksRows = await all(
      `SELECT id, name, slug,
              (COALESCE(phoneClickCount,0) + COALESCE(websiteClickCount,0) + COALESCE(socialClickCount,0)) AS totalClicks
       FROM venues
       ${venueDashWhereSql}
       ORDER BY totalClicks DESC, id DESC
       LIMIT 5`,
      venueDashParams
    );

    const venueTotalCount = Number(venueTotalRowDash?.n || 0);
    const venueWithImageCount = Number(venueWithImageRow?.n || 0);
    const venueWithSocialCount = Number(venueWithSocialRow?.n || 0);
    const venueWithHoursCount = Number(venueWithHoursRow?.n || 0);
    const venueWithWebsiteCount = Number(venueWithWebsiteRow?.n || 0);
    const venueWithGalleryCount = Number(venueWithGalleryRow?.n || 0);
    const venueViewsCount = Number(venueViewsRow?.n || 0);
    const venuePhoneClicksCount = Number(venuePhoneClicksRow?.n || 0);
    const venueWebsiteClicksCount = Number(venueWebsiteClicksRow?.n || 0);
    const venueSocialClicksCount = Number(venueSocialClicksRow?.n || 0);
    const venueTotalClicksCount = venuePhoneClicksCount + venueWebsiteClicksCount + venueSocialClicksCount;

    const pctVenue = (n) => {
      if (!venueTotalCount) return "0%";
      return `${Math.round((Number(n || 0) / venueTotalCount) * 100)}%`;
    };

    const venueStats = {
      total: fmt(venueTotalCount),
      withImage: fmt(venueWithImageCount),
      withSocial: fmt(venueWithSocialCount),
      withHours: fmt(venueWithHoursCount),
      withWebsite: fmt(venueWithWebsiteCount),
      withGallery: fmt(venueWithGalleryCount),
      views: fmt(venueViewsCount),
      phoneClicks: fmt(venuePhoneClicksCount),
      websiteClicks: fmt(venueWebsiteClicksCount),
      socialClicks: fmt(venueSocialClicksCount),
      totalClicks: fmt(venueTotalClicksCount),
      avgViewsPerVenue: fmt(venueTotalCount ? Math.round(venueViewsCount / venueTotalCount) : 0),
      avgClicksPerVenue: fmt(venueTotalCount ? Math.round(venueTotalClicksCount / venueTotalCount) : 0),
      withImagePct: pctVenue(venueWithImageCount),
      withSocialPct: pctVenue(venueWithSocialCount),
      withHoursPct: pctVenue(venueWithHoursCount),
      withWebsitePct: pctVenue(venueWithWebsiteCount),
      withGalleryPct: pctVenue(venueWithGalleryCount),
      topByViews: (venueTopViewsRows || []).map((r) => ({
        id: Number(r.id || 0),
        name: String(r.name || "Venue"),
        slug: String(r.slug || ""),
        views: Number(r.viewCount || 0),
      })),
      topByClicks: (venueTopClicksRows || []).map((r) => ({
        id: Number(r.id || 0),
        name: String(r.name || "Venue"),
        slug: String(r.slug || ""),
        clicks: Number(r.totalClicks || 0),
      })),
    };

    const selectedVenueIdRaw = parseInt(String(req.query.venue || ""), 10);
    const requestedVenueId = Number.isInteger(selectedVenueIdRaw) && selectedVenueIdRaw > 0
      ? selectedVenueIdRaw
      : null;
    const venueAnalyticsOptions = await all(
      `SELECT id, name, slug, city,
              COALESCE(viewCount, 0) AS viewCount,
              COALESCE(phoneClickCount, 0) AS phoneClickCount,
              COALESCE(websiteClickCount, 0) AS websiteClickCount,
              COALESCE(socialClickCount, 0) AS socialClickCount
       FROM venues
       ${venueDashWhereSql}
       ORDER BY name COLLATE NOCASE ASC, id ASC`,
      venueDashParams
    );
    const selectedVenue =
      (requestedVenueId
        ? venueAnalyticsOptions.find((v) => Number(v.id || 0) === requestedVenueId)
        : null) ||
      venueAnalyticsOptions[0] ||
      null;
    const selectedVenueActualId = selectedVenue ? Number(selectedVenue.id || 0) : null;

    let venueMonthlyHistory = [];
    let hasVenueMetricHistory = false;
    try {
      const metricTableRow = await get(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='venue_metric_events' LIMIT 1"
      );
      hasVenueMetricHistory = !!metricTableRow;
      if (selectedVenueActualId && hasVenueMetricHistory) {
        const monthlyRows = await all(
          `SELECT strftime('%Y-%m', createdAt) AS ym,
                  COALESCE(SUM(CASE WHEN metric = 'view' THEN 1 ELSE 0 END), 0) AS views,
                  COALESCE(SUM(CASE WHEN metric = 'phone_click' THEN 1 ELSE 0 END), 0) AS phoneClicks,
                  COALESCE(SUM(CASE WHEN metric = 'website_click' THEN 1 ELSE 0 END), 0) AS websiteClicks,
                  COALESCE(SUM(CASE WHEN metric = 'social_click' THEN 1 ELSE 0 END), 0) AS socialClicks
           FROM venue_metric_events
           WHERE venueId = ?
             AND date(createdAt) >= date('now', 'start of month', '-11 month')
           GROUP BY ym
           ORDER BY ym ASC`,
          [selectedVenueActualId]
        );
        const monthlyMap = new Map(
          (monthlyRows || []).map((row) => [
            String(row.ym || ""),
            {
              views: Number(row.views || 0),
              phoneClicks: Number(row.phoneClicks || 0),
              websiteClicks: Number(row.websiteClicks || 0),
              socialClicks: Number(row.socialClicks || 0),
            },
          ])
        );
        const monthCursor = new Date();
        monthCursor.setDate(1);
        venueMonthlyHistory = [];
        for (let i = 11; i >= 0; i--) {
          const dt = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - i, 1);
          const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
          const base = monthlyMap.get(ym) || {
            views: 0,
            phoneClicks: 0,
            websiteClicks: 0,
            socialClicks: 0,
          };
          const totalClicks = base.phoneClicks + base.websiteClicks + base.socialClicks;
          venueMonthlyHistory.push({
            ym,
            label: dt.toLocaleString("en-US", { month: "short", year: "numeric" }),
            views: base.views,
            phoneClicks: base.phoneClicks,
            websiteClicks: base.websiteClicks,
            socialClicks: base.socialClicks,
            totalClicks,
          });
        }
      }
    } catch (_) {}
    const venueChartDataJson = JSON.stringify({
      views: {
        labels: venueMonthlyHistory.map((row) => row.label),
        values: venueMonthlyHistory.map((row) => Number(row.views || 0)),
      },
      clicks: {
        labels: venueMonthlyHistory.map((row) => row.label),
        values: venueMonthlyHistory.map((row) => Number(row.totalClicks || 0)),
      },
    });

    // Top events by views (today / week / month / year)
    const hasViews = cols.has("viewCount");
    const topEventsFallback = `<div class="muted">Views not tracked.</div>`;
    async function topEventsHtml(whereClause) {
      if (!hasViews) return topEventsFallback;
      const rows = await all(
        `SELECT id, title, viewCount
         FROM events
         ${whereClause}
         ORDER BY viewCount DESC, id DESC
         LIMIT 5`
      , dashParams);
      if (!rows || rows.length === 0) return `<div class="muted">No events.</div>`;
      return rows
        .map((r) => {
          const label = esc(String(r.title || ""));
          const count = Number(r.viewCount || 0);
          return `<div class="kv"><div class="k">${label}</div><div class="v">${count}</div></div>`;
        })
        .join("");
    }

    const withDashAnd = (clause) => `${dashWhere ? dashWhere + " AND " : "WHERE "}${clause}`;
    const topTodayHtml = await topEventsHtml(
      withDashAnd(`date(startDateTime) = date('now')`)
    );
    const topWeekHtml = await topEventsHtml(
      withDashAnd(`date(startDateTime) >= date('now','-6 day') AND date(startDateTime) <= date('now')`)
    );
    const topMonthHtml = await topEventsHtml(
      withDashAnd(`date(startDateTime) >= date('now','start of month') AND date(startDateTime) <= date('now')`)
    );
    const topYearHtml = await topEventsHtml(
      withDashAnd(`date(startDateTime) >= date('now','start of year') AND date(startDateTime) <= date('now')`)
    );

    // Top organizers
    const orgRows = await all(`
      SELECT 
        COALESCE(NULLIF(TRIM(organizer), ''), '(unknown)') AS organizer,
        COUNT(*) AS c
      FROM events
      ${dashWhereSql}
      GROUP BY organizer
      ORDER BY c DESC, organizer ASC
      LIMIT 12
    `, dashParams);

    const topOrganizersHtml = orgRows
      .map((r) => {
        const label = esc(r.organizer);
        const count = Number(r.c || 0);
        return `<div class="kv"><div class="k">${label}</div><div class="v">${count}</div></div>`;
      })
      .join("");

    // ------------------------------
    // Chart: Daily / Weekly / Monthly / Yearly
    // ------------------------------
    const hasViewsCol = cols.has("viewCount");
    const countExpr = "COUNT(*)";
    const viewsExpr = hasViewsCol ? "SUM(COALESCE(viewCount,0))" : "0";

    const buildDaily = async (metric) => {
      const agg = metric === "views" ? viewsExpr : countExpr;
      const rows = await all(
        `SELECT date(startDateTime) AS d, ${agg} AS n
         FROM events
         ${dashAnd}date(startDateTime) >= date('now','-13 day')
         GROUP BY d
         ORDER BY d`
      , dashParams);
      const byDay = new Map((rows || []).map((r) => [String(r.d), Number(r.n || 0)]));
      const labels = [];
      const values = [];
      for (let i = 13; i >= 0; i--) {
        const dt = new Date();
        dt.setDate(dt.getDate() - i);
        const key = dt.toISOString().slice(0, 10); // YYYY-MM-DD
        labels.push(key.slice(5)); // MM-DD
        values.push(byDay.get(key) || 0);
      }
      return { labels, values };
    };

    const buildWeekly = async (metric) => {
      const agg = metric === "views" ? viewsExpr : countExpr;
      // Group by Monday week-start. Keep last 12 weeks.
      const rows = await all(
        `SELECT date(startDateTime, 'weekday 1', '-7 day') AS wk, ${agg} AS n
         FROM events
         ${dashAnd}date(startDateTime) >= date('now','-83 day')
         GROUP BY wk
         ORDER BY wk`
      , dashParams);
      const byWk = new Map((rows || []).map((r) => [String(r.wk), Number(r.n || 0)]));
      const labels = [];
      const values = [];
      // Walk back 11 weeks to current week
      const now = new Date();
      const day = now.getDay(); // 0 Sun..6 Sat
      // Monday start
      const monday = new Date(now);
      const diffToMon = (day + 6) % 7;
      monday.setDate(monday.getDate() - diffToMon);
      for (let i = 11; i >= 0; i--) {
        const dt = new Date(monday);
        dt.setDate(dt.getDate() - i * 7);
        const key = dt.toISOString().slice(0, 10);
        // Label as MM-DD of week start
        labels.push(key.slice(5));
        values.push(byWk.get(key) || 0);
      }
      return { labels, values };
    };

    const buildMonthly = async (metric) => {
      const agg = metric === "views" ? viewsExpr : countExpr;
      // Last 12 months, group by YYYY-MM.
      const rows = await all(
        `SELECT strftime('%Y-%m', startDateTime) AS ym, ${agg} AS n
         FROM events
         ${dashAnd}date(startDateTime) >= date('now','start of month','-11 month')
         GROUP BY ym
         ORDER BY ym`
      , dashParams);
      const byYm = new Map((rows || []).map((r) => [String(r.ym), Number(r.n || 0)]));
      const labels = [];
      const values = [];
      const d = new Date();
      d.setDate(1);
      for (let i = 11; i >= 0; i--) {
        const dt = new Date(d);
        dt.setMonth(dt.getMonth() - i);
        const ym = dt.toISOString().slice(0, 7);
        // Label as Mon (and year if different from current year)
        const mon = dt.toLocaleString('en-US', { month: 'short' });
        const yr = dt.getFullYear();
        const curYr = new Date().getFullYear();
        labels.push(yr === curYr ? mon : `${mon} ${String(yr).slice(-2)}`);
        values.push(byYm.get(ym) || 0);
      }
      return { labels, values };
    };

    const buildYearly = async (metric) => {
      const agg = metric === "views" ? viewsExpr : countExpr;
      // Last 5 years, group by YYYY.
      const rows = await all(
        `SELECT strftime('%Y', startDateTime) AS y, ${agg} AS n
         FROM events
         ${dashAnd}date(startDateTime) >= date('now','start of year','-4 year')
         GROUP BY y
         ORDER BY y`
      , dashParams);
      const byY = new Map((rows || []).map((r) => [String(r.y), Number(r.n || 0)]));
      const labels = [];
      const values = [];
      const curY = new Date().getFullYear();
      for (let y = curY - 4; y <= curY; y++) {
        labels.push(String(y));
        values.push(byY.get(String(y)) || 0);
      }
      return { labels, values };
    };

    const chartSets = {
      events: {
        daily: await buildDaily("events"),
        weekly: await buildWeekly("events"),
        monthly: await buildMonthly("events"),
        yearly: await buildYearly("events"),
      },
      views: {
        daily: await buildDaily("views"),
        weekly: await buildWeekly("views"),
        monthly: await buildMonthly("views"),
        yearly: await buildYearly("views"),
      },
    };
    const chartDataJson = JSON.stringify(chartSets);

    const showDashboard = view === "dashboard";
    const showAnalytics = view === "events-analytics" || view === "analytics";
    const showCreate = view === "create";
    const showApprove = view === "approve";
    const showExisting = view === "existing";
    const showVenueCreate = view === "venues-create";
    const showVenueExisting = view === "venues-existing";
    const showVenueAnalytics = view === "venues-analytics";
    const showJobsCreate = view === "jobs-create";
    const showJobsExisting = view === "jobs-existing";
    const showJobsApplicants = view === "jobs-applicants";
    const showJobsAnalytics = view === "jobs-analytics";
    const showAdsCreate = view === "ads-create";
    const showAdsExisting = view === "ads-existing";
    const showAdsAnalytics = view === "ads-analytics";
    const showPreferences = view === "preferences";
    const showUsers = view === "users";
    const showInvites = view === "invites";

    if (showUsers && !isAdminUser) return res.status(403).send("Forbidden");
    if (showInvites && !isAdminUser) return res.status(403).send("Forbidden");
    if (showApprove && !(isAdminUser || isCityEditor)) return res.status(403).send("Forbidden");
    if (showCreate && !(isAdminUser || isCityEditor || isCityViewer)) return res.status(403).send("Forbidden");
    if (showVenueCreate && !(isAdminUser || isCityEditor || isCityViewer)) return res.status(403).send("Forbidden");
    if (showVenueExisting && !(isAdminUser || isCityEditor || isCityViewer)) return res.status(403).send("Forbidden");
    if (showVenueAnalytics && !(isAdminUser || isCityEditor)) return res.status(403).send("Forbidden");
    if (showJobsCreate && !(isAdminUser || isCityEditor || isCityViewer)) return res.status(403).send("Forbidden");
    if (showJobsExisting && !(isAdminUser || isCityEditor || isCityViewer)) return res.status(403).send("Forbidden");
    if (showJobsApplicants && !(isAdminUser || isCityEditor || isCityViewer)) return res.status(403).send("Forbidden");
    if (showJobsAnalytics && !(isAdminUser || isCityEditor)) return res.status(403).send("Forbidden");
    if (showAdsCreate && !(isAdminUser || isCityEditor || isCityViewer)) return res.status(403).send("Forbidden");
    if (showAdsExisting && !(isAdminUser || isCityEditor || isCityViewer)) return res.status(403).send("Forbidden");
    if (showAdsAnalytics && !(isAdminUser || isCityEditor)) return res.status(403).send("Forbidden");
    const showSearch = showAnalytics || showExisting || showVenueExisting || showJobsExisting || showJobsApplicants || showAdsExisting;
    const isSingleManage = (showCreate ^ showExisting ^ showVenueCreate ^ showVenueExisting ^ showJobsCreate ^ showJobsExisting ^ showJobsApplicants ^ showJobsAnalytics ^ showAdsCreate ^ showAdsExisting ^ showAdsAnalytics ^ showPreferences);

    const currentUser = await resolveSessionUser(req);
    const prefNotice = String(req.query.notice || "").trim().toLowerCase();
    const prefNoticeHtml = prefNotice
      ? (prefNotice === "profile_saved"
          ? `<div class="mini" style="border-color:rgba(0,192,139,.35); background:rgba(0,192,139,.08); color:#065f46; margin-bottom:12px;">Profile updated.</div>`
          : prefNotice === "password_saved"
          ? `<div class="mini" style="border-color:rgba(0,192,139,.35); background:rgba(0,192,139,.08); color:#065f46; margin-bottom:12px;">Password updated.</div>`
          : prefNotice === "password_mismatch"
          ? `<div class="mini" style="border-color:rgba(239,68,68,.35); background:rgba(239,68,68,.08); color:#7f1d1d; margin-bottom:12px;">New passwords do not match.</div>`
          : prefNotice === "password_short"
          ? `<div class="mini" style="border-color:rgba(239,68,68,.35); background:rgba(239,68,68,.08); color:#7f1d1d; margin-bottom:12px;">New password must be at least 8 characters.</div>`
          : prefNotice === "password_invalid"
          ? `<div class="mini" style="border-color:rgba(239,68,68,.35); background:rgba(239,68,68,.08); color:#7f1d1d; margin-bottom:12px;">Current password is incorrect.</div>`
          : prefNotice === "user_not_found"
          ? `<div class="mini" style="border-color:rgba(239,68,68,.35); background:rgba(239,68,68,.08); color:#7f1d1d; margin-bottom:12px;">User record not found.</div>`
          : "")
      : "";

    let pendingRows = [];
    if (showApprove) {
      try {
        pendingRows = await all(
          "SELECT * FROM pending_events WHERE city = ? ORDER BY datetime(createdAt) DESC",
          [selectedCity]
        );
      } catch (_) {
        pendingRows = [];
      }
    }
    let pendingCount = 0;
    try {
      const pc = await get("SELECT COUNT(*) AS n FROM pending_events WHERE city = ?", [selectedCity]);
      pendingCount = Number(pc?.n || 0);
    } catch (_) {
      pendingCount = 0;
    }

    const fmtPendingDate = (iso) => {
      try {
        if (!iso) return "";
        const d = new Date(String(iso));
        if (Number.isNaN(d.getTime())) return String(iso);
        return d.toLocaleString("en-US", {
          month: "short",
          day: "numeric",
          year: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
      } catch {
        return String(iso || "");
      }
    };

    const pendingHtml = pendingRows.length
      ? pendingRows.map((p) => {
          const cats = parseStoredCategories(p.categories).slice(0, 3);
          const catLine = cats.length ? `<div class="muted" style="margin-top:4px;">${cats.map(esc).join(", ")}</div>` : "";
          const emailLine = p.submitterEmail
            ? `<div class="muted">Email: <a href="mailto:${esc(p.submitterEmail)}" style="color:inherit;">${esc(p.submitterEmail)}</a></div>`
            : "";
          const imageLine = p.imageUrl
            ? `<div class="muted">Image: <a href="${esc(p.imageUrl)}" target="_blank" rel="noopener">View / Download</a></div>`
            : "";
          const notesLine = p.approvalNotes
            ? `<div class="muted">Notes: ${esc(p.approvalNotes)}</div>`
            : "";
          const startLabel = fmtPendingDate(p.startDateTime);
          const endLabel = p.endDateTime ? fmtPendingDate(p.endDateTime) : "";
          return `
            <div class="mini" style="margin-bottom:12px;">
              <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                <div style="min-width:0;">
                  <div style="font-weight:700; font-size:1.05rem;">${esc(p.title || "Untitled")}</div>
                  <div class="muted">${esc(startLabel)}${endLabel ? " – " + esc(endLabel) : ""}</div>
                  <div class="muted">${esc(p.location || "")}</div>
                  ${p.organizer ? `<div class="muted">Organizer: ${esc(p.organizer)}</div>` : ""}
                  ${emailLine}
                  ${imageLine}
                  ${notesLine}
                  ${catLine}
                </div>
                <div style="display:flex; gap:8px; flex-wrap:wrap; justify-content:flex-end;">
                  <a class="btn" href="/admin/create-events?pending=${encodeURIComponent(p.id)}">Edit</a>
                  <form method="POST" action="/admin/approve-events/${encodeURIComponent(p.id)}/approve">
                    <button class="btn primary" type="submit">Approve</button>
                  </form>
                  <form method="POST" action="/admin/approve-events/${encodeURIComponent(p.id)}/deny" onsubmit="return confirm('Deny this submission?');">
                    <button class="btn danger" type="submit">Deny</button>
                  </form>
                </div>
              </div>
            </div>
          `;
        }).join("")
      : `<div class="muted">No pending approvals.</div>`;

    let invitesHtml = "";
    if (showInvites) {
      const inviteRows = await all(
        "SELECT id, email, role, city, expiresAt, usedAt, createdAt FROM invites ORDER BY datetime(createdAt) DESC"
      );
      invitesHtml = inviteRows.length
        ? inviteRows
            .map((inv) => {
              const status = inv.usedAt
                ? `Used ${fmtPendingDate(inv.usedAt)}`
                : inv.expiresAt && new Date(inv.expiresAt).getTime() < Date.now()
                ? "Expired"
                : "Active";
              return `
                <div class="mini" style="margin-bottom:10px;">
                  <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start;">
                    <div class="muted" style="min-width:0;">
                      <div style="font-weight:700; color:#0f172a;">${esc(inv.email || "Any email")}</div>
                      <div>Role: ${esc(inv.role === "editor" ? "Editor" : "Creator")}</div>
                      <div>City: ${esc(inv.city || "Enumclaw")}</div>
                      <div>Created: ${esc(fmtPendingDate(inv.createdAt))}</div>
                      ${inv.expiresAt ? `<div>Expires: ${esc(fmtPendingDate(inv.expiresAt))}</div>` : ""}
                      <div>Status: ${esc(status)}</div>
                    </div>
                    <form method="POST" action="/admin/invites/${encodeURIComponent(inv.id)}/delete" onsubmit="return confirm('Delete this invite?');">
                      <button class="btn danger" type="submit">Delete</button>
                    </form>
                  </div>
                </div>
              `;
            })
            .join("")
        : `<div class="muted">No invites yet.</div>`;
    }

    let usersHtml = "";
    if (showUsers) {
      const rows = await all(
        "SELECT id, email, username, role, city, createdAt FROM users ORDER BY datetime(createdAt) DESC"
      );
      const notice = String(req.query.notice || "");
      const noticeHtml =
        notice === "sent"
          ? `<div class="mini" style="margin-bottom:10px; border-color:rgba(16,185,129,.35); color:#065f46;">Invite email sent.</div>`
          : notice === "no_email"
          ? `<div class="mini" style="margin-bottom:10px; border-color:rgba(239,68,68,.35); color:#991b1b;">User has no email on file.</div>`
          : notice === "send_failed"
          ? `<div class="mini" style="margin-bottom:10px; border-color:rgba(239,68,68,.35); color:#991b1b;">Failed to send email. Check SMTP logs.</div>`
          : "";
      usersHtml = rows.length
        ? noticeHtml +
          rows
            .map((u) => {
              const labelRole = u.role === "editor" ? "Editor" : u.role === "creator" ? "Creator" : "Admin";
              return `
                <div class="mini" style="margin-bottom:10px;">
                  <div style="display:flex; justify-content:space-between; gap:12px; align-items:flex-start; flex-wrap:wrap;">
                    <div class="muted" style="min-width:0;">
                      <div style="font-weight:700; color:#0f172a;">${esc(u.username || u.email || "User")}</div>
                      <div>Email: ${esc(u.email || "—")}</div>
                      <div>Role: ${esc(labelRole)}</div>
                      <div>City: ${esc(u.city || "Enumclaw")}</div>
                      <div>Created: ${esc(fmtPendingDate(u.createdAt))}</div>
                    </div>
                    <div style="display:flex; gap:8px; flex-wrap:wrap;">
                      <form method="POST" action="/admin/users/${encodeURIComponent(u.id)}/resend-invite" onsubmit="return confirm('Resend invite email to this user?');">
                        <button class="btn" type="submit">Resend invite</button>
                      </form>
                      <form method="POST" action="/admin/users/${encodeURIComponent(u.id)}/reset" onsubmit="return confirm('Send a password reset email to this user?');">
                        <button class="btn" type="submit">Reset Password</button>
                      </form>
                      <form method="POST" action="/admin/users/${encodeURIComponent(u.id)}/role">
                        <select name="role" class="ctrl" style="min-width:140px;">
                          <option value="creator" ${u.role === "creator" ? "selected" : ""}>Creator</option>
                          <option value="editor" ${u.role === "editor" ? "selected" : ""}>Editor</option>
                          <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
                        </select>
                        <select name="city" class="ctrl" style="min-width:140px;">
                          <option value="Enumclaw" ${u.city === "Enumclaw" ? "selected" : ""}>Enumclaw</option>
                          <option value="Buckley" ${u.city === "Buckley" ? "selected" : ""}>Buckley</option>
                        </select>
                        <button class="btn" type="submit">Update</button>
                      </form>
                      <form method="POST" action="/admin/users/${encodeURIComponent(u.id)}/delete" onsubmit="return confirm('Delete this user?');">
                        <button class="btn danger" type="submit">Delete</button>
                      </form>
                    </div>
                  </div>
                </div>
              `;
            })
            .join("")
        : `<div class="muted">No users yet.</div>`;
    }

    let editJob = null;
    if (showJobsCreate && req.query.edit) {
      const jobId = parseInt(String(req.query.edit), 10);
      if (!Number.isNaN(jobId)) {
        editJob = await get("SELECT * FROM jobs WHERE id = ?", [jobId]);
      }
    }

    let editVenue = null;
    if (showVenueCreate && req.query.edit) {
      const venueId = parseInt(String(req.query.edit), 10);
      if (!Number.isNaN(venueId)) {
        editVenue = await get("SELECT * FROM venues WHERE id = ?", [venueId]);
      }
    }
    if (showAdsCreate) {
      await ensureAdSchema();
    }
    let editAd = null;
    if (showAdsCreate && req.query.edit) {
      await ensureAdSchema();
      const adId = parseInt(String(req.query.edit), 10);
      if (!Number.isNaN(adId)) {
        editAd = await get("SELECT * FROM ads WHERE id = ?", [adId]);
      }
    }
    const venueDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const venueHours = (() => {
      const out = {};
      for (const d of venueDays) out[d] = { open: "", close: "", closed: false };
      const parsed = safeParseJson(editVenue?.hoursJson, null);
      if (parsed && typeof parsed === "object") {
        for (const d of venueDays) {
          const row = parsed[d] || {};
          out[d] = {
            open: String(row.open || ""),
            close: String(row.close || ""),
            closed: row.closed === true || String(row.closed || "") === "1",
          };
        }
      }
      return out;
    })();
    const selectedVenueCats = normalizeVenueCategories(safeParseJson(editVenue?.categoriesJson, []));
    const venueGallery = normalizeGalleryImages(safeParseJson(editVenue?.galleryJson, []), 3);
    const venueSocial = (() => {
      const parsed = safeParseJson(editVenue?.socialJson, null);
      const obj = (parsed && typeof parsed === "object") ? parsed : {};
      return {
        facebook: String(obj.facebook || ""),
        instagram: String(obj.instagram || ""),
        x: String(obj.x || ""),
        tiktok: String(obj.tiktok || ""),
        youtube: String(obj.youtube || ""),
        linkedin: String(obj.linkedin || ""),
      };
    })();

    let venueRows = [];
    let venueTotal = 0;
    let venuePages = 1;
    let venueShowingFrom = 0;
    let venueShowingTo = 0;
    let venueByCity = [];

    let jobRows = [];
    let jobTotal = 0;
    let jobPages = 1;
    let jobShowingFrom = 0;
    let jobShowingTo = 0;
    let jobApplicantsRows = [];
    let jobApplicantsTotal = 0;
    let jobApplicantsPages = 1;
    let jobApplicantsShowingFrom = 0;
    let jobApplicantsShowingTo = 0;
    let jobApplicantStats = {
      total: 0,
      newCount: 0,
      reviewedCount: 0,
      interviewCount: 0,
      hiredCount: 0,
      rejectedCount: 0,
    };
    let jobTypeRows = [];
    let jobAnalyticsStats = {
      total: 0,
      active: 0,
      paused: 0,
      filled: 0,
      views: 0,
      withImage: 0,
      withPay: 0,
      withApplyUrl: 0,
      avgViews: 0,
    };
    let adRows = [];
    let adTotal = 0;
    let adPages = 1;
    let adShowingFrom = 0;
    let adShowingTo = 0;
    let adAnalyticsStats = {
      total: 0,
      active: 0,
      paused: 0,
      views: 0,
      clicks: 0,
      avgViews: 0,
      avgClicks: 0,
    };
    let adTopViewsRows = [];
    let adTopClicksRows = [];
    let adPlacementRows = [];
    let adAnalyticsOptions = [];
    let adMonthlyHistory = [];
    let selectedAd = null;
    let selectedAdActualId = null;

    if (showJobsExisting) {
      const jobWhere = [];
      const jobParams = [];
      if (selectedCity) {
        jobWhere.push("city = ?");
        jobParams.push(selectedCity);
      }
      if (q) {
        const like = "%" + q + "%";
        jobWhere.push("(title LIKE ? OR company LIKE ? OR slug LIKE ? OR location LIKE ? OR CAST(id AS TEXT) LIKE ?)");
        jobParams.push(like, like, like, like, like);
      }
      const jobWhereSql = jobWhere.length ? ("WHERE " + jobWhere.join(" AND ")) : "";
      const jobTotalRow = await get("SELECT COUNT(*) AS n FROM jobs " + jobWhereSql, jobParams);
      jobTotal = Number(jobTotalRow?.n || 0);
      jobPages = Math.max(1, Math.ceil(jobTotal / limit));
      jobShowingFrom = jobTotal ? offset + 1 : 0;
      jobShowingTo = Math.min(offset + limit, jobTotal);

      jobRows = await all(
        "SELECT id, city, slug, title, company, location, employmentType, salaryRange, applyUrl, imageUrl, description, status, viewCount, createdAt " +
        "FROM jobs " + jobWhereSql + " ORDER BY datetime(createdAt) DESC, id DESC LIMIT ? OFFSET ?",
        [...jobParams, limit, offset]
      );
    }

    if (showJobsApplicants) {
      const applicantWhere = [];
      const applicantParams = [];
      if (selectedCity) {
        applicantWhere.push("j.city = ?");
        applicantParams.push(selectedCity);
      }
      if (q) {
        const like = "%" + q + "%";
        applicantWhere.push("(a.firstName LIKE ? OR a.lastName LIKE ? OR a.email LIKE ? OR a.phone LIKE ? OR j.title LIKE ? OR j.company LIKE ? OR CAST(a.id AS TEXT) LIKE ?)");
        applicantParams.push(like, like, like, like, like, like, like);
      }
      const applicantWhereSql = applicantWhere.length ? ("WHERE " + applicantWhere.join(" AND ")) : "";
      const applicantTotalRow = await get(
        "SELECT COUNT(*) AS n FROM job_applicants a LEFT JOIN jobs j ON j.id = a.jobId " + applicantWhereSql,
        applicantParams
      );
      jobApplicantsTotal = Number(applicantTotalRow?.n || 0);
      jobApplicantsPages = Math.max(1, Math.ceil(jobApplicantsTotal / limit));
      jobApplicantsShowingFrom = jobApplicantsTotal ? offset + 1 : 0;
      jobApplicantsShowingTo = Math.min(offset + limit, jobApplicantsTotal);

      jobApplicantsRows = await all(
        "SELECT a.id, a.jobId, a.firstName, a.lastName, a.email, a.phone, a.resumeUrl, a.coverLetter, a.status, a.source, a.createdAt, " +
        "j.title AS jobTitle, j.company AS jobCompany, j.city AS jobCity " +
        "FROM job_applicants a LEFT JOIN jobs j ON j.id = a.jobId " +
        applicantWhereSql + " ORDER BY datetime(a.createdAt) DESC, a.id DESC LIMIT ? OFFSET ?",
        [...applicantParams, limit, offset]
      );

      const applicantStatsRow = await get(
        "SELECT " +
        "COUNT(*) AS total, " +
        "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'new' THEN 1 ELSE 0 END),0) AS newCount, " +
        "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'reviewed' THEN 1 ELSE 0 END),0) AS reviewedCount, " +
        "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'interview' THEN 1 ELSE 0 END),0) AS interviewCount, " +
        "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'hired' THEN 1 ELSE 0 END),0) AS hiredCount, " +
        "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'rejected' THEN 1 ELSE 0 END),0) AS rejectedCount " +
        "FROM job_applicants a LEFT JOIN jobs j ON j.id = a.jobId " + applicantWhereSql,
        applicantParams
      );
      jobApplicantStats = {
        total: Number(applicantStatsRow?.total || 0),
        newCount: Number(applicantStatsRow?.newCount || 0),
        reviewedCount: Number(applicantStatsRow?.reviewedCount || 0),
        interviewCount: Number(applicantStatsRow?.interviewCount || 0),
        hiredCount: Number(applicantStatsRow?.hiredCount || 0),
        rejectedCount: Number(applicantStatsRow?.rejectedCount || 0),
      };
    }

    if (showJobsAnalytics || showDashboard) {
      const jobCityWhere = [];
      const jobCityParams = [];
      if (selectedCity) {
        jobCityWhere.push("city = ?");
        jobCityParams.push(selectedCity);
      }
      const jobCityWhereSql = jobCityWhere.length ? ("WHERE " + jobCityWhere.join(" AND ")) : "";
      const row = await get(
        "SELECT " +
        "COUNT(*) AS total, " +
        "COALESCE(SUM(CASE WHEN lower(COALESCE(status,'')) = 'active' THEN 1 ELSE 0 END),0) AS activeCount, " +
        "COALESCE(SUM(CASE WHEN lower(COALESCE(status,'')) = 'paused' THEN 1 ELSE 0 END),0) AS pausedCount, " +
        "COALESCE(SUM(CASE WHEN lower(COALESCE(status,'')) = 'filled' THEN 1 ELSE 0 END),0) AS filledCount, " +
        "COALESCE(SUM(COALESCE(viewCount,0)),0) AS viewsCount, " +
        "COALESCE(SUM(CASE WHEN imageUrl IS NOT NULL AND trim(imageUrl) <> '' THEN 1 ELSE 0 END),0) AS withImageCount, " +
        "COALESCE(SUM(CASE WHEN salaryRange IS NOT NULL AND trim(salaryRange) <> '' THEN 1 ELSE 0 END),0) AS withPayCount, " +
        "COALESCE(SUM(CASE WHEN applyUrl IS NOT NULL AND trim(applyUrl) <> '' THEN 1 ELSE 0 END),0) AS withApplyUrlCount " +
        "FROM jobs " + jobCityWhereSql,
        jobCityParams
      );
      const totalJobs = Number(row?.total || 0);
      const totalViews = Number(row?.viewsCount || 0);
      jobAnalyticsStats = {
        total: totalJobs,
        active: Number(row?.activeCount || 0),
        paused: Number(row?.pausedCount || 0),
        filled: Number(row?.filledCount || 0),
        views: totalViews,
        withImage: Number(row?.withImageCount || 0),
        withPay: Number(row?.withPayCount || 0),
        withApplyUrl: Number(row?.withApplyUrlCount || 0),
        avgViews: totalJobs ? Math.round(totalViews / totalJobs) : 0,
      };

      jobTypeRows = await all(
        "SELECT COALESCE(NULLIF(trim(employmentType), ''), '(unspecified)') AS employmentType, COUNT(*) AS n " +
        "FROM jobs " + jobCityWhereSql + " GROUP BY employmentType ORDER BY n DESC, employmentType ASC",
        jobCityParams
      );

      if (!showJobsApplicants) {
        const applicantStatsRow = await get(
          "SELECT " +
          "COUNT(*) AS total, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'new' THEN 1 ELSE 0 END),0) AS newCount, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'reviewed' THEN 1 ELSE 0 END),0) AS reviewedCount, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'interview' THEN 1 ELSE 0 END),0) AS interviewCount, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'hired' THEN 1 ELSE 0 END),0) AS hiredCount, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'rejected' THEN 1 ELSE 0 END),0) AS rejectedCount " +
          "FROM job_applicants a LEFT JOIN jobs j ON j.id = a.jobId " +
          (selectedCity ? "WHERE j.city = ?" : ""),
          selectedCity ? [selectedCity] : []
        );
        jobApplicantStats = {
          total: Number(applicantStatsRow?.total || 0),
          newCount: Number(applicantStatsRow?.newCount || 0),
          reviewedCount: Number(applicantStatsRow?.reviewedCount || 0),
          interviewCount: Number(applicantStatsRow?.interviewCount || 0),
          hiredCount: Number(applicantStatsRow?.hiredCount || 0),
          rejectedCount: Number(applicantStatsRow?.rejectedCount || 0),
        };
      }
    }

    if (showAdsExisting || showAdsAnalytics) {
      await ensureAdSchema();
      const adWhere = [];
      const adParams = [];
      if (selectedCity) {
        adWhere.push("city = ?");
        adParams.push(selectedCity);
      }
      if (q) {
        const like = "%" + q + "%";
        adWhere.push("(name LIKE ? OR slug LIKE ? OR placement LIKE ? OR targetUrl LIKE ? OR CAST(id AS TEXT) LIKE ?)");
        adParams.push(like, like, like, like, like);
      }
      const adWhereSql = adWhere.length ? ("WHERE " + adWhere.join(" AND ")) : "";
      const adTotalRow = await get("SELECT COUNT(*) AS n FROM ads " + adWhereSql, adParams);
      adTotal = Number(adTotalRow?.n || 0);
      adPages = Math.max(1, Math.ceil(adTotal / limit));
      adShowingFrom = adTotal ? offset + 1 : 0;
      adShowingTo = Math.min(offset + limit, adTotal);

      if (showAdsExisting) {
        adRows = await all(
          "SELECT id, city, slug, name, placement, imageUrl, targetUrl, altText, visibilityPercent, status, startsAt, endsAt, notes, viewCount, clickCount, createdAt " +
          "FROM ads " + adWhereSql + " ORDER BY datetime(createdAt) DESC, id DESC LIMIT ? OFFSET ?",
          [...adParams, limit, offset]
        );
      }

      if (showAdsAnalytics) {
        const adDashWhere = [];
        const adDashParams = [];
        if (selectedCity) {
          adDashWhere.push("city = ?");
          adDashParams.push(selectedCity);
        }
        const adDashWhereSql = adDashWhere.length ? ("WHERE " + adDashWhere.join(" AND ")) : "";

        const row = await get(
          "SELECT " +
          "COUNT(*) AS total, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(status,'')) = 'active' THEN 1 ELSE 0 END),0) AS activeCount, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(status,'')) = 'paused' THEN 1 ELSE 0 END),0) AS pausedCount, " +
          "COALESCE(SUM(COALESCE(viewCount,0)),0) AS viewsCount, " +
          "COALESCE(SUM(COALESCE(clickCount,0)),0) AS clicksCount " +
          "FROM ads " + adDashWhereSql,
          adDashParams
        );
        const totalAds = Number(row?.total || 0);
        const totalViews = Number(row?.viewsCount || 0);
        const totalClicks = Number(row?.clicksCount || 0);
        adAnalyticsStats = {
          total: totalAds,
          active: Number(row?.activeCount || 0),
          paused: Number(row?.pausedCount || 0),
          views: totalViews,
          clicks: totalClicks,
          avgViews: totalAds ? Math.round(totalViews / totalAds) : 0,
          avgClicks: totalAds ? Math.round(totalClicks / totalAds) : 0,
        };

        adTopViewsRows = await all(
          "SELECT id, name, slug, placement, COALESCE(viewCount, 0) AS viewCount FROM ads " +
          adDashWhereSql + " ORDER BY COALESCE(viewCount,0) DESC, id DESC LIMIT 8",
          adDashParams
        );
        adTopClicksRows = await all(
          "SELECT id, name, slug, placement, COALESCE(clickCount, 0) AS clickCount FROM ads " +
          adDashWhereSql + " ORDER BY COALESCE(clickCount,0) DESC, id DESC LIMIT 8",
          adDashParams
        );
        adPlacementRows = await all(
          "SELECT COALESCE(NULLIF(trim(placement), ''), 'default') AS placement, COUNT(*) AS n FROM ads " +
          adDashWhereSql + " GROUP BY placement ORDER BY n DESC, placement ASC",
          adDashParams
        );
        adAnalyticsOptions = await all(
          "SELECT id, name, slug, placement, COALESCE(viewCount,0) AS viewCount, COALESCE(clickCount,0) AS clickCount FROM ads " +
          adDashWhereSql + " ORDER BY name COLLATE NOCASE ASC, id ASC",
          adDashParams
        );

        const selectedAdIdRaw = parseInt(String(req.query.ad || ""), 10);
        const requestedAdId = Number.isInteger(selectedAdIdRaw) && selectedAdIdRaw > 0 ? selectedAdIdRaw : null;
        selectedAd =
          (requestedAdId ? adAnalyticsOptions.find((ad) => Number(ad.id || 0) === requestedAdId) : null) ||
          adAnalyticsOptions[0] ||
          null;
        selectedAdActualId = selectedAd ? Number(selectedAd.id || 0) : null;

        if (selectedAdActualId) {
          const monthlyRows = await all(
            `SELECT strftime('%Y-%m', createdAt) AS ym,
                    COALESCE(SUM(CASE WHEN metric = 'view' THEN 1 ELSE 0 END), 0) AS views,
                    COALESCE(SUM(CASE WHEN metric = 'click' THEN 1 ELSE 0 END), 0) AS clicks
             FROM ad_metric_events
             WHERE adId = ?
               AND date(createdAt) >= date('now', 'start of month', '-11 month')
             GROUP BY ym
             ORDER BY ym ASC`,
            [selectedAdActualId]
          );
          const monthlyMap = new Map(
            (monthlyRows || []).map((item) => [
              String(item.ym || ""),
              {
                views: Number(item.views || 0),
                clicks: Number(item.clicks || 0),
              },
            ])
          );
          const monthCursor = new Date();
          monthCursor.setDate(1);
          for (let i = 11; i >= 0; i--) {
            const dt = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - i, 1);
            const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
            const base = monthlyMap.get(ym) || { views: 0, clicks: 0 };
            adMonthlyHistory.push({
              ym,
              label: dt.toLocaleString("en-US", { month: "short", year: "numeric" }),
              views: base.views,
              clicks: base.clicks,
            });
          }
        }
      }
    }

    if (showVenueExisting || showVenueAnalytics) {
      const venueWhere = [];
      const venueParams = [];
      if (selectedCity) {
        venueWhere.push("city = ?");
        venueParams.push(selectedCity);
      }
      if (q) {
        const like = `%${q}%`;
        venueWhere.push("(name LIKE ? OR slug LIKE ? OR address LIKE ? OR CAST(id AS TEXT) LIKE ?)");
        venueParams.push(like, like, like, like);
      }
      const venueWhereSql = venueWhere.length ? `WHERE ${venueWhere.join(" AND ")}` : "";
      const venueTotalRow = await get(`SELECT COUNT(*) AS n FROM venues ${venueWhereSql}`, venueParams);
      venueTotal = Number(venueTotalRow?.n || 0);
      venuePages = Math.max(1, Math.ceil(venueTotal / limit));
      venueShowingFrom = venueTotal ? offset + 1 : 0;
      venueShowingTo = Math.min(offset + limit, venueTotal);

      if (showVenueExisting) {
        venueRows = await all(
          `SELECT id, city, slug, name, address, website, phone, imageUrl, categoriesJson, socialJson, galleryJson, description, viewCount, phoneClickCount, websiteClickCount, socialClickCount, createdAt
           FROM venues
           ${venueWhereSql}
           ORDER BY datetime(createdAt) DESC, id DESC
           LIMIT ? OFFSET ?`,
          [...venueParams, limit, offset]
        );
      }

      if (showVenueAnalytics) {
        venueByCity = await all(
          `SELECT city, COUNT(*) AS n
           FROM venues
           ${selectedCity ? "WHERE city = ?" : ""}
           GROUP BY city
           ORDER BY n DESC, city ASC`,
          selectedCity ? [selectedCity] : []
        );
      }
    }

    const adChartDataJson = JSON.stringify({
      views: {
        labels: adMonthlyHistory.map((row) => row.label),
        values: adMonthlyHistory.map((row) => Number(row.views || 0)),
      },
      clicks: {
        labels: adMonthlyHistory.map((row) => row.label),
        values: adMonthlyHistory.map((row) => Number(row.clicks || 0)),
      },
    });

    const pageTitleBase = showCreate
      ? "Create Events"
      : showApprove
      ? "Approve Events"
      : showExisting
      ? "All Events"
      : showVenueCreate
      ? "Create Venue"
      : showVenueExisting
      ? "All Venues"
      : showVenueAnalytics
      ? "Venue Analytics"
      : showJobsCreate
      ? "Create Job"
      : showJobsExisting
      ? "All Jobs"
      : showJobsApplicants
      ? "Job Applicants"
      : showJobsAnalytics
      ? "Job Analytics"
      : showAdsCreate
      ? "Create Ad"
      : showAdsExisting
      ? "All Ads"
      : showAdsAnalytics
      ? "Ads Analytics"
      : showPreferences
      ? "Preferences"
      : showUsers
      ? "Users"
      : showInvites
      ? "Invites"
      : "Dashboard";
    const eventsMenuOpen = showExisting || showCreate || showApprove || showAnalytics;
    const venuesMenuOpen = showVenueExisting || showVenueCreate || showVenueAnalytics;
    const jobsMenuOpen = showJobsExisting || showJobsCreate || showJobsApplicants || showJobsAnalytics;
    const adsMenuOpen = showAdsExisting || showAdsCreate || showAdsAnalytics;
    const adminMenuOpen = showUsers || showInvites || showPreferences;
    const pageTitle = `OpenCircle | ${pageTitleBase}`;

    res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="/assets/brand/favicon.ico" />
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.2/css/all.min.css" crossorigin="anonymous" referrerpolicy="no-referrer" />
    <title>${pageTitle}</title>
    <style>
      :root{
        /* Main (light, WordPress-like) */
        --bg:#edf2f7;
        --panel:#ffffff;
        --panel2:#f6f9fc;
        --text:#0f172a;
        --muted:#526377;
        --line:rgba(15,23,42,.10);
        --brand:#00c08b;
        --brand2:#0ea5e9;
        --danger:#ef4444;
        --shadow:none;
        --radius:12px;
        --radius-inner:10px;
        --radius2:12px;
        --event-side-h: 140px;
        --ctrl-h: 44px;
        --gap:20px;

        /* Sidebar (dark) */
        --sidebar-bg:#0b1220;
        --sidebar-panel:#0f172a;
        --sidebar-text:#f0f0f1;
        --sidebar-muted:#a7aaad;
        --sidebar-line:rgba(240,246,252,.08);
      }

      *{ box-sizing:border-box; }
      body{
        margin:0;
        background:var(--bg);
        color:var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
        line-height:1.45;
      }

      /* Layout */
      .app{ display:flex; min-height:100vh; }

      .sidebar{
        width:220px;
        background:var(--sidebar-panel);
        border-right:1px solid var(--sidebar-line);
        padding:5px 18px 18px;
        position:sticky; top:0; height:100vh; overflow-y:auto; overflow-x:visible;
        display:flex; flex-direction:column;
        color:var(--sidebar-text);
        z-index: 80;
      }
      .sidebar .card{
        background: rgba(255,255,255,.04);
        border-color: var(--sidebar-line);
        color: var(--sidebar-text);
        box-shadow:none;
      }
      .sidebar .card .muted{ color: var(--sidebar-muted); }
      .sb-brand{
        display:flex; align-items:center; justify-content:flex-start; margin-bottom:0;
        margin-left:-18px;
        margin-right:-18px;
        margin-top:-18px;
        padding:18px 18px 0;
      }
      .sb-top{
        display:flex;
        align-items:center;
        gap:6px;
        width:100%;
        position: relative;
        padding-bottom:10px;
      }
      .sb-icon{
        position: relative;
        width: 28px;
        height: 42px;
        display:flex;
        align-items:center;
        justify-content:center;
        flex: 0 0 28px;
      }
      .sb-icon::after{
        content:"";
        position:absolute;
        top:0;
        bottom:-10px;
        right:-20px;
        width:1px;
        background: var(--sidebar-line);
      }
      .sb-top::after{
        content:"";
        position:absolute;
        left:-18px;
        right:-18px;
        bottom:0;
        height:1px;
        background: var(--sidebar-line);
      }
      .sb-divider{
        height:1px;
        background: var(--sidebar-line);
        margin: 0 -18px;
      }
      .sb-city-wrap{
        position: relative;
        height:38px;
        width: calc(100% + 36px - 40px);
        margin-left: calc(-18px + 40px);
        margin-right: -18px;
        margin-top: 0;
        margin-bottom: 0;
      }
      .sb-city-dd{
        position: relative;
        height:100%;
      }
      .sb-city-btn{
        width:100%;
        height:100%;
        display:flex;
        align-items:center;
        gap:10px;
        padding:0 20px 0 18px;
        border:0;
        background: transparent;
        color: var(--sidebar-text);
        font-weight:600;
        font-size:13px;
        cursor:pointer;
        text-align:left;
        outline:none;
        box-shadow:none;
        -webkit-tap-highlight-color: transparent;
      }
      .sb-city-btn:focus,
      .sb-city-btn:focus-visible{
        outline:none;
        box-shadow:none;
      }
      .sb-city-btn:active{
        background: transparent;
        box-shadow:none;
        outline:none;
      }
      .sb-city-btn .caret{
        margin-left:auto;
        width:10px;
        height:14px;
        position:relative;
      }
      .sb-city-btn .caret::before,
      .sb-city-btn .caret::after{
        content:"";
        position:absolute;
        left:50%;
        width:4px;
        height:4px;
        border-right:1.5px solid rgba(229,231,235,.75);
        border-bottom:1.5px solid rgba(229,231,235,.75);
        transform-origin:center;
      }
      .sb-city-btn .caret::before{
        top:0;
        transform: translateX(-50%) rotate(-135deg);
      }
      .sb-city-btn .caret::after{
        bottom:0;
        transform: translateX(-50%) rotate(45deg);
      }
      .sb-city-menu{
        position:absolute;
        top:100%;
        left: 0;
        right: 0;
        width:auto;
        box-sizing:border-box;
        margin-top:0;
        background: var(--sidebar-panel);
        border:1px solid var(--sidebar-line);
        border-radius:0;
        padding:0;
        display:none;
        z-index: 30;
        box-shadow: none;
      }
      .sb-city-dd.is-open .sb-city-menu{ display:block; }
      .sb-city-opt{
        width:100%;
        border:0;
        background: transparent;
        padding:10px 12px;
        text-align:left;
        border-radius:0;
        font-weight:600;
        font-size:14px;
        color: var(--sidebar-text);
        cursor:pointer;
      }
      .sb-city-opt:hover{ background: rgba(255,255,255,.05); }
      .sb-city-opt.is-active{
        background: rgba(0,192,139,.12);
        color: var(--sidebar-text);
      }
      .sb-brand img{
        width:22px;
        max-width:22px;
        height:22px;
        display:block;
      }
      .sb-title{ font-weight:650; letter-spacing:.2px; }
      .sb-sub{ font-size:12px; color:var(--sidebar-muted); margin-top:2px; }

      .nav{
        display:grid;
        gap:0;
        margin:0 -18px 0;
        width:calc(100% + 36px);
        position:relative;
        z-index:5;
      }
      .nav-group{
        display:grid;
        gap:0;
        position:relative;
      }
      .nav-title-btn{
        appearance:none;
        border:0;
        background:transparent;
        width:100%;
        height:39.5px;
        display:flex;
        align-items:center;
        text-align:left;
        color:#f0f0f1;
        font-size:14px;
        font-weight:400;
        letter-spacing:0;
        text-transform:none;
        line-height:1.25;
        padding:0 10px;
        cursor:pointer;
      }
      .nav-title-btn,
      .nav-title-btn:visited,
      .nav-title-btn:active,
      .nav-title-btn:focus{
        color:#ffffff !important;
        text-decoration:none;
      }
      .nav-title-btn .nav-title-icon{
        margin-right:6px;
        width:18px;
        text-align:center;
        font-size:16px;
        opacity:.95;
      }
      .nav-title-btn:hover{
        color:#ffffff;
        background: rgba(255,255,255,.04);
      }
      .nav-group.is-open > .nav-title-btn{
        background:var(--brand);
        color:#ffffff;
        position:relative;
        border-radius:0;
        margin:0;
      }
      .nav-group.is-open > .nav-title-btn::after{
        content:none;
        position:absolute;
        right:10px;
        top:50%;
        transform:translateY(-50%);
        width:0;
        height:0;
        border-top:8px solid transparent;
        border-bottom:8px solid transparent;
        border-right:8px solid #ffffff;
      }
      .nav-title-btn:focus{
        outline:none;
      }
      .nav-sub{
        position:static;
        left:auto;
        top:auto;
        min-width:0;
        width:100%;
        display:grid;
        gap:0;
        margin: 0;
        padding: 0;
        background: rgba(255,255,255,.03);
        border-top:1px solid var(--sidebar-line);
        border-bottom:1px solid var(--sidebar-line);
        border-left:0;
        border-right:0;
        border-radius:0;
        box-shadow:none;
        max-height:0;
        overflow:hidden;
        opacity:0;
        transform:none;
        pointer-events:none;
        transition:max-height .2s ease, opacity .15s ease, padding .2s ease;
        z-index:1;
      }
      .nav-group.is-open .nav-sub,
      .nav-group:focus-within .nav-sub{
        max-height:900px;
        opacity:1;
        padding: 0;
        pointer-events:auto;
      }
      .subnav-link{
        text-decoration:none;
        color:#7f8a97 !important;
        display:flex;
        align-items:center;
        padding:10px 14px;
        font-weight:400;
        font-size:14px;
        line-height:1.25;
        border-left:0;
        white-space:normal;
      }
      .subnav-link:hover{
        color:#ffffff;
        background: rgba(255,255,255,.08);
      }
      .subnav-link.active{
        color:#ffffff !important;
        background: transparent;
        border-color: transparent !important;
        box-shadow:none !important;
        font-weight:600;
      }
      .subnav-link:visited,
      .subnav-link:focus,
      .subnav-link:active{
        color:#7f8a97 !important;
      }
      .subnav-link.active:visited,
      .subnav-link.active:focus,
      .subnav-link.active:active{
        color:#ffffff !important;
      }
      .subnav-link:focus,
      .subnav-link:active,
      .subnav-link:visited{
        text-decoration:none;
      }
      .sb-bottom{ margin-top:auto; display:grid; gap:4px; }
      .sidebar .mini a{ color:#38bdf8; font-weight:600; }
      .sidebar .mini a:hover{ color:#7dd3fc; }

      /* Keep sidebar widgets dark (Quick links / Tip) */
      .sidebar .mini{
        border: 1px solid var(--sidebar-line);
        background: rgba(255,255,255,.04);
        color: var(--sidebar-text);
      }
      .sidebar .mini .small{ color: var(--sidebar-muted); }
      .sidebar .note{ color: var(--sidebar-muted); }

      /* Sidebar checkboxes should stay dark */
      .sidebar input[type="checkbox"]{
        border-color: rgba(148,163,184,.35) !important;
        background: rgba(255,255,255,.04) !important;
      }
      .sidebar .note{ color: var(--sidebar-muted); }
      .nav a{
        text-decoration:none; color:var(--sidebar-text);
        display:flex; align-items:center; gap:10px;
        padding:10px 18px; border-radius: 0;
        border:1px solid transparent;
        font-weight:400; font-size:15px;
        width:100%;
        margin:0;
      }
      .nav a:hover,
      .nav a:focus,
      .nav a:active,
      .nav a:visited,
      .nav a.active{
        text-decoration:none !important;
      }
      .nav a .n-dot{
        width:8px; height:8px; border-radius:999px; background: rgba(100,116,139,.35);
      }
      .nav a.active{
        color:var(--sidebar-text);
        background: rgba(0,192,139,.10);
        border-color: rgba(0,192,139,.22);
        text-decoration:none;
      }
      .nav .subnav-link.active{
        background: transparent !important;
        border-color: transparent !important;
      }
      .nav a.active .n-dot{ background: var(--brand); }

      .main{
        flex:1;
        padding:24px;
        min-width:0;
        position: relative;
        z-index: 1;
      }

      /* Header */
      .header{
        display:flex; align-items:center; justify-content:space-between; gap:14px;
        margin-bottom:18px;
      }
      .h-left h1{ margin:0; font-size:30px; letter-spacing:-.02em; font-weight:700; line-height:1.1; }
      .h-left p{ margin:10px 0 0; color:var(--muted); font-size:15px; line-height:1.45; max-width:68ch; }
      .h-right{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .h-right{ flex:1; justify-content:flex-end; }
      .header-tools{
        display:flex;
        align-items:center;
        gap:10px;
      }
      .header-icon-btn{
        position:relative;
        width:40px;
        height:40px;
        border-radius:999px;
        border:1px solid var(--line);
        background:#fff;
        color:var(--muted);
        display:inline-flex;
        align-items:center;
        justify-content:center;
        text-decoration:none;
        box-shadow: none;
        transition: color .14s ease, border-color .14s ease, background-color .14s ease;
      }
      .header-icon-btn:hover{
        color: var(--text);
        border-color: rgba(15,23,42,.18);
        background: #f8fafc;
        box-shadow: none;
      }
      .header-icon-btn i{
        font-size:15px;
      }
      .header-account-name{
        font-size:13px;
        font-weight:600;
        color:var(--muted);
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
        max-width:180px;
      }
      .header-icon-btn .header-avatar{
        width:100%;
        height:100%;
        border-radius:999px;
        object-fit:cover;
        display:block;
      }
      .header-icon-btn .icon-badge{
        position:absolute;
        top:-4px;
        right:-4px;
        min-width:18px;
        height:18px;
        padding:0 5px;
        border-radius:999px;
        background:#ef4444;
        color:#fff;
        font-size:11px;
        font-weight:700;
        line-height:18px;
        text-align:center;
        border:2px solid var(--panel);
      }

      .search{
        display:flex; align-items:center; gap:10px;
        background:transparent;
        border:0;
        border-radius:0;
        padding: 0;
        width:100%;
        max-width:700px;
        position:relative;
      }
      .search::before{
        content:"\f002";
        font-family:"Font Awesome 6 Free";
        font-weight:900;
        position:absolute;
        left:14px;
        top:50%;
        transform:translateY(-50%);
        color:#6b7280;
        font-size:16px;
        pointer-events:none;
        z-index:2;
      }
      .search input{
        border:1px solid #e5e7eb;
        outline:none;
        background:#ffffff;
        border-radius:10px;
        width:auto;
        min-width:0;
        flex:1 1 auto;
        font-size:14px; font-weight:500; color:var(--text);
        height: var(--ctrl-h);
        padding:0 14px 0 42px;
      }
      .search input::placeholder{
        color:#9ca3af;
      }
      .search .btn{
        border-radius:10px;
        height:var(--ctrl-h);
      }

      /* Cards + widgets */
      .card{
        background:var(--panel);
        border:1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        padding: 18px;
      }

      /* Chart card uses the original dark treatment so the canvas grid/ticks remain legible */
      .chartCard{
  background: var(--panel);
  border-color: var(--line);
  box-shadow: var(--shadow);
  color: var(--text);
}
.chartCard h2,
.chartCard h3{
  color: var(--text);
}
.chartCard .muted,
.chartCard .statLine{
  color: var(--muted);
}

.metrics{
        display:grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap:var(--gap);
        margin-bottom:var(--gap);
      }
      .metric{
        display:flex; align-items:flex-end; justify-content:space-between; gap:10px;
        padding:16px;
        border-radius: var(--radius);
        background: var(--panel);
        border:1px solid var(--line);
        box-shadow: var(--shadow);
      }
      .metric .k{ color:var(--muted); font-size:12px; font-weight:600; }
      .metric .v{ font-size:22px; font-weight:650; letter-spacing:.2px; margin-top:6px; color: var(--text); }
      .metric .tag{
        font-size:12px; font-weight:650;
        padding:6px 10px; border-radius: var(--radius);
        background: rgba(0,192,139,.12);
        border: 1px solid rgba(0,192,139,.22);
        color: #065f46;
        white-space:nowrap;
      }
      .metric .tag.blue{
        background: rgba(14,165,233,.12);
        border-color: rgba(14,165,233,.20);
        color: #0c4a6e;
      }

      .grid2{
        display:grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap:var(--gap);
        margin-bottom:var(--gap);
        align-items: stretch;
      }
      .grid2 > .card{ height:100%; }
      .grid2 > .card:first-child{ grid-column: span 3; display:flex; flex-direction:column; }
      .grid2 > .card:last-child{ grid-column: span 1; display:flex; flex-direction:column; }

      .grid2 > .card:last-child .sectionTitle{ margin-bottom:12px; }
      .grid2 > .card:last-child .mini + .mini{ margin-top:var(--gap); }

      .grid4{
        display:grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap:var(--gap);
        margin-bottom:var(--gap);
        align-items: stretch;
      }
      .grid4 > .card{ height:100%; }

      .venue-analytics-grid2{
        display:grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap:var(--gap);
      }
      .venue-analytics-grid2 > .card{ height:100%; }

      .gridMain{
        display:grid;
        /* 40% Create form / 60% Existing events */
        grid-template-columns: 2fr 3fr;
        gap:var(--gap);
        align-items:start;
      }
      .gridMain.single{
        grid-template-columns: 1fr;
      }

      @media (max-width: 1100px){
        .metrics{ grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .grid2{ grid-template-columns: 1fr; }
        .grid4{ grid-template-columns: 1fr; }
        .venue-analytics-grid2{ grid-template-columns: 1fr; }
        .gridMain{ grid-template-columns: 1fr; }
        .rail{ display:none; }
        .sidebar{ display:none; }
        .main{ padding:16px; }
        .search input{ min-width: 160px; }
      }

      h2{ margin:0 0 10px; font-size:22px; font-weight:700; letter-spacing:-.01em; line-height:1.2; }
      .sub{ margin:0; color:var(--muted); font-size:14px; line-height:1.5; }

      /* Controls */
      label{ display:block; margin: 14px 0 6px; font-weight:600; font-size:12px; color:var(--text); }
      form[action="/admin/events"] label{ margin: 20px 0 6px; }
      form[action="/admin/events"] .rec-box{ margin-top: 22px; }
      form[action="/admin/events"] .rec-grid{ margin-top: 18px; }
      form[action="/admin/events"] .note{ margin-top: 8px; }
      .ctrl,
      input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),
      textarea,
      select{
        width:100%;
        padding: 10px 12px;
        border: 1px solid var(--line);
        border-radius: var(--radius-inner);
        background: #ffffff;
        color: var(--text);
        font-size: 14px;
        outline: none;
        height: var(--ctrl-h);
      }
      .rec-box{ margin-top:16px; }
      .rec-grid{ margin-top:16px; }
      .actions{ margin-top:18px; }
      .note{ margin-top:6px; }
      .json-badge{
        display:none;
        align-items:center;
        gap:6px;
        font-size:11px;
        font-weight:600;
        color:#0b1220;
        background:#bbf7d0;
        border:1px solid #86efac;
        border-radius:999px;
        padding:4px 8px;
      }
      .json-badge.on{ display:inline-flex; }

      /* File input */
      input[type="file"]{
        width:100%;
        padding:6px 12px;
        border: 1px solid var(--line);
        border-radius: var(--radius-inner);
        background: var(--panel2);
        color: var(--text);
        font-size: 14px;
        height: 60px;
        line-height: 1;
      }
      input[type="file"]::file-selector-button{
        margin-right: 12px;
        padding: 10px 12px;
        border-radius: var(--radius-inner);
        border: 1px solid var(--line);
        background: #ffffff;
        color: var(--text);
        font-weight:600;
        cursor:pointer;
      }
      input[type="file"]::file-selector-button:hover{
        background: #f1f5f9;
      }

      /* Square checkboxes */
      input[type="checkbox"]{
        width:18px;
        height:18px;
        border-radius:4px;
        border:1px solid var(--line);
        background:#ffffff;
        appearance:none;
        -webkit-appearance:none;
        display:inline-grid;
        place-content:center;
      }
      input[type="checkbox"]::before{
        content:"";
        width:10px;
        height:10px;
        transform: scale(0);
        transition: transform .08s ease-in-out;
        background: var(--brand);
        border-radius:2px;
      }
      input[type="checkbox"]:checked::before{
        transform: scale(1);
      }
      input[type="checkbox"]:focus{
        box-shadow: 0 0 0 4px rgba(0,192,139,.12);
        border-color: rgba(0,192,139,.35);
      }
      .ctrl:focus, input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):focus, textarea:focus, select:focus{
        box-shadow: 0 0 0 4px rgba(0,192,139,.12);
        border-color: rgba(0,192,139,.35);
        background: var(--panel);
      }


      /* Checkbox + file input (avoid stock UI) */
      input[type="checkbox"]{
        -webkit-appearance:none; appearance:none;
        width:18px !important; height:18px !important;
        border-radius:0px;
        border:1px solid rgba(148,163,184,.28);
        background: var(--panel);
        display:inline-grid; place-content:center;
        cursor:pointer;
      }
      input[type="checkbox"]::before{
        content:"";
        width:10px; height:10px;
        border-radius: 0 !important;
        transform: scale(0);
        transition: transform .12s ease;
        background: var(--brand);
      }
      input[type="checkbox"]:checked::before{ transform: scale(1); }
      input[type="checkbox"]:focus{ box-shadow: 0 0 0 4px rgba(0,192,139,.12); border-color: rgba(0,192,139,.35); }

      input[type="file"]{
        padding:10px;
        background: var(--panel2);
        color: var(--muted);
      }
      input[type="file"]::file-selector-button{
        margin:0 12px 0 0;
        border:1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        padding:0 16px;
        border-radius: var(--radius-inner);
        font-weight:600;
        cursor:pointer;
        height:38px;
        display:inline-flex;
        align-items:center;
        line-height: 38px;
      }
      input[type="file"]::-webkit-file-upload-button{
        margin:0 12px 0 0;
        border:1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        padding:0 16px;
        border-radius: var(--radius-inner);
        font-weight:600;
        cursor:pointer;
        height:38px;
        line-height:38px;
      }
      input[type="file"]::file-selector-button:hover{
        border-color: rgba(0,192,139,.28);
        box-shadow: 0 0 0 4px rgba(0,192,139,.10);
      }
      textarea{ height:auto; min-height: 110px; resize: vertical; }
      .note{ font-size: 12px; color: var(--muted); margin-top:8px; }

      .btn{
        display:inline-flex; align-items:center; justify-content:center;
        padding: 10px 14px;
        border-radius: var(--radius-inner);
        border: 1px solid var(--line);
        background: #ffffff;
        cursor:pointer;
        font-weight:650;
        text-decoration:none;
        color: var(--text);
        font-size:14px;
        line-height:1;
        height: var(--ctrl-h);
        transition: border-color .14s ease, background-color .14s ease, color .14s ease;
      }
      .btn:hover{ border-color: rgba(15,23,42,.18); background: #f8fafc; box-shadow:none; }
      .btn-primary{
        background: var(--brand);
        border-color: var(--brand);
        color:#ffffff;
      }
      .btn-primary:hover{ background: #00b681; border-color: #00b681; }
      .btn-danger{
        background: rgba(239,68,68,.10);
        border-color: rgba(239,68,68,.18);
        color: #991b1b;
      }
      .btn-link{
        background: transparent;
        border-color: transparent;
        color: var(--brand);
        padding: 8px 10px;
      }

      .actions{ display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-top: 14px; }
      .inline{ display:inline; margin:0; }
      .muted{ color: var(--muted); }

      a:not(.btn):not(.nav-title-btn):not(.subnav-link){ color: var(--brand2); text-decoration:none; font-weight:600; font-size:14px; }
      a:not(.btn):hover{ text-decoration:underline; }
      .event-actions a:not(.btn){ font-size:14px; }

      /* Small widgets */
      .mini{
        border: 1px solid var(--line);
        background: var(--panel2);
        border-radius: var(--radius-inner);
        padding: 14px;
      }
      .mini + .mini{ margin-top:var(--gap); }
      .kv{ display:flex; justify-content:space-between; align-items:center; margin: 10px 0; color:var(--muted); font-size:13px; }
      .kv .k{
        flex: 1 1 auto;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        padding-right: 10px;
      }
      .kv .v{
        flex: 0 0 auto;
      }
      /* spacing tweaks only for specific widgets */
      .mini-organizers{
        flex:1;
        display:flex;
        flex-direction:column;
        justify-content:space-between;
      }
      .mini-organizers .kv{
        margin: 14px 0;
        padding: 4px 0;
      }
      .mini-spaced .kv{
        margin: 14px 0;
        padding: 4px 0;
      }
      .kv strong{ color:var(--text); font-size:14px; text-align:right; }
      .sidebar .mini .kv{
        color: var(--sidebar-muted);
        font-size:11px;
        font-weight:600;
        opacity:.7;
      }
      .sidebar .mini .kv strong{
        color: var(--sidebar-muted);
        font-size:11px;
        font-weight:600;
        opacity:.7;
      }

      /* Chart */
      .chart-wrap{ position:relative; flex:1; min-height:0; }
      .chart-wrap canvas{ width:100%; height:100%; display:block; }

      .seg{
        display:inline-flex;
        align-items:center;
        gap:6px;
        padding:6px;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--panel2);
      }
      .seg button{
        appearance:none;
        border: 1px solid transparent;
        background: transparent;
        color: var(--muted);
        padding: 7px 10px;
        border-radius: 999px;
        font-weight: 650;
        font-size:14px;
        cursor: pointer;
        line-height: 1;
      }
      .seg button:hover{ color: var(--text); }
      .seg button.on{
        background: rgba(0,192,139,.14);
        border-color: rgba(0,192,139,.28);
        color: #065f46;
      }

      /* Existing events list */
      .event-card{
        border: 1px solid var(--line);
        border-radius: var(--radius);
        padding: 14px;
        background: var(--panel);
        display:flex;
        justify-content:space-between;
        gap:14px;
        align-items:center;
        box-shadow: none;
      }
      .event-left{ flex: 1; min-width: 0; display:flex; flex-direction:column; height: var(--event-side-h); justify-content:space-between; }
      .event-main{ min-width:0; }
      .event-title{ font-weight:700; margin-bottom:8px; font-size:17px; letter-spacing:-.01em; line-height:1.25; }
      .event-meta{ color: var(--muted); font-size: 14px; display:grid; gap:4px; line-height:1.45; }
      .event-actions{ margin-top:6px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }

      
      .event-actions .btn{ min-width: 96px; height:38px; font-size:14px; }
      .event-actions .btn{ padding: 8px 12px; }
.pill{
        font-size:12px;
        background: rgba(0,192,139,.12);
        border: 1px solid rgba(0,192,139,.22);
        padding: 6px 10px;
        border-radius: var(--radius-inner);
        font-weight:650;
        color:#065f46;
        display:inline-flex; align-items:center; gap:6px;
      }

      .event-thumb{
        width: 120px; flex: 0 0 120px;
        height: var(--event-side-h);
        align-self: flex-start;
      }
      .event-thumb-img{
        width: 120px; height: var(--event-side-h);
        object-fit: cover;
        border-radius: var(--radius-inner);
        border: 1px solid var(--line);
        display:block;
      }
      .thumb-empty,
      .thumb-fallback{
        width: 120px; height: var(--event-side-h);
        border-radius: var(--radius-inner);
        border: 1px solid var(--line);
        display:flex; align-items:center; justify-content:center;
        font-size: 12px; color: var(--muted);
        background: var(--panel2);
        text-align:center;
        padding: 8px;
      }
      .event-thumb .thumb-fallback{ display:none; }
      .event-thumb.broken .thumb-fallback{ display:flex; }

      .event-stats{
        width: 150px; flex: 0 0 150px;
        height: var(--event-side-h);
        border: 1px solid var(--line);
        border-radius: var(--radius-inner);
        padding: 10px;
        background: var(--panel2);
        display:flex;
        flex-direction:column;
        justify-content:space-between;
      }
      .event-card:not(.venue-card) .event-stats{
        width: 230px;
        flex: 0 0 230px;
        display:grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px 12px;
        align-content: start;
      }
      .stat{ display:flex; justify-content:space-between; align-items:center; font-size: 13px; color: var(--muted); margin: 6px 0; }
      .event-card:not(.venue-card) .event-stats .stat{ margin: 0; }
      .stat strong{ color: var(--text); font-size: 16px; }

      /* Venue list can be taller than event cards; avoid clipping/overflow */
      .event-card.venue-card{ align-items:flex-start; }
      .event-card.venue-card .event-left{
        height: auto;
        min-height: var(--event-side-h);
        justify-content: flex-start;
      }
      .event-card.venue-card .event-actions{ margin-top: 12px; }
      .event-card.venue-card .event-meta{ overflow-wrap: anywhere; }
      .event-card.venue-card .event-stats{
        height: auto;
        min-height: var(--event-side-h);
        justify-content: flex-start;
      }
      .event-card.venue-card .event-stats .stat{ margin: 4px 0; }

      .pager{
        display:grid;
        grid-template-columns: 1fr auto;
        align-items:center;
        gap:var(--gap);
        margin: 10px 0 14px;
      }
      .pager-right{ display:flex; align-items:center; gap:12px; flex-wrap:wrap; justify-self:end; }
      .pager-left{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; min-width:0; }

      /* Existing events: keep Clear inline with search (wrap only on small screens) */
	      .eventsFilters{
	        border: 1px solid var(--line);
	        background: linear-gradient(180deg, #ffffff 0%, #f8fbfd 100%);
	        border-radius: var(--radius);
	        padding: 14px;
	        margin: 10px 0 14px;
	        display: grid;
	        gap: 12px;
	      }
	      .eventsFilterTabs{
	        display:flex;
	        gap:10px;
	        flex-wrap:wrap;
	        align-items:center;
	      }
	      .eventsFilterTabs .btn{
	        min-width:0;
	        padding: 9px 14px;
	        height: 40px;
	      }
	      .eventsFilterTabs .btn-wide{
	        min-width: 160px;
	        justify-content:center;
	      }
	      .listSearchRow{
	        display:grid;
	        grid-template-columns: minmax(240px, 1.3fr) minmax(180px, .7fr) auto auto auto;
	        gap:12px;
	        align-items:end;
	      }
	      .filterField{
	        min-width:0;
	        display:grid;
	        gap:6px;
	      }
	      .filterField label{
	        margin:0;
	        font-size:12px;
	        font-weight:650;
	        color: var(--muted);
	      }
	      .dateRange{
	        display:grid;
	        grid-template-columns: 1fr auto 1fr;
	        gap:8px;
	        align-items:center;
	      }
	      .dateRange .dateCtrl{
	        min-width: 0;
	      }
	      .dateRangeSep{
	        font-size:12px;
	        color: var(--muted);
	        font-weight:650;
	      }
	      .filterActions{
	        display:flex;
	        gap:10px;
	        align-items:end;
	        justify-content:flex-end;
	      }
	      .filterActions .btn{
	        min-width: 112px;
	      }
	      .analytics-toolbar{
	        display:flex;
	        gap:12px;
	        align-items:end;
	        flex-wrap:wrap;
	        margin-top:14px;
	      }
	      .analytics-toolbar .ctrl{
	        min-width: 280px;
	      }
	      .venue-monthly-grid{
	        display:grid;
	        grid-template-columns: 1fr;
	        gap:14px;
	        margin-top:14px;
	      }
	      .venue-monthly-table{
	        width:100%;
	        border-collapse: collapse;
	        font-size:14px;
	      }
	      .venue-monthly-table th,
	      .venue-monthly-table td{
	        padding:10px 12px;
	        border-bottom:1px solid var(--line);
	        text-align:right;
	        white-space:nowrap;
	      }
	      .venue-monthly-table th:first-child,
	      .venue-monthly-table td:first-child{
	        text-align:left;
	      }
	      .venue-monthly-table th{
	        font-size:12px;
	        color: var(--muted);
	        font-weight:700;
	        letter-spacing:.02em;
	      }
	      .venue-monthly-table tbody tr:last-child td{
	        border-bottom:0;
	      }
	      @media (max-width: 980px){
	        .analytics-toolbar .ctrl{
	          min-width: 0;
	          width: 100%;
	        }
	      }
	      @media (max-width: 1100px){
	        .listSearchRow{
	          grid-template-columns: 1fr 1fr;
	          align-items:stretch;
	        }
	        .filterActions{
	          justify-content:flex-start;
	        }
	      }
	      @media (max-width: 700px){
	        .eventsFilters{
	          padding: 12px;
	        }
	        .listSearchRow{
	          grid-template-columns: 1fr;
	        }
	        .dateRange{
	          grid-template-columns: 1fr;
	        }
	        .dateRangeSep{
	          display:none;
	        }
	        .filterActions{
	          flex-wrap:wrap;
	        }
	        .filterActions .btn{
	          flex:1 1 0;
	          min-width: 0;
	        }
	      }

      /* Category selection */
      .cat-grid{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; }
      @media (max-width: 900px){ .cat-grid{ grid-template-columns: 1fr; } }

      /* Recurrence UI polish (keep your functionality, just match the new look) */
      .recurrence{ background: var(--panel2); border:1px solid var(--line); border-radius: var(--radius-inner); padding: 14px; }
      .rec-grid{ display:grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
      @media (max-width: 900px){ .rec-grid{ grid-template-columns: 1fr; } }
      .rec-label{ font-weight:650; font-size: 12px; margin-bottom: 8px; color: var(--text); letter-spacing: .2px; }
      .rec-help{ margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.4; }

      .rec-box{ border:1px solid var(--line); border-radius: var(--radius-inner); padding: 14px; background: var(--panel2); margin-top: 10px; }
      .checkbox{ display:flex; gap:10px; align-items:center; margin:0; font-weight:650; padding:8px 0; }
      input[type=checkbox]{ width:18px; height:18px; border-radius:0px !important; accent-color: var(--brand); }
      .checkbox input{ width:18px !important; height:18px !important; border-radius:0px !important; }

      .dow{
        display:grid;
        grid-template-columns: repeat(7, minmax(0, 1fr));
        gap: 10px;
        margin-top: 10px;
      }
      .dow-pill{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        gap: 8px;
        padding: 10px 12px;
        border-radius: var(--radius);
        border: 1px solid var(--line);
        background: var(--panel);
        color: var(--text);
        font-weight:650;
        font-size: 13px;
        cursor: pointer;
        user-select:none;
        width:100%;
      }
      .dow-pill input{ position:absolute; opacity:0; pointer-events:none; }
      .dow-pill:has(input:checked){
        background: rgba(0,192,139,.12);
        border-color: rgba(0,192,139,.28);
        box-shadow: 0 0 0 4px rgba(0,192,139,.10);
      }

      .chips{ display:flex; flex-wrap:wrap; gap:8px; margin-top: 10px; }
      .chip{
        display:inline-flex; align-items:center; gap:8px;
        border:1px solid var(--line);
        border-radius: var(--radius-inner);
        padding: 8px 10px;
        background: var(--panel);
        font-size: 13px;
      }
      .chip button{ border:0; background: transparent; cursor:pointer; font-weight:650; color: #b91c1c; }


      /* Section headers (title above, controls below) */
      .sectionTitle{
        display:flex;
        flex-direction:column;
        align-items:flex-start;
        justify-content:flex-start;
        gap:10px;
        margin-bottom:14px;
      }
      .sectionTitle > div{ width:auto; }
      .sectionTitle .right{ width:auto; display:flex; gap:12px; justify-content:flex-start; flex-wrap:wrap; }
      .sectionTitle .right{ width:100%; justify-content:flex-end; }
      /* Keep controls in one line on desktop; allow wrap on small screens */
      .sectionTitle .rightRow{
        width:100%;
        display:grid;
        grid-template-columns: auto auto auto 1fr;
        align-items:center;
        gap:12px;
      }
      .sectionTitle .rightRow .sortBy{
        width:100%;
        min-width:0;
        max-width:none;
      }

      @media (max-width: 980px){
        .sectionTitle .rightRow{ flex-wrap:wrap; }
      }

      /* Chart header layout */
      .sectionTitle--chart{
        flex-direction: row;
        align-items: flex-start;
        justify-content: space-between;
        gap: 16px;
      }
      .sectionTitle--chart .left{
        display:flex;
        flex-direction:column;
        gap:6px;
      }
      .metricToggle{
        display:inline-flex;
        align-items:center;
        gap:8px;
        font-size:16px;
        font-weight:600;
      }
      .metricToggle button{
        appearance:none;
        border:1px solid var(--line);
        background: var(--panel2);
        color: var(--muted);
        padding:6px 10px;
        border-radius: var(--radius-inner);
        font-weight:600;
        cursor:pointer;
      }
      .metricToggle button.on{
        background: rgba(0,192,139,.12);
        border-color: rgba(0,192,139,.28);
        color:#065f46;
      }
      .metricToggle .metricSuffix{
        color: var(--text);
        font-weight:600;
      }
      .sectionTitle--chart .subcounts{
        display:flex;
        gap:14px;
        flex-wrap:wrap;
      }
      .dashboard-shell{
        display:grid;
        grid-template-columns: repeat(2, minmax(0,1fr));
        gap:var(--gap);
        margin-bottom:var(--gap);
        align-items:stretch;
        width:100%;
      }
      .dashboard-col{
        display:grid;
        gap:var(--gap);
        align-items:start;
        min-width:0;
        width:100%;
      }
      .dashboard-col-fill{
        display:flex;
        flex-direction:column;
        height:100%;
        min-width:0;
        width:100%;
      }
      .dashboard-col-fill > .card{
        flex:1 1 auto;
        min-width:0;
        width:100%;
      }
      .dashboard-card .sectionTitle{ margin-bottom: 14px; }
      .dashboard-card .sectionTitle h2{ margin:0; }
      .dashboard-card .card-toggle{
        width:100%;
        border:0;
        background:transparent;
        padding:0;
        margin:0;
        display:flex;
        align-items:center;
        justify-content:space-between;
        text-align:left;
        cursor:pointer;
      }
      .dashboard-card .card-toggle .card-caret{
        font-size:14px;
        color: var(--muted);
        transition: transform .16s ease;
      }
      .dashboard-card[data-collapsed="true"] .card-toggle .card-caret{
        transform: rotate(-90deg);
      }
      .dashboard-card .card-body{
        display:block;
      }
      .dashboard-card[data-collapsed="true"] .card-body{
        display:none;
      }
      .dashboard-insights{
        gap: var(--gap);
      }
      .dashboard-insights .dashboard-card{
        display:flex;
        flex-direction:column;
      }
      .insight-list{
        display:grid;
        gap:10px;
      }
      .dashboard-insights .insight-list{
        flex: 1 1 auto;
        display:flex;
        flex-direction:column;
        justify-content:space-between;
        gap:0;
      }
      .insight-row{
        display:flex;
        justify-content:space-between;
        align-items:center;
        gap:12px;
        padding: 8px 0 12px;
        border-bottom:1px solid var(--line);
      }
      .dashboard-insights .insight-row{
        padding: 10px 0;
      }
      .insight-row:last-child{
        border-bottom:0;
        padding-bottom:0;
      }
      .insight-row .label{
        font-weight:600;
        color: var(--muted);
      }
      .insight-row .value{
        font-weight:700;
        color: var(--text);
      }
      .release-meta{
        display:grid;
        gap:10px;
      }
      .release-row{
        display:grid;
        grid-template-columns: 120px minmax(0,1fr);
        gap:10px;
        align-items:start;
      }
      .release-row .label{
        color: var(--muted);
        font-weight:600;
      }
      .release-row .value{
        color: var(--text);
        overflow-wrap:anywhere;
        word-break:break-word;
      }
      .quick-links-grid{
        display:grid;
        gap:12px;
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      .quick-links-group{
        border:1px solid var(--line);
        border-radius: var(--radius-inner);
        background: var(--panel2);
        padding:10px;
        display:grid;
        gap:8px;
      }
      .quick-links-group-title{
        margin:2px 2px 4px;
        font-size:12px;
        font-weight:700;
        letter-spacing:.3px;
        text-transform:uppercase;
        color: var(--muted);
      }
      .quick-link{
        min-height:56px;
        justify-content:flex-start;
        padding: 12px 14px;
        font-weight:650;
        width:100%;
      }
      @media (max-width: 1100px){
        .dashboard-shell{
          grid-template-columns: 1fr;
        }
        .quick-links-grid{
          grid-template-columns: 1fr;
        }
      }
      @media (max-width: 900px){
        .sectionTitle--chart{
          flex-direction: column;
          align-items: flex-start;
        }
        .sectionTitle--chart .right{ width:100%; }
      }

      .small{ font-size:12px; color:var(--muted); font-weight:600; }
    

      /* Dark theme tweaks */
      input, textarea, select{
        background: var(--panel2);
        color: var(--text);
        border: 1px solid var(--line);
      }
      input::placeholder, textarea::placeholder{ color: rgba(148,163,184,.75); }
      .btn, button{
        border: 1px solid var(--line);
      }
      .chip{
        background: rgba(148,163,184,.10);
        border: 1px solid var(--line);
      }
      a{ color: var(--text); }

      /* Slight global type scale up */
      :root{ --font-up: 1px; }
      body{ font-size: 15px; }
      .h-left h1{ font-size: calc(22px + var(--font-up)); }
      .h-left p{ font-size: calc(13px + var(--font-up)); }
      .search input{ font-size: calc(14px + var(--font-up)); }
      .metric .k{ font-size: calc(12px + var(--font-up)); }
      .metric .v{ font-size: calc(22px + var(--font-up)); }
      .metric .tag{ font-size: calc(12px + var(--font-up)); }
      .sub{ font-size: calc(13px + var(--font-up)); }
      .small{ font-size: calc(12px + var(--font-up)); }
      label{ font-size: calc(12px + var(--font-up)); }
      .ctrl,
      input:not([type="checkbox"]):not([type="radio"]):not([type="file"]),
      textarea,
      select{ font-size: calc(14px + var(--font-up)); }
      input[type="file"]{ font-size: calc(14px + var(--font-up)); }
      input[type="file"]::file-selector-button{ font-size: calc(14px + var(--font-up)); }
      .btn,
      .btn-primary,
      .btn-danger,
      .btn-link{ font-size: calc(14px + var(--font-up)); }
      .seg button{ font-size: calc(14px + var(--font-up)); }
      .event-title{ font-size: calc(16px + var(--font-up)); }
      .event-meta{ font-size: calc(13px + var(--font-up)); }
      .stat{ font-size: calc(13px + var(--font-up)); }
      .stat strong{ font-size: calc(16px + var(--font-up)); }
      .note{ font-size: calc(12px + var(--font-up)); }
      .kv{ font-size: calc(13px + var(--font-up)); }

      .badge{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        min-width: 18px;
        height: 18px;
        padding: 0 6px;
        border-radius: 999px;
        background: #ef4444;
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        line-height: 1;
      }
      .badge--nav{
        margin-left: auto;
      }
</style>
  </head>
  <body>
    <div class="app">

      <!-- Sidebar -->
      <aside class="sidebar">
        <div class="sb-brand">
          <div class="sb-top">
          <div class="sb-icon">
            <img src="/assets/brand/sidebar-icon.png" alt="OpenCircle" onerror="this.style.display='none';" />
          </div>
            <div class="sb-city-wrap">
              <div class="sb-city-dd" id="sbCityDD">
                <button type="button" class="sb-city-btn" id="sbCityBtn" aria-haspopup="listbox" aria-expanded="false">
                  <span id="sbCityLabel">${esc(selectedCity)}</span>
                  <span class="caret" aria-hidden="true"></span>
                </button>
                <div class="sb-city-menu" id="sbCityMenu" role="listbox" aria-label="City">
                  ${cityListHtml}
                </div>
              </div>
            </div>
          </div>
        </div>

        <nav class="nav">
          ${(isAdminUser || isCityEditor) ? `
          <div class="nav-group nav-collapsible ${showDashboard ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${showDashboard ? "page" : "false"}"><i class="fa-regular fa-chart-bar nav-title-icon" aria-hidden="true"></i><span>Dashboard</span></a>
            <div class="nav-sub" data-nav-sub>
              <a class="subnav-link ${showDashboard ? "active" : ""}" href="/admin${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Overview</a>
            </div>
          </div>
          <div class="sb-divider"></div>
          ` : ``}

          <div class="nav-group nav-collapsible ${eventsMenuOpen ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin/existing-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${eventsMenuOpen ? "page" : "false"}"><i class="fa-regular fa-calendar nav-title-icon" aria-hidden="true"></i><span>Events</span></a>
            <div class="nav-sub" data-nav-sub>
              <a class="subnav-link ${showExisting ? "active" : ""}" href="/admin/existing-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Events</a>
              ${(isCityViewer || isCityEditor || isAdminUser) ? `<a class="subnav-link ${showCreate ? "active" : ""}" href="/admin/create-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Events</a>` : ``}
              ${(isAdminUser || isCityEditor) ? `
              <a class="subnav-link ${showApprove ? "active" : ""}" href="/admin/approve-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" style="display:flex; align-items:center; gap:8px;">
                <span>Approve Events</span>
                ${pendingCount > 0 ? `<span class="badge badge--nav">${pendingCount}</span>` : ``}
              </a>` : ``}
              ${(isAdminUser || isCityEditor) ? `<a class="subnav-link ${showAnalytics ? "active" : ""}" href="/admin/events-analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Events Analytics</a>` : ``}
            </div>
          </div>
          <div class="sb-divider"></div>

          <div class="nav-group nav-collapsible ${venuesMenuOpen ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin/venues${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${venuesMenuOpen ? "page" : "false"}"><i class="fa-regular fa-building nav-title-icon" aria-hidden="true"></i><span>Venues</span></a>
            <div class="nav-sub" data-nav-sub>
              ${(isCityViewer || isCityEditor || isAdminUser) ? `<a class="subnav-link ${showVenueExisting ? "active" : ""}" href="/admin/venues${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Venues</a>` : ``}
              ${(isCityViewer || isCityEditor || isAdminUser) ? `<a class="subnav-link ${showVenueCreate ? "active" : ""}" href="/admin/venues/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Venues</a>` : ``}
              ${(isAdminUser || isCityEditor) ? `<a class="subnav-link ${showVenueAnalytics ? "active" : ""}" href="/admin/venues/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Venue Analytics</a>` : ``}
            </div>
          </div>
          <div class="sb-divider"></div>

          <div class="nav-group nav-collapsible ${jobsMenuOpen ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin/jobs${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${jobsMenuOpen ? "page" : "false"}"><i class="fa-regular fa-clipboard nav-title-icon" aria-hidden="true"></i><span>Jobs</span></a>
            <div class="nav-sub" data-nav-sub>
              ${(isCityViewer || isCityEditor || isAdminUser) ? `<a class="subnav-link ${showJobsExisting ? "active" : ""}" href="/admin/jobs${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Jobs</a>` : ``}
              ${(isCityViewer || isCityEditor || isAdminUser) ? `<a class="subnav-link ${showJobsCreate ? "active" : ""}" href="/admin/jobs/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Jobs</a>` : ``}
              ${(isCityViewer || isCityEditor || isAdminUser) ? `<a class="subnav-link ${showJobsApplicants ? "active" : ""}" href="/admin/jobs/applicants${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Applicants</a>` : ``}
              ${(isAdminUser || isCityEditor) ? `<a class="subnav-link ${showJobsAnalytics ? "active" : ""}" href="/admin/jobs/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Job Analytics</a>` : ``}
            </div>
          </div>
          <div class="sb-divider"></div>

          <div class="nav-group nav-collapsible ${adsMenuOpen ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin/ads${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${adsMenuOpen ? "page" : "false"}"><i class="fa-regular fa-image nav-title-icon" aria-hidden="true"></i><span>Ads</span></a>
            <div class="nav-sub" data-nav-sub>
              ${(isCityViewer || isCityEditor || isAdminUser) ? `<a class="subnav-link ${showAdsExisting ? "active" : ""}" href="/admin/ads${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Ads</a>` : ``}
              ${(isCityViewer || isCityEditor || isAdminUser) ? `<a class="subnav-link ${showAdsCreate ? "active" : ""}" href="/admin/ads/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Ads</a>` : ``}
              ${(isAdminUser || isCityEditor) ? `<a class="subnav-link ${showAdsAnalytics ? "active" : ""}" href="/admin/ads/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Ads Analytics</a>` : ``}
            </div>
          </div>

          ${isAdminUser ? `<div class="sb-divider"></div>
          <div class="nav-group nav-collapsible ${adminMenuOpen ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin/users${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${adminMenuOpen ? "page" : "false"}"><i class="fa-regular fa-user nav-title-icon" aria-hidden="true"></i><span>Admin</span></a>
            <div class="nav-sub" data-nav-sub>
              <a class="subnav-link ${showPreferences ? "active" : ""}" href="/admin/preferences">Preferences</a>
              <a class="subnav-link ${showUsers ? "active" : ""}" href="/admin/users">Users</a>
              <a class="subnav-link ${showInvites ? "active" : ""}" href="/admin/invites">Invites</a>
            </div>
          </div>` : ``}
        </nav>

        <div class="sb-bottom">
          <div class="sb-divider"></div>
          <div style="margin-top:4px; text-align:center;">
            <a class="subnav-link" href="/logout" style="display:inline-block; color:var(--sidebar-muted); font-size:12px;">Log out</a>
          </div>
        </div>
      </aside>

      <!-- Main content -->
      <main class="main">
        <div class="header">
          <div class="h-left">
            <h1>${
              showCreate
                ? "Create Events"
                : showApprove
                ? "Approve Events"
                : showExisting
                ? "All Events"
                : showAnalytics
                ? "Events Analytics"
                : showVenueCreate
                ? "Create Venue"
                : showVenueExisting
                ? "All Venues"
                : showVenueAnalytics
                ? "Venue Analytics"
                : showJobsCreate
                ? "Create Jobs"
                : showJobsExisting
                ? "All Jobs"
                : showJobsApplicants
                ? "Job Applicants"
                : showJobsAnalytics
                ? "Job Analytics"
                : showAdsCreate
                ? "Create Ads"
                : showAdsExisting
                ? "All Ads"
                : showAdsAnalytics
                ? "Ads Analytics"
                : showPreferences
                ? "Preferences"
                : showInvites
                ? "Invites"
                : "Dashboard"
            }</h1>
            <p>${
              showCreate
                ? "Add or edit events"
                : showApprove
                ? "Review pending submissions"
                : showExisting
                ? "Edit, delete, and check stats"
                : showAnalytics
                ? "Event metrics, charts, and top performers"
                : showVenueCreate
                ? "Create a venue record for this city"
                : showVenueExisting
                ? "Browse and search venue records"
                : showVenueAnalytics
                ? "Venue totals and city distribution"
                : showJobsCreate
                ? "Create a local job listing"
                : showJobsExisting
                ? "Browse and search local jobs"
                : showJobsApplicants
                ? "Review candidates submitted for local jobs"
                : showJobsAnalytics
                ? "Performance and funnel metrics for jobs"
                : showAdsCreate
                ? "Create and manage rotating ads"
                : showAdsExisting
                ? "Browse and search ad inventory"
                : showAdsAnalytics
                ? "Views, clicks, and monthly ad performance"
                : showPreferences
                ? "Manage your account details, profile photo, and password"
                : "Combined events/venues overview with quick actions"
            }</p>
          </div>

          <div class="h-right">
            ${showSearch ? `
            <form class="search" method="GET" action="${showVenueExisting ? "/admin/venues" : (showJobsExisting ? "/admin/jobs" : (showJobsApplicants ? "/admin/jobs/applicants" : (showAdsExisting ? "/admin/ads" : (showAnalytics ? "/admin/events-analytics" : "/admin/existing-events"))))}">
              <input name="q" value="${esc(q)}" placeholder="${showVenueExisting ? "Search venues (name, slug, address, ID)..." : (showJobsExisting ? "Search jobs (title, company, location, ID)..." : (showJobsApplicants ? "Search applicants (name, email, phone, job)..." : (showAdsExisting ? "Search ads (name, placement, slug, URL, ID)..." : "Search events (title, slug, location, ID)...")))}" />
              <input type="hidden" name="pg" value="1" />
              <input type="hidden" name="limit" value="${esc(String(limit))}" />
              ${(showVenueExisting || showJobsExisting || showJobsApplicants || showAdsExisting) ? `` : `<input type="hidden" name="status" value="${esc(String(statusMode))}" />`}
              ${(showVenueExisting || showJobsExisting || showJobsApplicants || showAdsExisting) ? `` : (recurringOnly ? `<input type="hidden" name="recurring" value="${esc(String(1))}" />` : ``)}
              <button class="btn btn-primary" type="submit">Search</button>
              ${q ? (showVenueExisting
                ? `<a class="btn" href="/admin/venues?pg=1&limit=${esc(String(limit))}">Reset</a>`
                : (showJobsExisting
                  ? `<a class="btn" href="/admin/jobs?pg=1&limit=${esc(String(limit))}">Reset</a>`
                  : (showJobsApplicants
                    ? `<a class="btn" href="/admin/jobs/applicants?pg=1&limit=${esc(String(limit))}">Reset</a>`
                    : (showAdsExisting
                      ? `<a class="btn" href="/admin/ads?pg=1&limit=${esc(String(limit))}">Reset</a>`
                      : (showAnalytics
                        ? `<a class="btn" href="/admin/events-analytics?pg=1&limit=${esc(String(limit))}&status=${esc(String(statusMode))}${recurringOnly ? `&recurring=1` : ``}">Reset</a>`
                        : `<a class="btn" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}&status=${esc(String(statusMode))}${recurringOnly ? `&recurring=1` : ``}">Reset</a>`))))) : ``}
            </form>
            ` : ``}
            <div class="header-tools">
              <span class="header-account-name">${esc(currentUser?.displayName || currentUser?.username || currentUser?.email || req.user?.user || "Account")}</span>
              <a class="header-icon-btn" href="/admin/preferences" title="Account" aria-label="Account">
                ${currentUser?.photoUrl
                  ? `<img class="header-avatar" src="${esc(currentUser.photoUrl)}" alt="${esc(currentUser.displayName || currentUser.username || "User")}" />`
                  : `<i class="fa-regular fa-user" aria-hidden="true"></i>`}
              </a>
              <a class="header-icon-btn" href="${(isAdminUser || isCityEditor) ? `/admin/approve-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}` : `/admin${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}`}" title="Notifications" aria-label="Notifications">
                <i class="fa-regular fa-bell" aria-hidden="true"></i>
                ${(isAdminUser || isCityEditor) && pendingCount > 0 ? `<span class="icon-badge">${pendingCount > 99 ? "99+" : pendingCount}</span>` : ``}
              </a>
            </div>
          </div>
        </div>

        <script>
        (function(){
          var lastCount = ${pendingCount};
          var pollMs = 30000;

          function beep(){
            try{
              var ctx = new (window.AudioContext || window.webkitAudioContext)();
              var osc = ctx.createOscillator();
              var gain = ctx.createGain();
              osc.type = 'sine';
              osc.frequency.value = 880;
              gain.gain.value = 0.05;
              osc.connect(gain);
              gain.connect(ctx.destination);
              osc.start();
              setTimeout(function(){
                osc.stop();
                ctx.close();
              }, 200);
            }catch(e){}
          }

          async function check(){
            try{
              var res = await fetch('/admin/pending-count?city=' + encodeURIComponent('${selectedCity}'), { cache: 'no-store' });
              if(!res.ok) return;
              var json = await res.json();
              var c = Number(json && json.count || 0);
              if(c > lastCount && document.visibilityState === 'visible'){
                beep();
              }
              lastCount = c;
            }catch(e){}
          }

          setInterval(check, pollMs);
        })();
        </script>

        <!-- Dashboard Overview -->
        ${showDashboard ? `
        <section class="dashboard-shell" id="dashboard-overview">
          <div class="dashboard-col dashboard-col-fill">
            <section class="card dashboard-card" id="dashboard-quick-links" data-collapsible-card data-collapsed="false">
              <div class="sectionTitle">
                <button type="button" class="card-toggle" data-card-toggle aria-expanded="true" aria-controls="dashboard-quick-links-body">
                  <h2>Quick links</h2>
                  <i class="fa-solid fa-chevron-down card-caret" aria-hidden="true"></i>
                </button>
              </div>
              <div class="card-body" id="dashboard-quick-links-body">
                <div class="quick-links-grid">
                  <div class="quick-links-group">
                    <div class="quick-links-group-title">Events</div>
                    <a class="btn quick-link" href="/admin/create-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Event</a>
                    <a class="btn quick-link" href="/admin/approve-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Approve Events${pendingCount > 0 ? ` (${pendingCount})` : ""}</a>
                    <a class="btn quick-link" href="/admin/events-analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Events Analytics</a>
                  </div>
                  <div class="quick-links-group">
                    <div class="quick-links-group-title">Venues</div>
                    <a class="btn quick-link" href="/admin/venues/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Venue</a>
                    <a class="btn quick-link" href="/admin/venues${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Venues</a>
                    ${(isAdminUser || isCityEditor) ? `<a class="btn quick-link" href="/admin/venues/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Venue Analytics</a>` : ``}
                  </div>
                  <div class="quick-links-group">
                    <div class="quick-links-group-title">Jobs</div>
                    <a class="btn quick-link" href="/admin/jobs/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Job</a>
                    <a class="btn quick-link" href="/admin/jobs/applicants${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Applicants</a>
                    ${(isAdminUser || isCityEditor) ? `<a class="btn quick-link" href="/admin/jobs/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Job Analytics</a>` : ``}
                  </div>
                  <div class="quick-links-group">
                    <div class="quick-links-group-title">Ads</div>
                    <a class="btn quick-link" href="/admin/ads/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Ad</a>
                    <a class="btn quick-link" href="/admin/ads${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Ads</a>
                    ${(isAdminUser || isCityEditor) ? `<a class="btn quick-link" href="/admin/ads/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Ads Analytics</a>` : ``}
                  </div>
                </div>
              </div>
            </section>

            <div class="card dashboard-card" data-collapsible-card data-collapsed="false">
              <div class="sectionTitle">
                <button type="button" class="card-toggle" data-card-toggle aria-expanded="true" aria-controls="dashboard-release-notes-body">
                  <h2>Release notes</h2>
                  <i class="fa-solid fa-chevron-down card-caret" aria-hidden="true"></i>
                </button>
              </div>
              <div class="card-body" id="dashboard-release-notes-body">
                <div class="mini">
                  <div style="font-weight:650; margin-bottom:8px;">Release notes</div>
                  <div class="release-meta">
                    <div class="release-row"><div class="label">App version</div><div class="value">${esc(stats.appVersion)}</div></div>
                    <div class="release-row"><div class="label">Latest updates</div><div class="value">${esc(stats.releaseSummary)}</div></div>
                    <div class="release-row"><div class="label">Updated at</div><div class="value">${esc(stats.releaseUpdatedAt)}</div></div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div class="dashboard-col dashboard-col-fill dashboard-insights">
            <div class="card dashboard-card" data-collapsible-card data-collapsed="false">
              <div class="sectionTitle">
                <button type="button" class="card-toggle" data-card-toggle aria-expanded="true" aria-controls="dashboard-event-insights-body">
                  <h2>Event insights</h2>
                  <i class="fa-solid fa-chevron-down card-caret" aria-hidden="true"></i>
                </button>
              </div>
              <div class="card-body" id="dashboard-event-insights-body">
                <div class="insight-list">
                  <div class="insight-row"><div class="label">Events</div><div class="value">${esc(stats.total)}</div></div>
                  <div class="insight-row"><div class="label">Upcoming</div><div class="value">${esc(stats.upcoming)}</div></div>
                  <div class="insight-row"><div class="label">Featured</div><div class="value">${esc(stats.featured)}</div></div>
                  <div class="insight-row"><div class="label">Views</div><div class="value">${esc(stats.views)}</div></div>
                </div>
              </div>
            </div>

            <div class="card dashboard-card" data-collapsible-card data-collapsed="false">
              <div class="sectionTitle">
                <button type="button" class="card-toggle" data-card-toggle aria-expanded="true" aria-controls="dashboard-venue-insights-body">
                  <h2>Venue insights</h2>
                  <i class="fa-solid fa-chevron-down card-caret" aria-hidden="true"></i>
                </button>
              </div>
              <div class="card-body" id="dashboard-venue-insights-body">
                <div class="insight-list">
                  <div class="insight-row"><div class="label">Venues</div><div class="value">${esc(venueStats.total)}</div></div>
                  <div class="insight-row"><div class="label">Views</div><div class="value">${esc(venueStats.views)}</div></div>
                  <div class="insight-row"><div class="label">Total Link Clicks</div><div class="value">${esc(venueStats.totalClicks)}</div></div>
                  <div class="insight-row"><div class="label">With Website</div><div class="value">${esc(venueStats.withWebsite)} (${esc(venueStats.withWebsitePct)})</div></div>
                </div>
              </div>
            </div>

            <div class="card dashboard-card" data-collapsible-card data-collapsed="false">
              <div class="sectionTitle">
                <button type="button" class="card-toggle" data-card-toggle aria-expanded="true" aria-controls="dashboard-job-insights-body">
                  <h2>Job Insights</h2>
                  <i class="fa-solid fa-chevron-down card-caret" aria-hidden="true"></i>
                </button>
              </div>
              <div class="card-body" id="dashboard-job-insights-body">
                <div class="insight-list">
                  <div class="insight-row"><div class="label">Jobs</div><div class="value">${esc(jobAnalyticsStats.total)}</div></div>
                  <div class="insight-row"><div class="label">Active</div><div class="value">${esc(jobAnalyticsStats.active)}</div></div>
                  <div class="insight-row"><div class="label">Applicants</div><div class="value">${esc(jobApplicantStats.total)}</div></div>
                  <div class="insight-row"><div class="label">Views</div><div class="value">${esc(jobAnalyticsStats.views)}</div></div>
                </div>
              </div>
            </div>
          </div>
        </section>
        ` : ``}

        <!-- Metrics -->
        ${showAnalytics ? `
        <section class="metrics" id="analytics">
          <div class="metric">
            <div>
              <div class="k">Total events</div>
              <div class="v">${esc(stats.total)}</div>
            </div>
            <div class="tag">All time</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">Upcoming</div>
              <div class="v">${esc(stats.upcoming)}</div>
            </div>
            <div class="tag blue">Next</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">Featured</div>
              <div class="v">${esc(stats.featured)}</div>
            </div>
            <div class="tag">Pinned</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">Total views</div>
              <div class="v">${esc(stats.views)}</div>
            </div>
            <div class="tag blue">Tracked</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">Direct views</div>
              <div class="v">${esc(stats.sourceDirect)}</div>
            </div>
            <div class="tag">${esc(stats.sourceDirectPct)}</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">Referral views</div>
              <div class="v">${esc(stats.sourceReferral)}</div>
            </div>
            <div class="tag">${esc(stats.sourceReferralPct)}</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">Campaign views</div>
              <div class="v">${esc(stats.sourceCampaign)}</div>
            </div>
            <div class="tag">${esc(stats.sourceCampaignPct)}</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">Internal views</div>
              <div class="v">${esc(stats.sourceInternal)}</div>
            </div>
            <div class="tag">${esc(stats.sourceInternalPct)}</div>
          </div>
        </section>
        ` : ``}

        <!-- Charts -->
        ${showAnalytics ? `
        <section class="grid2">
          <div class="card">
            <div class="sectionTitle sectionTitle--chart">
              <div class="left">
                <div class="metricToggle" id="chartMetricSeg" aria-label="Metric toggle">
                  <button type="button" data-metric="events" class="on">Events</button>
                  <button type="button" data-metric="views">Views</button>
                </div>
                <p class="sub" id="chartRangeLabel">Last 14 days (by start date)</p>
                <div class="subcounts">
                  <span class="small">Past: <strong id="chartPast" data-events="${esc(stats.past)}" data-views="${esc(stats.pastViews)}">${esc(stats.past)}</strong></span>
                  <span class="small">Upcoming: <strong id="chartUpcoming" data-events="${esc(stats.upcoming)}" data-views="${esc(stats.upcomingViews)}">${esc(stats.upcoming)}</strong></span>
                </div>
              </div>
              <div class="right">
                <div class="seg" id="chartViewSeg" aria-label="Chart view">
                  <button type="button" data-view="daily" class="on">Daily</button>
                  <button type="button" data-view="weekly">Weekly</button>
                  <button type="button" data-view="monthly">Monthly</button>
                  <button type="button" data-view="yearly">Yearly</button>
                </div>
              </div>
            </div>
            <div class="chart-wrap" id="eventsChartWrap">
              <div id="eventsChartData" data-chart="${esc(chartDataJson)}" hidden></div>
              <canvas id="eventsChart" style="width:100%; height:260px; display:block;"></canvas>
                <div id="eventsChartTip" style="position:absolute; display:none; pointer-events:none; padding:6px 8px; border-radius:10px; border:1px solid rgba(148,163,184,.35); background:rgba(255,255,255,.98); color:rgba(15,23,42,.95); font-size:12px; line-height:1.2; box-shadow:none;"></div>
            </div>
          </div>

          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Top organizers</h2>
                <p class="sub">Most frequent organizers</p>
              </div>
            </div>

            <div class="mini mini-organizers">
              ${topOrganizersHtml}
            </div>
          </div>
        </section>
        ` : ``}

        <!-- Top events (views) -->
        ${showAnalytics ? `
        <section class="grid4">
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Top events today</h2>
                <p class="sub">Top 5 by views</p>
              </div>
            </div>
            <div class="mini mini-spaced">${topTodayHtml}</div>
          </div>
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Top events this week</h2>
                <p class="sub">Top 5 by views</p>
              </div>
            </div>
            <div class="mini mini-spaced">${topWeekHtml}</div>
          </div>
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Top events this month</h2>
                <p class="sub">Top 5 by views</p>
              </div>
            </div>
            <div class="mini mini-spaced">${topMonthHtml}</div>
          </div>
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Top events this year</h2>
                <p class="sub">Top 5 by views</p>
              </div>
            </div>
            <div class="mini mini-spaced">${topYearHtml}</div>
          </div>
        </section>
        ` : ``}

        <!-- Approvals -->
        ${showApprove ? `
        <section class="card" id="approve" style="margin-bottom:var(--gap);">
          <div class="sectionTitle">
            <div>
              <h2>Approve events</h2>
              <p class="sub">Review and approve pending submissions</p>
            </div>
          </div>
          ${pendingHtml}
        </section>
        ` : ``}

        <!-- Invites -->
        ${showUsers ? `
        <section class="card" id="users" style="margin-bottom:var(--gap);">
          <div class="sectionTitle">
            <div>
              <h2>Users</h2>
              <p class="sub">Manage access and roles</p>
            </div>
          </div>
          ${usersHtml}
        </section>
        ` : ``}

        ${showInvites ? `
        <section class="card" id="invites" style="margin-bottom:var(--gap);">
          <div class="sectionTitle">
            <div>
              <h2>Invites</h2>
              <p class="sub">Invite-only signup links</p>
            </div>
          </div>
          <form method="POST" action="/admin/invites?city=${encodeURIComponent(selectedCity)}" style="display:grid; gap:12px; max-width:520px;">
            <div class="field">
              <label>Email (optional, to lock invite)</label>
              <input type="email" name="email" placeholder="name@example.com" />
            </div>
            <div class="field">
              <label>Role</label>
              <select name="role">
                <option value="creator">Creator</option>
                <option value="editor">Editor</option>
              </select>
            </div>
            <div class="field">
              <label>City</label>
              <select name="city" ${isAdminUser ? "" : "disabled"}>
                ${allowedForUser.map(c => `<option value="${esc(c)}" ${c === selectedCity ? "selected" : ""}>${esc(c)}</option>`).join("")}
              </select>
            </div>
            <div class="field">
              <label>Expires in (days)</label>
              <input type="number" name="days" value="7" min="1" max="30" />
            </div>
            <button class="btn primary" type="submit">Create invite</button>
          </form>
          ${req.query.invite ? `
            <div class="mini" style="margin-top:14px;">
              <div class="muted">Invite link (copy and share):</div>
              <div style="font-weight:700; margin-top:6px;">${esc(`${req.protocol}://${req.get("host")}/invite?invite=${req.query.invite}`)}</div>
            </div>
          ` : ``}
          <div style="height:12px;"></div>
          ${invitesHtml}
        </section>
        ` : ``}

        ${showPreferences ? `
        <section class="gridMain single" id="preferences">
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Account preferences</h2>
              </div>
            </div>
            ${prefNoticeHtml}
            ${currentUser ? `
            <div class="grid2" style="grid-template-columns: 2fr 1fr; margin-bottom:0;">
              <div class="card">
                <div class="sectionTitle"><div><h2>Profile</h2></div></div>
                <form method="POST" action="/admin/preferences" enctype="multipart/form-data">
                  <label>Display name</label>
                  <input class="ctrl" name="displayName" value="${esc(currentUser.displayName || "")}" placeholder="Your name" />

                  <label>Email</label>
                  <input class="ctrl" value="${esc(currentUser.email || "")}" disabled />

                  <label>Username</label>
                  <input class="ctrl" value="${esc(currentUser.username || "")}" disabled />

                  <label>Phone</label>
                  <input class="ctrl" name="phone" value="${esc(currentUser.phone || "")}" placeholder="(555) 555-5555" />

                  <label>Photo URL (optional)</label>
                  <input class="ctrl" name="photoUrl" value="${esc(currentUser.photoUrl || "")}" placeholder="https://..." />

                  <label>Upload photo</label>
                  <input type="file" name="profilePhoto" accept="image/*" />
                  <div class="note">If uploaded, this replaces the Photo URL.</div>

                  <label>Bio</label>
                  <textarea class="ctrl" name="bio" rows="4" placeholder="Short profile bio">${esc(currentUser.bio || "")}</textarea>

                  <div class="actions">
                    <button class="btn btn-primary" type="submit">Save profile</button>
                  </div>
                </form>
              </div>

              <div class="card">
                <div class="sectionTitle"><div><h2>Photo</h2></div></div>
                <div class="mini" style="display:flex; align-items:center; justify-content:center; min-height:220px;">
                  ${currentUser.photoUrl
                    ? `<img src="${esc(currentUser.photoUrl)}" alt="Profile photo" style="width:160px; height:160px; border-radius:999px; object-fit:cover; border:1px solid var(--line);" />`
                    : `<div style="width:160px; height:160px; border-radius:999px; border:1px dashed var(--line); display:flex; align-items:center; justify-content:center; color:var(--muted);">No photo</div>`}
                </div>
                <div class="note" style="margin-top:10px;">Role: <strong style="color:var(--text);">${esc(currentUser.role || "creator")}</strong> · City: <strong style="color:var(--text);">${esc(currentUser.city || selectedCity)}</strong></div>
              </div>
            </div>

            <div class="card" style="margin-top:var(--gap);">
              <div class="sectionTitle"><div><h2>Change password</h2></div></div>
              <form method="POST" action="/admin/preferences/password">
                <label>Current password</label>
                <input class="ctrl" type="password" name="currentPassword" required />

                <label>New password</label>
                <input class="ctrl" type="password" name="newPassword" required minlength="8" />

                <label>Confirm new password</label>
                <input class="ctrl" type="password" name="confirmPassword" required minlength="8" />

                <div class="actions">
                  <button class="btn btn-primary" type="submit">Update password</button>
                </div>
              </form>
            </div>
            ` : `<div class="mini">User record not found for this session.</div>`}
          </div>
        </section>
        ` : ``}

        <!-- Manage -->
        ${(showCreate || showExisting) ? `
        <section class="gridMain ${isSingleManage ? "single" : ""}" id="manage">
          ${showCreate ? `
          <div class="card" id="create">
            <div class="sectionTitle">
              <div>
                <h2>${editEvent ? "Edit event" : "Create event"}</h2>
                <p class="sub">This saves to SQLite and powers your API</p>
              </div>
              <div class="right">
                <span class="pill">/${esc(selectedCity.toLowerCase())}</span>
              </div>
            </div>

            <form method="POST" action="/admin/events" enctype="multipart/form-data">
              ${editEvent ? `<input type="hidden" name="id" value="${esc(editEvent.id)}" />` : ""}
              ${fromPending ? `<input type="hidden" name="pendingId" value="${esc(pendingEvent.id)}" />` : ""}

              <input type="hidden" name="city" id="cityHidden" value="${esc(formCity)}" />

              <input type="hidden" name="startDateTimeISO" id="startDateTimeISO" value="" />
              <input type="hidden" name="endDateTimeISO" id="endDateTimeISO" value="" />

              ${isCityViewer ? "" : `
              <div class="rec-box">
                <div class="checkbox">
                  <input type="checkbox" id="featured" name="featured" value="1" ${isFeatured ? "checked" : ""} />
                  <label for="featured" style="margin:0;font-size:12px;font-weight:650;">Featured event</label>
                </div>
                <div class="note">Featured events show a badge on the event card and event page.</div>
                <div class="checkbox" style="margin-top:10px;">
                  <input type="checkbox" id="eddiesPick" name="eddiesPick" value="1" ${isEddiesPick ? "checked" : ""} />
                  <label for="eddiesPick" style="margin:0;font-size:12px;font-weight:650;">Eddie's Pick</label>
                </div>
                <div class="note">Shows this event as Eddie's Pick in weekend emails.</div>
              </div>
              `}

              <div class="rec-box">
                <div style="font-weight:650; margin-bottom:6px;">Categories (pick up to 3)</div>
                <div class="cat-grid">
                  <div><div class="muted" style="font-size:12px; margin-bottom:6px;">Category 1</div>${categorySelect(0)}</div>
                  <div><div class="muted" style="font-size:12px; margin-bottom:6px;">Category 2</div>${categorySelect(1)}</div>
                  <div><div class="muted" style="font-size:12px; margin-bottom:6px;">Category 3</div>${categorySelect(2)}</div>
                </div>
                <div class="note">Max 3. Only your allow-list categories are accepted.</div>
              </div>

              <label>Title</label>
              <input class="ctrl" name="title" value="${esc(editEvent?.title || "")}" required />

              <label>Description</label>
              <textarea class="ctrl" name="description" required>${esc(editEvent?.description || "")}</textarea>

              <label>Event Details</label>
              <textarea class="ctrl" name="eventDetails">${esc(editEvent?.eventDetails || "")}</textarea>

              <label>Good to Know</label>
              <textarea class="ctrl" name="goodToKnow">${esc(editEvent?.goodToKnow || "")}</textarea>

              <div class="rec-box">
                <div style="font-weight:650; margin-bottom:6px;">SEO</div>
                <label>SEO Title</label>
                <input class="ctrl" name="seoTitle" value="${esc(editEvent?.seoTitle || "")}" />
                <div class="note">Recommended ~50–60 characters.</div>

                <label style="margin-top:10px;">Meta Description</label>
                <textarea class="ctrl" name="metaDescription" rows="3">${esc(editEvent?.metaDescription || "")}</textarea>
                <div class="note">Recommended ~140–160 characters.</div>

                <label style="margin-top:10px;">Focus Keyphrase</label>
                <input class="ctrl" name="focusKeyphrase" value="${esc(editEvent?.focusKeyphrase || "")}" />

                <label style="margin-top:10px;">Image Alt Text</label>
                <input class="ctrl" name="imageAlt" value="${esc(editEvent?.imageAlt || "")}" />
              </div>

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Start</label>
                  <input id="startDateTime" class="ctrl" type="datetime-local" name="startDateTime"
                    value="${esc(toDateTimeLocalValue(editEvent?.startDateTime))}" required />
                </div>
                <div>
                  <label style="margin-top:0;">End</label>
                  <input id="endDateTime" class="ctrl" type="datetime-local" name="endDateTime"
                    value="${esc(toDateTimeLocalValue(editEvent?.endDateTime))}" required />
                </div>
              </div>

              <!-- Recurring Events -->
              <div class="rec-box recurrence">
                <div class="checkbox">
                  <input type="checkbox" id="hasRecurrence" name="hasRecurrence" value="1" ${hasRecurrence ? "checked" : ""} />
                  <label for="hasRecurrence" style="margin:0;font-size:12px;font-weight:650;">Recurring event</label>
                </div>
                <div class="note">Weekly/monthly rule or custom dates list.</div>

                <div class="rec-grid" style="margin-top:12px;">
                  <div>
                    <label style="margin-top:0;">First date (series starts)</label>
                    <input class="ctrl" type="date" name="recurrenceStartDate" value="${esc(recurrenceStartDateVal)}" />
                    <div class="note">First occurrence date for this series.</div>
                  </div>

                  <div>
                    <label style="margin-top:0;">Until date (series ends)</label>
                    <input class="ctrl" type="date" name="recurrenceUntilDate" value="${esc(recurrenceUntilDateVal)}" />
                    <div class="note">No occurrences after this date.</div>
                  </div>
                </div>

                <div class="rec-grid" style="margin-top:12px;">
                  <div>
                    <div class="rec-label">Recurrence Type</div>
                    <select id="recurrenceType" name="recurrenceType" class="ctrl">
                      <option value="none" ${ruleType === "none" ? "selected" : ""}>None</option>
                      <option value="weekly" ${ruleType === "weekly" ? "selected" : ""}>Weekly</option>
                      <option value="monthly" ${ruleType === "monthly" ? "selected" : ""}>Monthly</option>
                      <option value="custom" ${ruleType === "custom" ? "selected" : ""}>Custom Dates</option>
                    </select>
                  </div>

                  <div id="intervalRow">
                    <div class="rec-label">Interval</div>
                    <input class="ctrl" type="number" min="1" name="recurrenceInterval" value="${esc(recurrenceInterval)}" />
                    <div class="rec-help">Example: every 1 week, every 2 weeks, every 1 month, etc.</div>
                  </div>
                </div>

                <div id="weeklyBox" style="margin-top:14px;">
                  <div class="rec-label">Days of Week</div>
                  <div class="dow">
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="SU" ${isChecked(weeklyByDay, "SU")} />Sun</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="MO" ${isChecked(weeklyByDay, "MO")} />Mon</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="TU" ${isChecked(weeklyByDay, "TU")} />Tue</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="WE" ${isChecked(weeklyByDay, "WE")} />Wed</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="TH" ${isChecked(weeklyByDay, "TH")} />Thu</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="FR" ${isChecked(weeklyByDay, "FR")} />Fri</label>
                    <label class="dow-pill"><input type="checkbox" name="weeklyByDay" value="SA" ${isChecked(weeklyByDay, "SA")} />Sat</label>
                  </div>
                  <div class="rec-help">Pick one or more days.</div>
                </div>

                <div id="monthlyBox" style="margin-top:14px;">
                  <div class="rec-grid">
                    <div>
                      <div class="rec-label">Monthly Mode</div>
                      <select id="monthlyMode" name="monthlyMode" class="ctrl">
                        <option value="monthday" ${monthlyMode === "monthday" ? "selected" : ""}>On day of month</option>
                        <option value="nthweekday" ${monthlyMode === "nthweekday" ? "selected" : ""}>On nth weekday</option>
                      </select>
                    </div>
                    <div></div>
                  </div>

                  <div id="monthdayBox" style="margin-top:12px;">
                    <div class="rec-label">Day of Month (1–31)</div>
                    <input class="ctrl" type="number" min="1" max="31" name="byMonthday" value="${esc(byMonthday)}" />
                  </div>

                  <div id="nthweekdayBox" style="margin-top:12px;">
                    <div class="rec-grid">
                      <div>
                        <div class="rec-label">Which Week</div>
                        <select name="setPos" class="ctrl">
                          <option value="1" ${setPos === "1" ? "selected" : ""}>1st</option>
                          <option value="2" ${setPos === "2" ? "selected" : ""}>2nd</option>
                          <option value="3" ${setPos === "3" ? "selected" : ""}>3rd</option>
                          <option value="4" ${setPos === "4" ? "selected" : ""}>4th</option>
                          <option value="-1" ${setPos === "-1" ? "selected" : ""}>Last</option>
                        </select>
                      </div>
                      <div>
                        <div class="rec-label">Weekdays</div>
                        <div class="dow">
                          <label class="dow-pill"><input type="checkbox" name="monthlyByDay" value="SU" ${isChecked(monthlyByDay, "SU")} />Sun</label>
                          <label class="dow-pill"><input type="checkbox" name="monthlyByDay" value="MO" ${isChecked(monthlyByDay, "MO")} />Mon</label>
                          <label class="dow-pill"><input type="checkbox" name="monthlyByDay" value="TU" ${isChecked(monthlyByDay, "TU")} />Tue</label>
                          <label class="dow-pill"><input type="checkbox" name="monthlyByDay" value="WE" ${isChecked(monthlyByDay, "WE")} />Wed</label>
                          <label class="dow-pill"><input type="checkbox" name="monthlyByDay" value="TH" ${isChecked(monthlyByDay, "TH")} />Thu</label>
                          <label class="dow-pill"><input type="checkbox" name="monthlyByDay" value="FR" ${isChecked(monthlyByDay, "FR")} />Fri</label>
                          <label class="dow-pill"><input type="checkbox" name="monthlyByDay" value="SA" ${isChecked(monthlyByDay, "SA")} />Sat</label>
                        </div>
                        <div class="rec-help">Pick one or more days (e.g., last Wed + Thu).</div>
                      </div>
                    </div>
                  </div>
                </div>

                <div id="customBox" style="margin-top:14px;">
                  <div class="rec-label">Custom Dates</div>
                  <div class="rec-help">Add specific dates and set start/end time for each date.</div>

                  <div id="customDatesWrap" class="chips" style="margin-top:10px;">
                    ${
                      (customDates || [])
                        .map((row) => {
                          const startIso = String(row?.start || "").trim();
                          const endIso   = String(row?.end || "").trim();

                          const dateVal  = startIso ? startIso.slice(0, 10) : "";
                          const startVal = startIso ? startIso.slice(11, 16) : "";
                          const endVal   = endIso ? endIso.slice(11, 16) : "";

                          return `
                            <span class="chip">
                              <input class="ctrl" style="width:160px; padding:8px 10px;" type="date" name="customDate" value="${esc(dateVal)}" />
                              <input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customStart" value="${esc(startVal)}" />
                              <input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customEnd" value="${esc(endVal)}" />
                              <button type="button" data-remove-date="1" aria-label="Remove">×</button>
                            </span>
                          `;
                        })
                        .join("")
                    }
                  </div>

                  <input type="hidden" name="recurrenceDatesJson" id="recurrenceDatesJson" value="" />

                  <div class="actions" style="margin-top:10px;">
                    <button id="addCustomDate" type="button" class="btn">+ Add Date</button>
                    <button id="prunePastDates" type="button" class="btn">Remove past dates</button>
                  </div>
                  <div class="note">Use “Remove past dates” to drop occurrences that have already passed.</div>
                </div>
              </div>

              <label>Flyer Image (Upload)</label>
              <input id="imageFileInput" class="ctrl" type="file" name="imageFile" accept="image/*" />
              <div class="note">Uploading replaces the Image URL below.</div>

              <img id="uploadPreview" style="margin-top:10px; width:160px; height:160px; object-fit:cover; border-radius:var(--radius); border:1px solid var(--line); display:none;" alt="Flyer upload preview" />

              <label style="margin-top:12px;">Image URL (optional fallback)</label>
              <input class="ctrl" name="imageUrl" value="${esc(editEvent?.imageUrl || "")}" placeholder="https://..." />

              ${
                editEvent?.imageUrl
                  ? `
                    <div class="note">Current: <a href="${esc(editEvent.imageUrl)}" target="_blank" rel="noopener">View image</a></div>
                    <div style="margin-top:10px;">
                      <img id="existingPreview" src="${esc(editEvent.imageUrl)}"
                        style="width:160px; height:160px; object-fit:cover; border-radius:var(--radius); border:1px solid var(--line);"
                        alt="Current flyer preview" onerror="this.style.display='none';" />
                    </div>
                  `
                  : ""
              }

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Ticket Button Text</label>
                  <input class="ctrl" name="ticketLabel" value="${esc(editEvent?.ticketLabel || "Tickets")}" placeholder="Tickets / Reserve / Buy Tickets..." />
                </div>
                <div>
                  <label style="margin-top:0;">Ticket Link (URL)</label>
                  <input class="ctrl" name="ticketUrl" value="${esc(editEvent?.ticketUrl || "")}" placeholder="https://..." />
                  <div class="note">If provided, a ticket button will show on the event page.</div>
                </div>
              </div>

              <label>Location</label>
              <input class="ctrl" name="location" value="${esc(editEvent?.location || "")}" required />

              <label>Organizer</label>
              <input class="ctrl" name="organizer" value="${esc(editEvent?.organizer || "")}" required />

              <div class="actions">
                <button type="submit" class="btn btn-primary">${editEvent ? "Update Event" : "Save Event"}</button>
	                ${editEvent ? `<a class="btn btn-link" href="/admin/existing-events?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${statusMode ? `&status=${encodeURIComponent(statusMode)}` : ""}${recurringOnly ? `&recurring=1` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}">Cancel</a>` : ""}
                <span class="note">Dates are saved with your server's local timezone offset automatically.</span>
              </div>
            </form>
          </div>
          ` : ``}

          ${showExisting ? `
	          <div class="card" id="existing">
	            <div class="sectionTitle">
	              <div>
	                <h2>All events</h2>
	                <p class="sub">Edit, delete, and check stats</p>
	              </div>
	            </div>

	            <div class="eventsFilters">
	              <div class="eventsFilterTabs">
	                <a class="btn ${statusMode === "upcoming" ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}&sort=${encodeURIComponent(sort)}&status=upcoming${recurringOnly ? `&recurring=1` : ``}">Upcoming</a>
	                <a class="btn ${statusMode === "past" ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}&sort=${encodeURIComponent(sort)}&status=past${recurringOnly ? `&recurring=1` : ``}">Past</a>
	                <a class="btn ${statusMode === "archived" ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}&sort=${encodeURIComponent(sort)}&status=archived${recurringOnly ? `&recurring=1` : ``}">Archived</a>
	                <a class="btn btn-wide ${recurringOnly ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}&sort=${encodeURIComponent(sort)}&status=${encodeURIComponent(statusMode)}${recurringOnly ? `` : `&recurring=1`}">${recurringOnly ? "Recurring On" : "Recurring Only"}</a>
	              </div>
	              <div class="listSearchRow">
	                <div class="filterField">
	                  <label for="eventSearch">Search</label>
	                  <input id="eventSearch" class="ctrl" type="text" placeholder="Search title, slug, location, or ID" value="${esc(q)}" />
	                </div>
	                <div class="filterField">
	                  <label for="sortBy">Sort by</label>
	                  <select id="sortBy" class="ctrl sortBy">
	                    <option value="datetime" ${sort === "datetime" ? "selected" : ""}>Event date/time</option>
	                    <option value="alpha" ${sort === "alpha" ? "selected" : ""}>Alphabetical (A-Z)</option>
	                    <option value="recent" ${sort === "recent" ? "selected" : ""}>Recently added</option>
	                    <option value="id" ${sort === "id" ? "selected" : ""}>Newest ID first</option>
	                  </select>
	                </div>
	                <div class="filterField">
	                  <label for="eventDateFrom">Date range</label>
	                  <div class="dateRange">
	                    <input id="eventDateFrom" class="ctrl dateCtrl" type="date" value="${esc(fromDate)}" />
	                    <span class="dateRangeSep">to</span>
	                    <input id="eventDateTo" class="ctrl dateCtrl" type="date" value="${esc(toDate)}" />
	                  </div>
	                </div>
	                <div class="filterActions">
	                  <button id="eventSearchApply" type="button" class="btn btn-primary">Apply</button>
	                  <button id="eventSearchClear" type="button" class="btn">Reset</button>
	                </div>
	              </div>
	            </div>

	            ${pagerHtml}

            <div id="eventsList" style="display:grid; gap:var(--gap);">${listHtml}</div>
            <div id="eventsEmpty" class="muted" style="display:none; margin-top:10px;">No matching events.</div>

          </div>
          ` : ``}
        </section>
        ` : ``}

        ${(showVenueCreate || showVenueExisting || showVenueAnalytics) ? `
        <section class="gridMain ${(showVenueCreate || showVenueExisting || showVenueAnalytics) ? "single" : ""}" id="venues">
          ${showVenueCreate ? `
          <div class="card" id="venue-create">
            <div class="sectionTitle">
              <div>
                <h2>${editVenue ? "Edit venue" : "Create venue"}</h2>
                <p class="sub">Saved to SQLite and used across event pages</p>
              </div>
              <div class="right">
                <span class="pill">/${esc(selectedCity.toLowerCase())}</span>
              </div>
            </div>

            <form method="POST" action="/admin/venues" enctype="multipart/form-data">
              ${editVenue ? `<input type="hidden" name="id" value="${esc(editVenue.id)}" />` : ""}
              <input type="hidden" name="city" value="${esc(editVenue?.city || selectedCity)}" />

              <label>Venue Name</label>
              <input class="ctrl" name="name" value="${esc(editVenue?.name || "")}" required />

              <div class="rec-box" style="margin-top:10px;">
                <div style="font-weight:650; margin-bottom:6px;">Venue Categories (pick up to 3, at least 1 required)</div>
                <div class="cat-grid">
                  ${[0, 1, 2].map((idx) => {
                    const current = selectedVenueCats[idx] || "";
                    return `
                    <div>
                      <div class="muted" style="font-size:12px; margin-bottom:6px;">Category ${idx + 1}</div>
                      <select name="venueCategory${idx + 1}" class="ctrl" ${idx === 0 ? "required" : ""}>
                        <option value="">— ${idx === 0 ? "Select one" : "None"} —</option>
                        ${ALLOWED_VENUE_CATEGORIES.map((c) => {
                          const sel = current === c ? "selected" : "";
                          return `<option value="${esc(c)}" ${sel}>${esc(c)}</option>`;
                        }).join("")}
                      </select>
                    </div>
                    `;
                  }).join("")}
                </div>
              </div>

              <label>Address</label>
              <input class="ctrl" name="address" value="${esc(editVenue?.address || "")}" />

              <label>Description</label>
              <textarea class="ctrl" name="description" rows="5">${esc(editVenue?.description || "")}</textarea>

              <label>Hours (Sun-Sat)</label>
              <div class="mini" style="display:grid; gap:8px; margin-top:8px;">
                ${venueDays.map((d) => {
                  const labels = { sun: "Sun", mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat" };
                  const h = venueHours[d] || { open: "", close: "", closed: false };
                  return `
                    <div style="display:grid; grid-template-columns:70px 1fr 1fr auto; gap:10px; align-items:center;">
                      <div class="muted">${labels[d]}</div>
                      <input class="ctrl" type="time" name="venueHours_${d}_open" value="${esc(h.open || "")}" />
                      <input class="ctrl" type="time" name="venueHours_${d}_close" value="${esc(h.close || "")}" />
                      <label style="display:flex; gap:6px; align-items:center; margin:0;">
                        <input type="checkbox" name="venueHours_${d}_closed" value="1" ${h.closed ? "checked" : ""} />
                        <span class="muted">Closed</span>
                      </label>
                    </div>
                  `;
                }).join("")}
              </div>

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Venue Image (Upload)</label>
                  <input class="ctrl" type="file" name="venueImageFile" accept="image/*" />
                </div>
                <div>
                  <label style="margin-top:0;">Venue Image URL (Optional)</label>
                  <input class="ctrl" name="imageUrl" value="${esc(editVenue?.imageUrl || "")}" placeholder="https://..." />
                  ${editVenue?.imageUrl ? `<div class="note">Current: <a href="${esc(editVenue.imageUrl)}" target="_blank" rel="noopener">View image</a></div>` : ``}
                </div>
              </div>

              <div class="rec-box" style="margin-top:10px;">
                <div style="font-weight:650; margin-bottom:6px;">Gallery Images (up to 3)</div>
                <div class="note" style="margin-bottom:8px;">Add up to 3 image URLs and/or upload up to 3 gallery images.</div>
                <div class="rec-grid">
                  <div>
                    <label style="margin-top:0;">Gallery Image URL 1</label>
                    <input class="ctrl" name="galleryImage1" value="${esc(venueGallery[0] || "")}" placeholder="https://..." />
                  </div>
                  <div>
                    <label style="margin-top:0;">Gallery Image URL 2</label>
                    <input class="ctrl" name="galleryImage2" value="${esc(venueGallery[1] || "")}" placeholder="https://..." />
                  </div>
                </div>
                <div class="rec-grid" style="margin-top:10px;">
                  <div>
                    <label style="margin-top:0;">Gallery Image URL 3</label>
                    <input class="ctrl" name="galleryImage3" value="${esc(venueGallery[2] || "")}" placeholder="https://..." />
                  </div>
                  <div>
                    <label style="margin-top:0;">Gallery Images (Upload, max 3)</label>
                    <input class="ctrl" type="file" name="venueGalleryFiles" accept="image/*" multiple />
                  </div>
                </div>
                ${venueGallery.length ? `<div class="note" style="margin-top:8px;">Current: ${venueGallery.map((u, idx) => `<a href="${esc(u)}" target="_blank" rel="noopener">Image ${idx + 1}</a>`).join(" · ")}</div>` : ``}
              </div>

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Website</label>
                  <input class="ctrl" name="website" value="${esc(editVenue?.website || "")}" placeholder="https://..." />
                </div>
                <div>
                  <label style="margin-top:0;">Phone</label>
                  <input class="ctrl" name="phone" value="${esc(editVenue?.phone || "")}" placeholder="(360) 555-1212" />
                </div>
              </div>

              <div class="rec-box" style="margin-top:10px;">
                <div style="font-weight:650; margin-bottom:6px;">Social Links</div>
                <div class="rec-grid">
                  <div>
                    <label style="margin-top:0;">Facebook</label>
                    <input class="ctrl" name="socialFacebook" value="${esc(venueSocial.facebook)}" placeholder="https://facebook.com/..." />
                  </div>
                  <div>
                    <label style="margin-top:0;">Instagram</label>
                    <input class="ctrl" name="socialInstagram" value="${esc(venueSocial.instagram)}" placeholder="https://instagram.com/..." />
                  </div>
                </div>
                <div class="rec-grid" style="margin-top:10px;">
                  <div>
                    <label style="margin-top:0;">X</label>
                    <input class="ctrl" name="socialX" value="${esc(venueSocial.x)}" placeholder="https://x.com/..." />
                  </div>
                  <div>
                    <label style="margin-top:0;">TikTok</label>
                    <input class="ctrl" name="socialTiktok" value="${esc(venueSocial.tiktok)}" placeholder="https://www.tiktok.com/@..." />
                  </div>
                </div>
                <div class="rec-grid" style="margin-top:10px;">
                  <div>
                    <label style="margin-top:0;">YouTube</label>
                    <input class="ctrl" name="socialYoutube" value="${esc(venueSocial.youtube)}" placeholder="https://youtube.com/..." />
                  </div>
                  <div>
                    <label style="margin-top:0;">LinkedIn</label>
                    <input class="ctrl" name="socialLinkedin" value="${esc(venueSocial.linkedin)}" placeholder="https://linkedin.com/company/..." />
                  </div>
                </div>
              </div>

              <div class="rec-box" style="margin-top:10px;">
                <div style="font-weight:650; margin-bottom:6px;">SEO</div>
                <label>SEO Title</label>
                <input class="ctrl" name="seoTitle" value="${esc(editVenue?.seoTitle || "")}" />

                <label style="margin-top:10px;">Meta Description</label>
                <textarea class="ctrl" name="metaDescription" rows="3">${esc(editVenue?.metaDescription || "")}</textarea>

                <label style="margin-top:10px;">Focus Keyphrase</label>
                <input class="ctrl" name="focusKeyphrase" value="${esc(editVenue?.focusKeyphrase || "")}" />

                <label style="margin-top:10px;">Image Alt</label>
                <input class="ctrl" name="imageAlt" value="${esc(editVenue?.imageAlt || "")}" />
              </div>

              <div class="actions">
                <button type="submit" class="btn btn-primary">${editVenue ? "Update Venue" : "Save Venue"}</button>
                ${editVenue ? `<a class="btn btn-link" href="/admin/venues?pg=1&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}">Cancel</a>` : ""}
              </div>
            </form>
          </div>
          ` : ``}

          ${showVenueExisting ? `
          <div class="card" id="venue-existing">
            <div class="sectionTitle">
              <div>
                <h2>All venues</h2>
                <p class="sub">Search, edit, and manage venues</p>
              </div>
            </div>

            <div class="muted" style="margin-bottom:12px;">
              Total: <strong style="color:var(--text)">${venueTotal}</strong>
              ${venueTotal ? ` · Showing ${venueShowingFrom}-${venueShowingTo}` : ``}
            </div>

            <div id="venuesList" style="display:grid; gap:var(--gap);">
              ${venueRows.length ? venueRows.map((v) => `
                ${(() => {
                  const thumbHtml = v.imageUrl
                    ? `
                        <a class="thumb-link" href="${esc(v.imageUrl)}" target="_blank" rel="noopener" title="View image">
                          <img class="event-thumb-img" src="${esc(v.imageUrl)}" alt="${esc(v.name || "Venue")} image" loading="lazy"
                               onerror="this.closest('.event-thumb').classList.add('broken'); this.style.display='none';" />
                          <div class="thumb-fallback">Image not found</div>
                        </a>
                      `
                    : `<div class="thumb-empty">No image</div>`;
                  return `
                <div class="event-card venue-card">
                  <div class="event-thumb">${thumbHtml}</div>
                  <div class="event-left">
                    <div class="event-main">
                      <div class="event-title">#${v.id} — ${esc(v.name || "")}</div>
                      <div class="event-meta">
                        <div><strong>Slug:</strong> ${esc(v.slug || "")}</div>
                        <div><strong>Address:</strong> ${esc(v.address || "")}</div>
                        <div><strong>City:</strong> ${esc(v.city || "")}</div>
                        ${v.imageUrl ? `<div><strong>Image:</strong> <a href="${esc(v.imageUrl)}" target="_blank" rel="noopener">View image</a></div>` : ``}
                        ${(() => {
                          const cats = normalizeVenueCategories(safeParseJson(v.categoriesJson, []));
                          return cats.length ? `<div><strong>Categories:</strong> ${esc(cats.join(", "))}</div>` : ``;
                        })()}
                        ${v.website ? `<div><strong>Website:</strong> <a href="${esc(v.website)}" target="_blank" rel="noopener">${esc(v.website)}</a></div>` : ``}
                        ${(() => {
                          const s = safeParseJson(v.socialJson, null);
                          if (!s || typeof s !== "object") return ``;
                          const parts = [];
                          if (s.facebook) parts.push(`<a href="${esc(String(s.facebook))}" target="_blank" rel="noopener">Facebook</a>`);
                          if (s.instagram) parts.push(`<a href="${esc(String(s.instagram))}" target="_blank" rel="noopener">Instagram</a>`);
                          if (s.x) parts.push(`<a href="${esc(String(s.x))}" target="_blank" rel="noopener">X</a>`);
                          if (s.tiktok) parts.push(`<a href="${esc(String(s.tiktok))}" target="_blank" rel="noopener">TikTok</a>`);
                          if (s.youtube) parts.push(`<a href="${esc(String(s.youtube))}" target="_blank" rel="noopener">YouTube</a>`);
                          if (s.linkedin) parts.push(`<a href="${esc(String(s.linkedin))}" target="_blank" rel="noopener">LinkedIn</a>`);
                          return parts.length ? `<div><strong>Social:</strong> ${parts.join(" · ")}</div>` : ``;
                        })()}
                        ${v.phone ? `<div><strong>Phone:</strong> ${esc(v.phone)}</div>` : ``}
                        ${(() => {
                          const gallery = normalizeGalleryImages(safeParseJson(v.galleryJson, []), 3);
                          return gallery.length ? `<div><strong>Gallery:</strong> ${gallery.length} image${gallery.length === 1 ? "" : "s"}</div>` : ``;
                        })()}
                      </div>
                    </div>
                    <div class="event-actions">
                      <a class="btn btn-edit" href="/admin/venues/create?edit=${v.id}&pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}">Edit</a>
                      <form method="POST" action="/admin/venues/${v.id}/delete?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" class="inline" onsubmit="return confirm('Delete this venue?');">
                        <button type="submit" class="btn btn-danger">Delete</button>
                      </form>
                    </div>
                  </div>
                  <div class="event-stats">
                    <div class="stat"><span>Views</span><strong>${Number(v.viewCount || 0)}</strong></div>
                    <div class="stat"><span>Phone clicks</span><strong>${Number(v.phoneClickCount || 0)}</strong></div>
                    <div class="stat"><span>Website clicks</span><strong>${Number(v.websiteClickCount || 0)}</strong></div>
                    <div class="stat"><span>Social clicks</span><strong>${Number(v.socialClickCount || 0)}</strong></div>
                  </div>
                </div>
                  `;
                })()}
              `).join("") : `<div class="muted">No venues found.</div>`}
            </div>

            ${venuePages > 1 ? `
            <div class="pager" style="margin-top:14px;">
              <div class="pager-right">
                <a class="btn" href="/admin/venues?pg=1&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg === 1 ? 'style="opacity:.45; pointer-events:none;"' : ""}>First</a>
                <a class="btn" href="/admin/venues?pg=${Math.max(1, pg - 1)}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg === 1 ? 'style="opacity:.45; pointer-events:none;"' : ""}>Prev</a>
                <span class="muted" style="padding:0 8px;">Page <strong style="color:var(--text)">${pg}</strong> / ${venuePages}</span>
                <a class="btn" href="/admin/venues?pg=${Math.min(venuePages, pg + 1)}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg >= venuePages ? 'style="opacity:.45; pointer-events:none;"' : ""}>Next</a>
                <a class="btn" href="/admin/venues?pg=${venuePages}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg >= venuePages ? 'style="opacity:.45; pointer-events:none;"' : ""}>Last</a>
              </div>
            </div>
            ` : ``}
          </div>
          ` : ``}

          ${showVenueAnalytics ? `
	          <div class="card" id="venue-analytics">
	            <div class="sectionTitle">
	              <div>
	                <h2>Venue analytics</h2>
	                <p class="sub">Performance and data quality for venues</p>
              </div>
            </div>
	            <div class="venue-analytics-grid2" style="margin-top:14px;">
              <div class="card">
                <div class="sectionTitle">
                  <div>
                    <h2>Top venues by views</h2>
                    <p class="sub">Most viewed venue pages</p>
                  </div>
                </div>
                <div class="mini">
                  ${venueStats.topByViews.length ? venueStats.topByViews.map((r) => `
                    <div class="kv">
                      <span class="k"><a href="/admin/venues/create?edit=${r.id}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}">${esc(r.name)}</a></span>
                      <strong class="v">${Number(r.views || 0).toLocaleString("en-US")}</strong>
                    </div>
                  `).join("") : `<div class="muted">No venue views yet.</div>`}
                </div>
              </div>

              <div class="card">
                <div class="sectionTitle">
                  <div>
                    <h2>Top venues by clicks</h2>
                    <p class="sub">Phone + website + social clicks</p>
                  </div>
                </div>
                <div class="mini">
                  ${venueStats.topByClicks.length ? venueStats.topByClicks.map((r) => `
                    <div class="kv">
                      <span class="k"><a href="/admin/venues/create?edit=${r.id}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}">${esc(r.name)}</a></span>
                      <strong class="v">${Number(r.clicks || 0).toLocaleString("en-US")}</strong>
                    </div>
                  `).join("") : `<div class="muted">No venue link clicks yet.</div>`}
                </div>
              </div>
            </div>

	            <div class="card" style="margin-top:14px;">
	              <div class="sectionTitle">
	                <div>
	                  <h2>Venue monthly performance</h2>
	                  <p class="sub">Choose one venue to review monthly views and click activity</p>
	                </div>
	              </div>
	              <form class="analytics-toolbar" method="GET" action="/admin/venues/analytics">
	                ${selectedCity ? `<input type="hidden" name="city" value="${esc(selectedCity)}" />` : ``}
	                <div style="min-width:0; flex:1 1 360px;">
	                  <label for="venueAnalyticsSelect" style="margin-top:0;">Venue</label>
	                  <select id="venueAnalyticsSelect" name="venue" class="ctrl">
	                    ${venueAnalyticsOptions.length
	                      ? venueAnalyticsOptions.map((venue) => `
	                        <option value="${Number(venue.id || 0)}" ${selectedVenueActualId === Number(venue.id || 0) ? "selected" : ""}>
	                          ${esc(venue.name || `Venue #${venue.id}`)}
	                        </option>
	                      `).join("")
	                      : `<option value="">No venues available</option>`}
	                  </select>
	                </div>
	                <button class="btn btn-primary" type="submit" ${venueAnalyticsOptions.length ? "" : "disabled"}>View venue</button>
	              </form>
	              <div class="note">Monthly venue interaction history starts from this update forward.</div>

		              ${selectedVenue ? `
		                <div class="venue-monthly-grid">
		                  <div class="mini">
		                    <div class="sectionTitle sectionTitle--chart" style="margin-bottom:10px;">
		                      <div class="left">
		                        <div style="font-weight:700;">${esc(selectedVenue.name || `Venue #${selectedVenue.id}`)} monthly performance</div>
		                        <p class="sub">Last 12 months</p>
		                      </div>
		                      <div class="right">
		                        <div class="metricToggle" id="venueChartMetricSeg" aria-label="Venue metric toggle">
		                          <button type="button" data-metric="views" class="on">Views</button>
		                          <button type="button" data-metric="clicks">Total Clicks</button>
		                        </div>
		                      </div>
		                    </div>
		                    <div class="chart-wrap" id="venueChartWrap" style="min-height:320px;">
		                      <div id="venueChartData" data-chart="${esc(venueChartDataJson)}" hidden></div>
		                      <canvas id="venueChart" style="width:100%; height:260px; display:block;"></canvas>
		                      <div id="venueChartTip" style="position:absolute; display:none; pointer-events:none; padding:6px 8px; border-radius:10px; border:1px solid rgba(148,163,184,.35); background:rgba(255,255,255,.98); color:rgba(15,23,42,.95); font-size:12px; line-height:1.2; box-shadow:none;"></div>
		                    </div>
		                  </div>
		                </div>
		              ` : `<div class="muted" style="margin-top:12px;">Add a venue first to see monthly performance.</div>`}
	            </div>
	          </div>
	          ` : ``}
        </section>
        ` : ``}

        ${(showJobsCreate || showJobsExisting || showJobsApplicants || showJobsAnalytics) ? `
        <section class="gridMain ${(showJobsCreate || showJobsExisting || showJobsApplicants || showJobsAnalytics) ? "single" : ""}" id="jobs">
          ${showJobsCreate ? `
          <div class="card" id="job-create">
            <div class="sectionTitle">
              <div>
                <h2>${editJob ? "Edit job" : "Create job"}</h2>
                <p class="sub">Publish local job listings</p>
              </div>
              <div class="right">
                <span class="pill">/${esc(selectedCity.toLowerCase())}</span>
              </div>
            </div>

            <form method="POST" action="/admin/jobs" enctype="multipart/form-data">
              ${editJob ? `<input type="hidden" name="id" value="${esc(editJob.id)}" />` : ""}
              <input type="hidden" name="city" value="${esc(editJob?.city || selectedCity)}" />

              <label>Job Title</label>
              <input class="ctrl" name="title" value="${esc(editJob?.title || "")}" required />

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Company</label>
                  <input class="ctrl" name="company" value="${esc(editJob?.company || "")}" />
                </div>
                <div>
                  <label style="margin-top:0;">Location</label>
                  <input class="ctrl" name="location" value="${esc(editJob?.location || "")}" placeholder="Enumclaw, WA" />
                </div>
              </div>

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Employment Type</label>
                  <select class="ctrl" name="employmentType">
                    <option value="" ${!String(editJob?.employmentType || "") ? "selected" : ""}>Select type</option>
                    <option value="Full-time" ${String(editJob?.employmentType || "") === "Full-time" ? "selected" : ""}>Full-time</option>
                    <option value="Part-time" ${String(editJob?.employmentType || "") === "Part-time" ? "selected" : ""}>Part-time</option>
                    <option value="Contract" ${String(editJob?.employmentType || "") === "Contract" ? "selected" : ""}>Contract</option>
                    <option value="Temporary" ${String(editJob?.employmentType || "") === "Temporary" ? "selected" : ""}>Temporary</option>
                    <option value="Seasonal" ${String(editJob?.employmentType || "") === "Seasonal" ? "selected" : ""}>Seasonal</option>
                    <option value="Internship" ${String(editJob?.employmentType || "") === "Internship" ? "selected" : ""}>Internship</option>
                  </select>
                </div>
                <div>
                  <label style="margin-top:0;">Salary / Pay Range</label>
                  <input class="ctrl" name="salaryRange" value="${esc(editJob?.salaryRange || "")}" placeholder="$20/hr · $45k-$60k" />
                </div>
              </div>

              <label>Apply URL</label>
              <input class="ctrl" name="applyUrl" value="${esc(editJob?.applyUrl || "")}" placeholder="https://..." required />

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Job Image (Upload)</label>
                  <input class="ctrl" type="file" name="jobImageFile" accept="image/*" />
                </div>
                <div>
                  <label style="margin-top:0;">Job Image URL (Optional)</label>
                  <input class="ctrl" name="imageUrl" value="${esc(editJob?.imageUrl || "")}" placeholder="https://..." />
                  ${editJob?.imageUrl ? `<div class="note">Current: <a href="${esc(editJob.imageUrl)}" target="_blank" rel="noopener">View image</a></div>` : ``}
                </div>
              </div>

              <label>Description</label>
              <textarea class="ctrl" name="description" rows="5">${esc(editJob?.description || "")}</textarea>

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Status</label>
                  <select class="ctrl" name="status">
                    <option value="active" ${String(editJob?.status || "active") === "active" ? "selected" : ""}>Active</option>
                    <option value="paused" ${String(editJob?.status || "") === "paused" ? "selected" : ""}>Paused</option>
                    <option value="filled" ${String(editJob?.status || "") === "filled" ? "selected" : ""}>Filled</option>
                  </select>
                </div>
              </div>

              <div class="actions">
                <button type="submit" class="btn btn-primary">${editJob ? "Update Job" : "Save Job"}</button>
                ${editJob ? `<a class="btn btn-link" href="/admin/jobs?pg=1&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}">Cancel</a>` : ""}
              </div>
            </form>
          </div>
          ` : ``}

          ${showJobsExisting ? `
          <div class="card" id="job-existing">
            <div class="sectionTitle">
              <div>
                <h2>All jobs</h2>
                <p class="sub">Search, edit, and manage local job listings</p>
              </div>
            </div>

            <div class="muted" style="margin-bottom:12px;">
              Total: <strong style="color:var(--text)">${jobTotal}</strong>
              ${jobTotal ? ` · Showing ${jobShowingFrom}-${jobShowingTo}` : ``}
            </div>

            <div id="jobsList" style="display:grid; gap:var(--gap);">
              ${jobRows.length ? jobRows.map((j) => {
                const thumbHtml = j.imageUrl
                  ? `
                    <a class="thumb-link" href="${esc(j.imageUrl)}" target="_blank" rel="noopener" title="View image">
                      <img class="event-thumb-img" src="${esc(j.imageUrl)}" alt="${esc(j.title || "Job")} image" loading="lazy"
                           onerror="this.closest('.event-thumb').classList.add('broken'); this.style.display='none';" />
                      <div class="thumb-fallback">Image not found</div>
                    </a>
                  `
                  : `<div class="thumb-empty">No image</div>`;
                return `
                <div class="event-card venue-card">
                  <div class="event-thumb">${thumbHtml}</div>
                  <div class="event-left">
                    <div class="event-main">
                      <div class="event-title">#${j.id} — ${esc(j.title || "")}</div>
                      <div class="event-meta">
                        <div><strong>Slug:</strong> ${esc(j.slug || "")}</div>
                        <div><strong>Company:</strong> ${esc(j.company || "")}</div>
                        <div><strong>Location:</strong> ${esc(j.location || "")}</div>
                        <div><strong>Type:</strong> ${esc(j.employmentType || "")}</div>
                        <div><strong>Pay:</strong> ${esc(j.salaryRange || "")}</div>
                        ${j.applyUrl ? `<div><strong>Apply:</strong> <a href="${esc(j.applyUrl)}" target="_blank" rel="noopener">${esc(j.applyUrl)}</a></div>` : ``}
                        <div><strong>Status:</strong> ${esc(j.status || "active")}</div>
                      </div>
                    </div>
                    <div class="event-actions">
                      <a class="btn btn-edit" href="/admin/jobs/create?edit=${j.id}&pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}">Edit</a>
                      <form method="POST" action="/admin/jobs/${j.id}/delete?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" class="inline" onsubmit="return confirm('Delete this job listing?');">
                        <button type="submit" class="btn btn-danger">Delete</button>
                      </form>
                    </div>
                  </div>
                  <div class="event-stats">
                    <div class="stat"><span>Views</span><strong>${Number(j.viewCount || 0)}</strong></div>
                  </div>
                </div>
                `;
              }).join("") : `<div class="muted">No jobs found.</div>`}
            </div>

            ${jobPages > 1 ? `
            <div class="pager" style="margin-top:14px;">
              <div class="pager-right">
                <a class="btn" href="/admin/jobs?pg=1&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg === 1 ? 'style="opacity:.45; pointer-events:none;"' : ""}>First</a>
                <a class="btn" href="/admin/jobs?pg=${Math.max(1, pg - 1)}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg === 1 ? 'style="opacity:.45; pointer-events:none;"' : ""}>Prev</a>
                <span class="muted" style="padding:0 8px;">Page <strong style="color:var(--text)">${pg}</strong> / ${jobPages}</span>
                <a class="btn" href="/admin/jobs?pg=${Math.min(jobPages, pg + 1)}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg >= jobPages ? 'style="opacity:.45; pointer-events:none;"' : ""}>Next</a>
                <a class="btn" href="/admin/jobs?pg=${jobPages}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg >= jobPages ? 'style="opacity:.45; pointer-events:none;"' : ""}>Last</a>
              </div>
            </div>
            ` : ``}
          </div>
          ` : ``}

          ${showJobsApplicants ? `
          <div class="card" id="job-applicants">
            <div class="sectionTitle">
              <div>
                <h2>Applicants</h2>
                <p class="sub">Candidates submitted for job listings</p>
              </div>
            </div>

            <div class="kpis" style="margin-bottom:14px;">
              <div class="kpi"><div class="label">Total</div><div class="value">${Number(jobApplicantStats.total || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">New</div><div class="value">${Number(jobApplicantStats.newCount || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Reviewed</div><div class="value">${Number(jobApplicantStats.reviewedCount || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Interview</div><div class="value">${Number(jobApplicantStats.interviewCount || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Hired</div><div class="value">${Number(jobApplicantStats.hiredCount || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Rejected</div><div class="value">${Number(jobApplicantStats.rejectedCount || 0).toLocaleString("en-US")}</div></div>
            </div>

            <div class="muted" style="margin-bottom:12px;">
              Total: <strong style="color:var(--text)">${jobApplicantsTotal}</strong>
              ${jobApplicantsTotal ? ` · Showing ${jobApplicantsShowingFrom}-${jobApplicantsShowingTo}` : ``}
            </div>

            <div id="jobApplicantsList" style="display:grid; gap:var(--gap);">
              ${jobApplicantsRows.length ? jobApplicantsRows.map((a) => `
                <div class="event-card venue-card">
                  <div class="event-thumb">
                    <div class="thumb-empty">${esc(String(a.firstName || "").slice(0,1) + String(a.lastName || "").slice(0,1) || "AP")}</div>
                  </div>
                  <div class="event-left">
                    <div class="event-main">
                      <div class="event-title">#${a.id} — ${esc([a.firstName, a.lastName].filter(Boolean).join(" ") || "Applicant")}</div>
                      <div class="event-meta">
                        <div><strong>Email:</strong> ${a.email ? `<a href="mailto:${esc(a.email)}">${esc(a.email)}</a>` : "—"}</div>
                        <div><strong>Phone:</strong> ${a.phone ? `<a href="tel:${esc(a.phone)}">${esc(a.phone)}</a>` : "—"}</div>
                        <div><strong>Job:</strong> ${esc(a.jobTitle || "Unknown job")}${a.jobCompany ? ` · ${esc(a.jobCompany)}` : ""}</div>
                        <div><strong>City:</strong> ${esc(a.jobCity || "")}</div>
                        <div><strong>Status:</strong> ${esc(a.status || "new")}</div>
                        <div><strong>Source:</strong> ${esc(a.source || "direct")}</div>
                        <div><strong>Applied:</strong> ${esc(fmtPendingDate(a.createdAt))}</div>
                        ${a.resumeUrl ? `<div><strong>Resume:</strong> <a href="${esc(a.resumeUrl)}" target="_blank" rel="noopener">View</a></div>` : ``}
                      </div>
                    </div>
                  </div>
                </div>
              `).join("") : `<div class="muted">No applicants yet.</div>`}
            </div>

            ${jobApplicantsPages > 1 ? `
            <div class="pager" style="margin-top:14px;">
              <div class="pager-right">
                <a class="btn" href="/admin/jobs/applicants?pg=1&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg === 1 ? 'style="opacity:.45; pointer-events:none;"' : ""}>First</a>
                <a class="btn" href="/admin/jobs/applicants?pg=${Math.max(1, pg - 1)}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg === 1 ? 'style="opacity:.45; pointer-events:none;"' : ""}>Prev</a>
                <span class="muted" style="padding:0 8px;">Page <strong style="color:var(--text)">${pg}</strong> / ${jobApplicantsPages}</span>
                <a class="btn" href="/admin/jobs/applicants?pg=${Math.min(jobApplicantsPages, pg + 1)}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg >= jobApplicantsPages ? 'style="opacity:.45; pointer-events:none;"' : ""}>Next</a>
                <a class="btn" href="/admin/jobs/applicants?pg=${jobApplicantsPages}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg >= jobApplicantsPages ? 'style="opacity:.45; pointer-events:none;"' : ""}>Last</a>
              </div>
            </div>
            ` : ``}
          </div>
          ` : ``}

          ${showJobsAnalytics ? `
          <div class="card" id="jobs-analytics">
            <div class="sectionTitle">
              <div>
                <h2>Job analytics</h2>
                <p class="sub">Performance and funnel metrics for job listings</p>
              </div>
            </div>

            <div class="kpis">
              <div class="kpi"><div class="label">Total Jobs</div><div class="value">${Number(jobAnalyticsStats.total || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Active</div><div class="value">${Number(jobAnalyticsStats.active || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Paused</div><div class="value">${Number(jobAnalyticsStats.paused || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Filled</div><div class="value">${Number(jobAnalyticsStats.filled || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Total Views</div><div class="value">${Number(jobAnalyticsStats.views || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Avg Views / Job</div><div class="value">${Number(jobAnalyticsStats.avgViews || 0).toLocaleString("en-US")}</div></div>
            </div>

            <div class="venue-analytics-grid2" style="margin-top:14px;">
              <div class="card">
                <div class="sectionTitle">
                  <div>
                    <h2>Job data quality</h2>
                    <p class="sub">Coverage for key listing fields</p>
                  </div>
                </div>
                <div class="mini">
                  <div class="kv"><span class="k">With image</span><strong class="v">${Number(jobAnalyticsStats.withImage || 0).toLocaleString("en-US")}</strong></div>
                  <div class="kv"><span class="k">With pay range</span><strong class="v">${Number(jobAnalyticsStats.withPay || 0).toLocaleString("en-US")}</strong></div>
                  <div class="kv"><span class="k">With apply URL</span><strong class="v">${Number(jobAnalyticsStats.withApplyUrl || 0).toLocaleString("en-US")}</strong></div>
                </div>
              </div>

              <div class="card">
                <div class="sectionTitle">
                  <div>
                    <h2>Applicants funnel</h2>
                    <p class="sub">Status totals across all applicants</p>
                  </div>
                </div>
                <div class="mini">
                  <div class="kv"><span class="k">Total applicants</span><strong class="v">${Number(jobApplicantStats.total || 0).toLocaleString("en-US")}</strong></div>
                  <div class="kv"><span class="k">New</span><strong class="v">${Number(jobApplicantStats.newCount || 0).toLocaleString("en-US")}</strong></div>
                  <div class="kv"><span class="k">Reviewed</span><strong class="v">${Number(jobApplicantStats.reviewedCount || 0).toLocaleString("en-US")}</strong></div>
                  <div class="kv"><span class="k">Interview</span><strong class="v">${Number(jobApplicantStats.interviewCount || 0).toLocaleString("en-US")}</strong></div>
                  <div class="kv"><span class="k">Hired</span><strong class="v">${Number(jobApplicantStats.hiredCount || 0).toLocaleString("en-US")}</strong></div>
                  <div class="kv"><span class="k">Rejected</span><strong class="v">${Number(jobApplicantStats.rejectedCount || 0).toLocaleString("en-US")}</strong></div>
                </div>
              </div>
            </div>

            <div class="card" style="margin-top:14px;">
              <div class="sectionTitle">
                <div>
                  <h2>Employment type breakdown</h2>
                  <p class="sub">Distribution by listing type</p>
                </div>
              </div>
              <div class="mini">
                ${jobTypeRows.length ? jobTypeRows.map((r) => `
                  <div class="kv"><span class="k">${esc(r.employmentType || "(unspecified)")}</span><strong class="v">${Number(r.n || 0).toLocaleString("en-US")}</strong></div>
                `).join("") : `<div class="muted">No job listings yet.</div>`}
              </div>
            </div>
          </div>
          ` : ``}
        </section>
        ` : ``}

        ${(showAdsCreate || showAdsExisting || showAdsAnalytics) ? `
        <section class="gridMain single" id="ads">
          ${showAdsCreate ? `
          <div class="card" id="ads-create">
            <div class="sectionTitle">
              <div>
                <h2>${editAd ? "Edit ad" : "Create ad"}</h2>
                <p class="sub">Manage a rotating ad with weighted visibility</p>
              </div>
              <div class="right">
                <span class="pill">/${esc(selectedCity.toLowerCase())}</span>
              </div>
            </div>

            <form method="POST" action="/admin/ads" enctype="multipart/form-data">
              ${editAd ? `<input type="hidden" name="id" value="${esc(editAd.id)}" />` : ""}
              <input type="hidden" name="city" value="${esc(editAd?.city || selectedCity)}" />

              <label>Ad Name</label>
              <input class="ctrl" name="name" value="${esc(editAd?.name || "")}" required />

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Placement</label>
                  <input class="ctrl" name="placement" value="${esc(editAd?.placement || "default")}" placeholder="homepage-sidebar" required />
                  <div class="note">Use the same placement key anywhere this ad slot appears.</div>
                </div>
                <div>
                  <label style="margin-top:0;">Visibility %</label>
                  <input class="ctrl" type="number" name="visibilityPercent" min="0" max="100" step="0.1" value="${esc(editAd?.visibilityPercent ?? 100)}" required />
                  <div class="note">Example: 25 means this ad is eligible 25% of the time for its slot.</div>
                </div>
              </div>

              <label>Target URL</label>
              <input class="ctrl" name="targetUrl" value="${esc(editAd?.targetUrl || "")}" placeholder="https://..." required />

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Ad Image (Upload)</label>
                  <input class="ctrl" type="file" name="adImageFile" accept="image/*" />
                </div>
                <div>
                  <label style="margin-top:0;">Ad Image URL (Optional)</label>
                  <input class="ctrl" name="imageUrl" value="${esc(editAd?.imageUrl || "")}" placeholder="https://..." />
                  ${editAd?.imageUrl ? `<div class="note">Current: <a href="${esc(editAd.imageUrl)}" target="_blank" rel="noopener">View image</a></div>` : ``}
                </div>
              </div>

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Alt Text</label>
                  <input class="ctrl" name="altText" value="${esc(editAd?.altText || "")}" placeholder="Sponsor banner alt text" />
                </div>
                <div>
                  <label style="margin-top:0;">Status</label>
                  <select class="ctrl" name="status">
                    <option value="active" ${String(editAd?.status || "active") === "active" ? "selected" : ""}>Active</option>
                    <option value="paused" ${String(editAd?.status || "") === "paused" ? "selected" : ""}>Paused</option>
                  </select>
                </div>
              </div>

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Start Date</label>
                  <input class="ctrl" type="date" name="startsAt" value="${esc(String(editAd?.startsAt || "").slice(0, 10))}" />
                </div>
                <div>
                  <label style="margin-top:0;">End Date</label>
                  <input class="ctrl" type="date" name="endsAt" value="${esc(String(editAd?.endsAt || "").slice(0, 10))}" />
                </div>
              </div>

              <label>Notes</label>
              <textarea class="ctrl" name="notes" rows="4" placeholder="Optional internal notes">${esc(editAd?.notes || "")}</textarea>

              <div class="actions">
                <button type="submit" class="btn btn-primary">${editAd ? "Update Ad" : "Save Ad"}</button>
                ${editAd ? `<a class="btn btn-link" href="/admin/ads?pg=1&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}">Cancel</a>` : ""}
              </div>
            </form>
          </div>
          ` : ``}

          ${showAdsExisting ? `
          <div class="card" id="ads-existing">
            <div class="sectionTitle">
              <div>
                <h2>All ads</h2>
                <p class="sub">Search, edit, and manage rotating ad inventory</p>
              </div>
            </div>

            <div class="muted" style="margin-bottom:12px;">
              Total: <strong style="color:var(--text)">${adTotal}</strong>
              ${adTotal ? ` · Showing ${adShowingFrom}-${adShowingTo}` : ``}
            </div>

            <div id="adsList" style="display:grid; gap:var(--gap);">
              ${adRows.length ? adRows.map((ad) => {
                const thumbHtml = ad.imageUrl
                  ? `
                    <a class="thumb-link" href="${esc(ad.imageUrl)}" target="_blank" rel="noopener" title="View image">
                      <img class="event-thumb-img" src="${esc(ad.imageUrl)}" alt="${esc(ad.altText || ad.name || "Ad")} image" loading="lazy"
                           onerror="this.closest('.event-thumb').classList.add('broken'); this.style.display='none';" />
                      <div class="thumb-fallback">Image not found</div>
                    </a>
                  `
                  : `<div class="thumb-empty">No image</div>`;
                return `
                <div class="event-card venue-card">
                  <div class="event-thumb">${thumbHtml}</div>
                  <div class="event-left">
                    <div class="event-main">
                      <div class="event-title">#${ad.id} — ${esc(ad.name || "")}</div>
                      <div class="event-meta">
                        <div><strong>Slug:</strong> ${esc(ad.slug || "")}</div>
                        <div><strong>Placement:</strong> ${esc(ad.placement || "default")}</div>
                        <div><strong>Visibility:</strong> ${Number(ad.visibilityPercent || 0).toLocaleString("en-US")}%</div>
                        <div><strong>Status:</strong> ${esc(ad.status || "active")}</div>
                        <div><strong>Target:</strong> ${ad.targetUrl ? `<a href="${esc(ad.targetUrl)}" target="_blank" rel="noopener">${esc(ad.targetUrl)}</a>` : "—"}</div>
                        ${(ad.startsAt || ad.endsAt) ? `<div><strong>Schedule:</strong> ${esc(String(ad.startsAt || "").slice(0, 10) || "Now")} to ${esc(String(ad.endsAt || "").slice(0, 10) || "Open")}</div>` : ``}
                      </div>
                    </div>
                    <div class="event-actions">
                      <a class="btn btn-edit" href="/admin/ads/create?edit=${ad.id}&pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}">Edit</a>
                      <form method="POST" action="/admin/ads/${ad.id}/delete?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" class="inline" onsubmit="return confirm('Delete this ad?');">
                        <button type="submit" class="btn btn-danger">Delete</button>
                      </form>
                    </div>
                  </div>
                  <div class="event-stats">
                    <div class="stat"><span>Views</span><strong>${Number(ad.viewCount || 0)}</strong></div>
                    <div class="stat"><span>Clicks</span><strong>${Number(ad.clickCount || 0)}</strong></div>
                  </div>
                </div>
                `;
              }).join("") : `<div class="muted">No ads found.</div>`}
            </div>

            ${adPages > 1 ? `
            <div class="pager" style="margin-top:14px;">
              <div class="pager-right">
                <a class="btn" href="/admin/ads?pg=1&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg === 1 ? 'style="opacity:.45; pointer-events:none;"' : ""}>First</a>
                <a class="btn" href="/admin/ads?pg=${Math.max(1, pg - 1)}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg === 1 ? 'style="opacity:.45; pointer-events:none;"' : ""}>Prev</a>
                <span class="muted" style="padding:0 8px;">Page <strong style="color:var(--text)">${pg}</strong> / ${adPages}</span>
                <a class="btn" href="/admin/ads?pg=${Math.min(adPages, pg + 1)}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg >= adPages ? 'style="opacity:.45; pointer-events:none;"' : ""}>Next</a>
                <a class="btn" href="/admin/ads?pg=${adPages}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}" ${pg >= adPages ? 'style="opacity:.45; pointer-events:none;"' : ""}>Last</a>
              </div>
            </div>
            ` : ``}
          </div>
          ` : ``}

          ${showAdsAnalytics ? `
          <div class="card" id="ads-analytics">
            <div class="sectionTitle">
              <div>
                <h2>Ads analytics</h2>
                <p class="sub">Track visibility and clicks for rotating ads</p>
              </div>
            </div>

            <div class="kpis">
              <div class="kpi"><div class="label">Total Ads</div><div class="value">${Number(adAnalyticsStats.total || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Active</div><div class="value">${Number(adAnalyticsStats.active || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Paused</div><div class="value">${Number(adAnalyticsStats.paused || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Total Views</div><div class="value">${Number(adAnalyticsStats.views || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Total Clicks</div><div class="value">${Number(adAnalyticsStats.clicks || 0).toLocaleString("en-US")}</div></div>
              <div class="kpi"><div class="label">Avg CTR</div><div class="value">${adAnalyticsStats.views ? `${Math.round((Number(adAnalyticsStats.clicks || 0) / Number(adAnalyticsStats.views || 1)) * 100)}%` : "0%"}</div></div>
            </div>

            <div class="venue-analytics-grid2" style="margin-top:14px;">
              <div class="card">
                <div class="sectionTitle">
                  <div>
                    <h2>Top ads by views</h2>
                    <p class="sub">Most seen placements</p>
                  </div>
                </div>
                <div class="mini">
                  ${adTopViewsRows.length ? adTopViewsRows.map((ad) => `
                    <div class="kv">
                      <span class="k"><a href="/admin/ads/create?edit=${ad.id}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}">${esc(ad.name)}</a></span>
                      <strong class="v">${Number(ad.viewCount || 0).toLocaleString("en-US")}</strong>
                    </div>
                  `).join("") : `<div class="muted">No ad views yet.</div>`}
                </div>
              </div>

              <div class="card">
                <div class="sectionTitle">
                  <div>
                    <h2>Top ads by clicks</h2>
                    <p class="sub">Highest click volume</p>
                  </div>
                </div>
                <div class="mini">
                  ${adTopClicksRows.length ? adTopClicksRows.map((ad) => `
                    <div class="kv">
                      <span class="k"><a href="/admin/ads/create?edit=${ad.id}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}">${esc(ad.name)}</a></span>
                      <strong class="v">${Number(ad.clickCount || 0).toLocaleString("en-US")}</strong>
                    </div>
                  `).join("") : `<div class="muted">No ad clicks yet.</div>`}
                </div>
              </div>
            </div>

            <div class="card" style="margin-top:14px;">
              <div class="sectionTitle">
                <div>
                  <h2>Ad monthly performance</h2>
                  <p class="sub">Choose one ad to review monthly views and clicks</p>
                </div>
              </div>
              <form class="analytics-toolbar" method="GET" action="/admin/ads/analytics">
                ${selectedCity ? `<input type="hidden" name="city" value="${esc(selectedCity)}" />` : ``}
                <div style="min-width:0; flex:1 1 260px;">
                  <label for="adAnalyticsSelect" style="margin-top:0;">Ad</label>
                  <select id="adAnalyticsSelect" name="ad" class="ctrl">
                    ${adAnalyticsOptions.length
                      ? adAnalyticsOptions.map((ad) => `
                        <option value="${Number(ad.id || 0)}" ${selectedAdActualId === Number(ad.id || 0) ? "selected" : ""}>
                          ${esc(ad.name || `Ad #${ad.id}`)} · ${esc(ad.placement || "default")}
                        </option>
                      `).join("")
                      : `<option value="">No ads available</option>`}
                  </select>
                </div>
                <button class="btn btn-primary" type="submit" ${adAnalyticsOptions.length ? "" : "disabled"}>View ad</button>
              </form>

              <div class="venue-analytics-grid2" style="margin-top:14px;">
                <div class="card">
                  <div class="sectionTitle">
                    <div>
                      <h2>Placement breakdown</h2>
                      <p class="sub">How many ads exist per slot</p>
                    </div>
                  </div>
                  <div class="mini">
                    ${adPlacementRows.length ? adPlacementRows.map((row) => `
                      <div class="kv"><span class="k">${esc(row.placement || "default")}</span><strong class="v">${Number(row.n || 0).toLocaleString("en-US")}</strong></div>
                    `).join("") : `<div class="muted">No ads yet.</div>`}
                  </div>
                </div>

                <div class="card">
                  ${selectedAd ? `
                  <div class="mini">
                    <div class="kv"><span class="k">Placement</span><strong class="v">${esc(selectedAd.placement || "default")}</strong></div>
                    <div class="kv"><span class="k">Lifetime views</span><strong class="v">${Number(selectedAd.viewCount || 0).toLocaleString("en-US")}</strong></div>
                    <div class="kv"><span class="k">Lifetime clicks</span><strong class="v">${Number(selectedAd.clickCount || 0).toLocaleString("en-US")}</strong></div>
                  </div>
                  ` : `<div class="muted">Select an ad to view details.</div>`}
                </div>
              </div>

              ${selectedAd ? `
              <div class="venue-monthly-grid" style="margin-top:14px;">
                <div class="mini">
                  <div class="sectionTitle sectionTitle--chart" style="margin-bottom:10px;">
                    <div class="left">
                      <div style="font-weight:700;">${esc(selectedAd.name || `Ad #${selectedAd.id}`)} monthly performance</div>
                      <p class="sub">Last 12 months</p>
                    </div>
                    <div class="right">
                      <div class="metricToggle" id="adChartMetricSeg" aria-label="Ad metric toggle">
                        <button type="button" data-metric="views" class="on">Views</button>
                        <button type="button" data-metric="clicks">Clicks</button>
                      </div>
                    </div>
                  </div>
                  <div class="chart-wrap" id="adChartWrap" style="min-height:320px;">
                    <div id="adChartData" data-chart="${esc(adChartDataJson)}" hidden></div>
                    <canvas id="adChart" style="width:100%; height:260px; display:block;"></canvas>
                    <div id="adChartTip" style="position:absolute; display:none; pointer-events:none; padding:6px 8px; border-radius:10px; border:1px solid rgba(148,163,184,.35); background:rgba(255,255,255,.98); color:rgba(15,23,42,.95); font-size:12px; line-height:1.2; box-shadow:none;"></div>
                  </div>
                </div>
              </div>
              ` : `<div class="muted" style="margin-top:12px;">Create an ad first to see monthly performance.</div>`}
            </div>
          </div>
          ` : ``}
        </section>
        ` : ``}

      </main>
    </div>

    <script>
      // ---- helpers ----
      (function(){
        var groups = document.querySelectorAll("[data-nav-group]");
        if (!groups || !groups.length) return;
        groups.forEach(function(group){
          var toggle = group.querySelector("[data-nav-toggle]");
          if (!toggle) return;
          toggle.addEventListener("click", function(){
            var open = toggle.getAttribute("aria-expanded") === "true";
            groups.forEach(function(other){
              var t = other.querySelector("[data-nav-toggle]");
              if (!t) return;
              other.classList.remove("is-open");
              t.setAttribute("aria-expanded", "false");
            });
            if (!open) {
              group.classList.add("is-open");
              toggle.setAttribute("aria-expanded", "true");
            }
          });
        });
        document.addEventListener("click", function(e){
          if (e.target.closest(".sidebar")) return;
          groups.forEach(function(group){
            var t = group.querySelector("[data-nav-toggle]");
            if (!t) return;
            group.classList.remove("is-open");
            t.setAttribute("aria-expanded", "false");
          });
        });
      })();

      // ---- dashboard card collapse ----
      (function(){
        var cards = document.querySelectorAll('[data-collapsible-card]');
        if (!cards || !cards.length) return;
        cards.forEach(function(card){
          var btn = card.querySelector('[data-card-toggle]');
          if (!btn) return;
          btn.addEventListener('click', function(){
            var collapsed = card.getAttribute('data-collapsed') === 'true';
            card.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
            btn.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
          });
        });
      })();

      // ---- sort dropdown (server-side) ----
      (function(){
        var sel = document.getElementById("sortBy");
        if (!sel) return;
        sel.addEventListener("change", function(){
          var sp = new URLSearchParams(window.location.search || "");
          sp.set("sort", sel.value);
          sp.set("pg", "1");
          window.location.href = "/admin/existing-events?" + sp.toString();
        });
      })();


      function toISOWithOffsetFromLocalInput(dtLocal) {
        var d = new Date(dtLocal);
        if (isNaN(d.getTime())) return "";
        function pad(n){ return String(n).padStart(2, "0"); }
        var y = d.getFullYear();
        var m = pad(d.getMonth() + 1);
        var day = pad(d.getDate());
        var hh = pad(d.getHours());
        var mm = pad(d.getMinutes());
        var ss = "00";
        var offsetMin = -d.getTimezoneOffset();
        var sign = offsetMin >= 0 ? "+" : "-";
        var abs = Math.abs(offsetMin);
        var offH = pad(Math.floor(abs / 60));
        var offM = pad(abs % 60);
        return y + "-" + m + "-" + day + "T" + hh + ":" + mm + ":" + ss + sign + offH + ":" + offM;
      }

      // ---- Date ISO fields on submit + custom recurrence serialization ----
      (function(){
        var form = document.querySelector('form[action="/admin/events"]');
        if(!form) return;

        form.addEventListener("submit", function(){
          try {
            sessionStorage.setItem("oc_admin_scroll", String(window.scrollY || 0));
          } catch (_) {}
          var startLocal = (document.getElementById("startDateTime") || {}).value || "";
          var endLocal   = (document.getElementById("endDateTime") || {}).value || "";

          var startISO = toISOWithOffsetFromLocalInput(startLocal);
          var endISO   = toISOWithOffsetFromLocalInput(endLocal);

          var startHidden = document.getElementById("startDateTimeISO");
          var endHidden   = document.getElementById("endDateTimeISO");
          if(startHidden) startHidden.value = startISO;
          if(endHidden) endHidden.value = endISO;

          var recHidden = document.getElementById("recurrenceDatesJson");
          var hasRec = !!((document.getElementById("hasRecurrence") || {}).checked);
          var recType = String(((document.getElementById("recurrenceType") || {}).value) || "").toLowerCase();

          if (recHidden) {
            if (hasRec && recType === "custom") {
              var wrap = document.getElementById("customDatesWrap");
              var chips = wrap ? wrap.querySelectorAll(".chip") : [];
              var fallbackStart = (startLocal && startLocal.length >= 16) ? startLocal.slice(11,16) : "00:00";
              var fallbackEnd = (endLocal && endLocal.length >= 16) ? endLocal.slice(11,16) : fallbackStart;

              var items = [];
              for (var i=0;i<chips.length;i++){
                var chip = chips[i];
                var date = (chip.querySelector('input[name="customDate"]') || {}).value || "";
                if (!date) continue;
                var st = (chip.querySelector('input[name="customStart"]') || {}).value || "";
                var en = (chip.querySelector('input[name="customEnd"]') || {}).value || "";
                var sIso = toISOWithOffsetFromLocalInput(date + "T" + (st || fallbackStart));
                var eIso = toISOWithOffsetFromLocalInput(date + "T" + (en || fallbackEnd));
                if (!sIso || !eIso) continue;
                items.push({ date: date, start: sIso, end: eIso });
              }
              recHidden.value = JSON.stringify(items);
            } else {
              recHidden.value = "";
            }
          }
        });
      })();

      // Auto-set End = Start + 2 hours (only if end is empty)
      (function(){
        var startEl = document.getElementById("startDateTime");
        var endEl = document.getElementById("endDateTime");
        if (!startEl || !endEl) return;

        function pad(n){ return String(n).padStart(2, "0"); }

        startEl.addEventListener("change", function(){
          if (!startEl.value) return;
          if (!endEl.value) {
            var d = new Date(startEl.value);
            if (isNaN(d.getTime())) return;
            d.setHours(d.getHours() + 2);
            endEl.value =
              d.getFullYear() + "-" +
              pad(d.getMonth() + 1) + "-" +
              pad(d.getDate()) + "T" +
              pad(d.getHours()) + ":" +
              pad(d.getMinutes());
          }
        });
      })();

      // Upload preview
      (function () {
        var fileInput = document.getElementById("imageFileInput");
        var preview = document.getElementById("uploadPreview");
        if (!fileInput || !preview) return;

        fileInput.addEventListener("change", function () {
          var f = fileInput.files && fileInput.files[0];
          if (!f) {
            preview.style.display = "none";
            preview.src = "";
            return;
          }
          preview.src = URL.createObjectURL(f);
          preview.style.display = "block";
        });
      })();

      // Sidebar city dropdown -> switch city
      (function(){
        var dd = document.getElementById("sbCityDD");
        var btn = document.getElementById("sbCityBtn");
        var menu = document.getElementById("sbCityMenu");
        var label = document.getElementById("sbCityLabel");
        var hidden = document.getElementById("cityHidden");
        if (!dd || !btn || !menu || !label) return;

        function closeMenu(){
          dd.classList.remove("is-open");
          btn.setAttribute("aria-expanded", "false");
        }
        function openMenu(){
          dd.classList.add("is-open");
          btn.setAttribute("aria-expanded", "true");
        }

        btn.addEventListener("click", function(){
          if (dd.classList.contains("is-open")) closeMenu();
          else openMenu();
        });

        menu.addEventListener("click", function(e){
          var opt = e.target.closest(".sb-city-opt");
          if (!opt) return;
          var city = opt.getAttribute("data-city") || "";
          if (city){
            label.textContent = city;
            if (hidden) hidden.value = city;
            menu.querySelectorAll(".sb-city-opt").forEach(function(b){
              b.classList.toggle("is-active", b === opt);
            });
            var url = new URL(window.location.href);
            url.searchParams.set("city", city);
            url.searchParams.delete("pg");
            window.location.href = url.toString();
          }
          closeMenu();
        });

        document.addEventListener("click", function(e){
          if (!dd.contains(e.target)) closeMenu();
        });
        document.addEventListener("keydown", function(e){
          if (e.key === "Escape") closeMenu();
        });
      })();

      // Server-side filter (applies across all pages)
      (function(){
        var input = document.getElementById('eventSearch');
        var fromInput = document.getElementById('eventDateFrom');
        var toInput = document.getElementById('eventDateTo');
        var applyBtn = document.getElementById('eventSearchApply');
        var clearBtn = document.getElementById('eventSearchClear');
        if(!input) return;

        function go(){
          try {
            sessionStorage.setItem("oc_admin_scroll", String(window.scrollY || 0));
          } catch (_) {}
          var q = String(input.value || '').trim();
          var sp = new URLSearchParams(window.location.search || '');
          var from = String((fromInput && fromInput.value) || '').trim();
          var to = String((toInput && toInput.value) || '').trim();
          if (q) sp.set('q', q); else sp.delete('q');
          if (from) sp.set('from', from); else sp.delete('from');
          if (to) sp.set('to', to); else sp.delete('to');
          sp.set('pg', '1');
          window.location.href = window.location.pathname + '?' + sp.toString();
        }

        input.addEventListener('keydown', function(ev){
          if (ev.key === 'Enter') {
            ev.preventDefault();
            go();
          }
        });
        if(applyBtn){
          applyBtn.addEventListener('click', function(){
            go();
          });
        }
        if(clearBtn){
          clearBtn.addEventListener('click', function(){
            input.value = '';
            if (fromInput) fromInput.value = '';
            if (toInput) toInput.value = '';
            go();
          });
        }
      })();

      // Restore scroll position after actions
      (function(){
        try {
          var y = sessionStorage.getItem("oc_admin_scroll");
          if (y !== null) {
            sessionStorage.removeItem("oc_admin_scroll");
            var n = parseInt(y, 10);
            if (!isNaN(n) && n > 0) window.scrollTo({ top: n, left: 0, behavior: "auto" });
          }
        } catch (_) {}
      })();

      // Recurrence UI show/hide + custom chips
      (function(){
        var hasRecEl = document.getElementById("hasRecurrence");
        var typeEl = document.getElementById("recurrenceType");
        var intervalRow = document.getElementById("intervalRow");
        var weeklyBox = document.getElementById("weeklyBox");
        var monthlyBox = document.getElementById("monthlyBox");
        var customBox = document.getElementById("customBox");

        var monthlyModeEl = document.getElementById("monthlyMode");
        var monthdayBox = document.getElementById("monthdayBox");
        var nthweekdayBox = document.getElementById("nthweekdayBox");

        function show(el, on){
          if(!el) return;
          el.style.display = on ? "" : "none";
        }

        function sync(){
          var enabled = !!(hasRecEl && hasRecEl.checked);
          var t = typeEl ? String(typeEl.value || "none") : "none";

          if(!enabled){
            show(intervalRow, false);
            show(weeklyBox, false);
            show(monthlyBox, false);
            show(customBox, false);
            return;
          }

          show(intervalRow, true);
          show(weeklyBox, t === "weekly");
          show(monthlyBox, t === "monthly");
          show(customBox, t === "custom");

          if(t === "monthly"){
            var mm = monthlyModeEl ? String(monthlyModeEl.value || "monthday") : "monthday";
            show(monthdayBox, mm === "monthday");
            show(nthweekdayBox, mm === "nthweekday");
          } else {
            show(monthdayBox, false);
            show(nthweekdayBox, false);
          }
        }

        if(hasRecEl) hasRecEl.addEventListener("change", sync);
        if(typeEl) typeEl.addEventListener("change", sync);
        if(monthlyModeEl) monthlyModeEl.addEventListener("change", sync);
        sync();

        // Custom date chips
        var addBtn = document.getElementById("addCustomDate");
        var wrap = document.getElementById("customDatesWrap");

        function attachRemove(){
          if(!wrap) return;
          var btns = wrap.querySelectorAll("button[data-remove-date]");
          for(var i=0;i<btns.length;i++){
            btns[i].onclick = function(){
              var chip = this.closest(".chip");
              if(chip) chip.remove();
            };
          }
        }
        attachRemove();

        if(addBtn && wrap){
          addBtn.addEventListener("click", function(){
            var chip = document.createElement("span");
            chip.className = "chip";

            var startLocal = (document.getElementById("startDateTime") && document.getElementById("startDateTime").value) ? document.getElementById("startDateTime").value : "";
            var endLocal   = (document.getElementById("endDateTime") && document.getElementById("endDateTime").value) ? document.getElementById("endDateTime").value : "";
            var startTime = startLocal && startLocal.length >= 16 ? startLocal.slice(11,16) : "";
            var endTime   = endLocal && endLocal.length >= 16 ? endLocal.slice(11,16) : startTime;

            chip.innerHTML =
              '<input class="ctrl" style="width:160px; padding:8px 10px;" type="date" name="customDate" value="" />' +
              '<input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customStart" value="" />' +
              '<input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customEnd" value="" />' +
              '<button type="button" data-remove-date="1" aria-label="Remove">×</button>';

            wrap.appendChild(chip);

            var st = chip.querySelector('input[name="customStart"]');
            var en = chip.querySelector('input[name="customEnd"]');
            if(st && startTime) st.value = startTime;
            if(en && endTime) en.value = endTime;

            attachRemove();
          });
        }

        // Remove past custom dates (date-only compare)
        var pruneBtn = document.getElementById("prunePastDates");
        if (pruneBtn && wrap){
          pruneBtn.addEventListener("click", function(){
            var today = new Date();
            var yyyy = today.getFullYear();
            var mm = String(today.getMonth() + 1).padStart(2, "0");
            var dd = String(today.getDate()).padStart(2, "0");
            var todayStr = yyyy + "-" + mm + "-" + dd;

            var chips = wrap.querySelectorAll(".chip");
            for (var i=0;i<chips.length;i++){
              var chip = chips[i];
              var date = (chip.querySelector('input[name="customDate"]') || {}).value || "";
              if (date && date < todayStr) {
                chip.remove();
              }
            }
          });
        }
      })();

      // Live going/interested/views refresh (safe)
      (function(){
        async function refreshOne(card){
          var id = card.getAttribute("data-eid");
          if(!id) return;

          try{
            var res = await fetch("/events/" + encodeURIComponent(id), { headers: { "Accept": "application/json" } });
            if(!res.ok) return;
            var json = await res.json();
            var e = (json && json.data) ? json.data : json;

            var v = card.querySelector(".js-views");
            var u = card.querySelector(".js-unique");
            var g = card.querySelector(".js-going");
            var i = card.querySelector(".js-interested");

            if(v && typeof e.viewCount !== "undefined") v.textContent = String(Number(e.viewCount || 0));
            if(u && typeof e.uniqueViewCount !== "undefined") u.textContent = String(Number(e.uniqueViewCount || 0));
            if(g && typeof e.goingCount !== "undefined") g.textContent = String(Number(e.goingCount || 0));
            if(i && typeof e.interestedCount !== "undefined") i.textContent = String(Number(e.interestedCount || 0));
          }catch(_){}
        }

        function tick(){
          var cards = document.querySelectorAll(".event-card[data-eid]");
          for(var j=0;j<cards.length;j++){
            refreshOne(cards[j]);
          }
        }
        tick();
        setInterval(tick, 4000);
      })();

      // Simple bar chart (no libraries) + hover tooltip + view toggles
(function(){
  function initEventsChart(){
    const $data   = document.getElementById("eventsChartData");
    const $canvas = document.getElementById("eventsChart");
    const $wrap   = document.getElementById("eventsChartWrap");
    const $tip    = document.getElementById("eventsChartTip");
    const $seg    = document.getElementById("chartViewSeg");
    const $range  = document.getElementById("chartRangeLabel");
    const $pastEl = document.getElementById("chartPast");
    const $upEl   = document.getElementById("chartUpcoming");

    if (!$canvas || !$wrap) return;
    const ctx = $canvas.getContext("2d");
    if (!ctx) return;

    let chartSets = { events: {}, views: {} };
    try {
      if ($data) {
        const parsed = JSON.parse($data.getAttribute("data-chart") || "{}");
        if (parsed && typeof parsed === "object") {
          chartSets = parsed;
        }
      }
    } catch (_) {}

    let mode = "daily";
    let metric = "events";
    let hoverIndex = -1;
    let resizeRetry = 0;

  function setActiveBtn(){
    if ($seg) {
      $seg.querySelectorAll("[data-view]").forEach((b) => {
        const on = (b.getAttribute("data-view") === mode);
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
    const metricSeg = document.getElementById("chartMetricSeg");
    if (metricSeg) {
      metricSeg.querySelectorAll("[data-metric]").forEach((b) => {
        const on = (b.getAttribute("data-metric") === metric);
        b.classList.toggle("on", on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }
  }

  function setRangeLabel(){
    if (!$range) return;
    const map = {
      daily:  "Last 14 days (by start date)",
      weekly: "Last 12 weeks (by start date)",
      monthly:"Last 12 months (by start date)",
      yearly: "Last 5 years (by start date)",
    };
    $range.textContent = map[mode] || map.daily;
  }

  function setSubcounts(){
    if (!$pastEl || !$upEl) return;
    const key = (metric === "views") ? "views" : "events";
    const pastVal = $pastEl.getAttribute("data-" + key) || "0";
    const upVal = $upEl.getAttribute("data-" + key) || "0";
    $pastEl.textContent = pastVal;
    $upEl.textContent = upVal;
  }

  function sizeCanvas(){
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    // Some layouts briefly report 0 widths while CSS loads; fall back to bounding boxes.
    let w = $wrap.clientWidth;
    if (!w || w < 10) w = Math.floor($wrap.getBoundingClientRect().width || 0);
    if (!w || w < 10) w = Math.floor(($canvas.parentElement ? $canvas.parentElement.getBoundingClientRect().width : 0) || 0);
    w = Math.max(320, w);

    let h = $wrap.clientHeight;
    if (!h || h < 10) h = Math.floor($wrap.getBoundingClientRect().height || 0);
    h = Math.max(260, h || 360);

    $canvas.style.width  = w + "px";
    $canvas.style.height = h + "px";
    $canvas.width  = Math.floor(w * dpr);
    $canvas.height = Math.floor(h * dpr);

    ctx.setTransform(dpr,0,0,dpr,0,0); // draw in CSS pixels
    return { w, h, ready: (w > 0 && h > 0) };
  }

  function draw(){
    const set = (chartSets[metric] && chartSets[metric][mode]) ? chartSets[metric][mode] : chartSets.events.daily;
    const labels = (set && set.labels) ? set.labels : [];
    const values = (set && set.values) ? set.values : [];

    const { w, h, ready } = sizeCanvas();
    if (!ready) {
      window.requestAnimationFrame(draw);
      return;
    }
    ctx.clearRect(0,0,w,h);

    if (!labels.length || !values.length){
      ctx.fillStyle = "rgba(15,23,42,.75)";
      ctx.font = "600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.fillText("No recent events", 18, 90);
      return;
    }

    const padL = 56, padR = 18, padT = 18, padB = 46;
    const gw = w - padL - padR;
    const gh = h - padT - padB;

    const maxV = Math.max(1, ...values);
    const yTicks = Math.min(6, maxV);
    const tickStep = Math.max(1, Math.ceil(maxV / yTicks));
    const yMax = tickStep * yTicks;

    // grid + y labels
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(15,23,42,.12)";
    ctx.fillStyle = "rgba(15,23,42,.92)";
    ctx.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

    for (let i=0;i<=yTicks;i++){
      const v = i * tickStep;
      const y = padT + gh - (v / yMax) * gh;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL+gw, y); ctx.stroke();
      ctx.fillText(String(v), 18, y+4);
    }

    // x labels + bars
    const n = values.length;
    const gap = 16;
    const barW = Math.max(10, Math.floor((gw - gap*(n-1)) / n));
    const totalW = barW*n + gap*(n-1);
    const x0 = padL + Math.max(0, (gw-totalW)/2);

    // x label style
    ctx.fillStyle = "rgba(15,23,42,.92)";
    ctx.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

    for (let i=0;i<n;i++){
      const v = values[i];
      const bh = (v / yMax) * gh;
      const x = x0 + i*(barW+gap);
      const y = padT + gh - bh;

      // bar
      ctx.fillStyle = "rgba(16,185,129,.45)";
      ctx.fillRect(x, y, barW, bh);

      // hover outline
      if (i === hoverIndex){
        ctx.strokeStyle = "rgba(16,185,129,.95)";
        ctx.lineWidth = 2;
        ctx.strokeRect(x+0.5, y+0.5, barW-1, bh-1);
        ctx.lineWidth = 1;
      }

      // label
      const lab = labels[i] || "";
      ctx.save();
      ctx.translate(x + barW/2, padT + gh + 22);
      ctx.rotate(-0.35);
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(15,23,42,.92)";
      ctx.fillText(lab, 0, 0);
      ctx.restore();
    }
  }

  function getBarIndexFromEvent(ev){
    const set = (chartSets[metric] && chartSets[metric][mode]) ? chartSets[metric][mode] : chartSets.events.daily;
    const values = (set && set.values) ? set.values : [];
    if (!values.length) return -1;

    const rect = $canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;

    const padL = 56, padR = 18, padT = 18, padB = 46;
    const gw = rect.width - padL - padR;
    const gh = rect.height - padT - padB;

    if (mx < padL || mx > padL+gw || my < padT || my > padT+gh) return -1;

    const n = values.length;
    const gap = 16;
    const barW = Math.max(10, Math.floor((gw - gap*(n-1)) / n));
    const totalW = barW*n + gap*(n-1);
    const x0 = padL + Math.max(0, (gw-totalW)/2);

    for (let i=0;i<n;i++){
      const x = x0 + i*(barW+gap);
      if (mx >= x && mx <= x+barW) return i;
    }
    return -1;
  }

  function showTip(ev, idx){
    if (!$tip) return;
    const set = (chartSets[metric] && chartSets[metric][mode]) ? chartSets[metric][mode] : chartSets.events.daily;
    const labels = (set && set.labels) ? set.labels : [];
    const values = (set && set.values) ? set.values : [];

    const rect = $canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const y = ev.clientY - rect.top;

    const value = values[idx] ?? 0;

    if (metric === "views") {
      $tip.textContent = String(value) + " view" + (value === 1 ? "" : "s");
    } else {
      $tip.textContent = String(value) + " event" + (value === 1 ? "" : "s");
    }
    $tip.style.display = "block";

    const tipRect = $tip.getBoundingClientRect();
    const left = Math.min(rect.left + rect.width - tipRect.width - 10, rect.left + x + 12);
    const top  = Math.max(rect.top + 10, rect.top + y - 32);

    $tip.style.left = (left - rect.left) + "px";
    $tip.style.top  = (top - rect.top) + "px";
  }

  function hideTip(){
    if ($tip) $tip.style.display = "none";
  }

  // Bind toggle
  if ($seg){
    $seg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-view]");
      if (!btn) return;
      mode = btn.getAttribute("data-view") || "daily";
      hoverIndex = -1;
      hideTip();
      setActiveBtn();
      setRangeLabel();
      setSubcounts();
      draw();
    });
  }

  const metricSeg = document.getElementById("chartMetricSeg");
  if (metricSeg){
    metricSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-metric]");
      if (!btn) return;
      metric = btn.getAttribute("data-metric") || "events";
      hoverIndex = -1;
      hideTip();
      setActiveBtn();
      setSubcounts();
      draw();
    });
  }

  // Hover tooltip
  $canvas.addEventListener("mousemove", (e) => {
    const idx = getBarIndexFromEvent(e);
    if (idx !== hoverIndex){
      hoverIndex = idx;
      draw();
    }
    if (idx >= 0) showTip(e, idx); else hideTip();
  });
  $canvas.addEventListener("mouseleave", () => {
    hoverIndex = -1;
    hideTip();
    draw();
  });

  // Initial paint / resize
  function init(){
    setActiveBtn();
    setRangeLabel();
    setSubcounts();
    draw();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.addEventListener("resize", () => window.requestAnimationFrame(draw));
}

  function initVenueChart(){
    const $data = document.getElementById("venueChartData");
    const $canvas = document.getElementById("venueChart");
    const $wrap = document.getElementById("venueChartWrap");
    const $tip = document.getElementById("venueChartTip");
    const $metricSeg = document.getElementById("venueChartMetricSeg");
    if (!$canvas || !$wrap || !$metricSeg) return;

    const ctx = $canvas.getContext("2d");
    if (!ctx) return;

    let chartSets = {
      views: { labels: [], values: [] },
      clicks: { labels: [], values: [] },
    };
    try {
      if ($data) {
        const parsed = JSON.parse($data.getAttribute("data-chart") || "{}");
        if (parsed && typeof parsed === "object") {
          chartSets = {
            views: {
              labels: Array.isArray(parsed.views?.labels) ? parsed.views.labels : [],
              values: Array.isArray(parsed.views?.values) ? parsed.views.values : [],
            },
            clicks: {
              labels: Array.isArray(parsed.clicks?.labels) ? parsed.clicks.labels : [],
              values: Array.isArray(parsed.clicks?.values) ? parsed.clicks.values : [],
            },
          };
        }
      }
    } catch (_) {}

    let metric = "views";
    let hoverIndex = -1;

    function getSet(){
      return chartSets[metric] || { labels: [], values: [] };
    }

    function setActiveBtn(){
      $metricSeg.querySelectorAll("[data-metric]").forEach((btn) => {
        const on = btn.getAttribute("data-metric") === metric;
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    function sizeCanvas(){
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      let w = $wrap.clientWidth;
      if (!w || w < 10) w = Math.floor($wrap.getBoundingClientRect().width || 0);
      w = Math.max(320, w);
      let h = $wrap.clientHeight;
      if (!h || h < 10) h = Math.floor($wrap.getBoundingClientRect().height || 0);
      h = Math.max(260, h || 320);
      $canvas.style.width = w + "px";
      $canvas.style.height = h + "px";
      $canvas.width = Math.floor(w * dpr);
      $canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }

    function draw(){
      const set = getSet();
      const labels = set.labels || [];
      const values = set.values || [];
      const { w, h } = sizeCanvas();
      ctx.clearRect(0, 0, w, h);

      if (!labels.length || !values.length) {
        ctx.fillStyle = "rgba(15,23,42,.75)";
        ctx.font = "600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.fillText("No monthly venue history yet", 18, 90);
        return;
      }

      const padL = 56, padR = 18, padT = 18, padB = 46;
      const gw = w - padL - padR;
      const gh = h - padT - padB;
      const maxV = Math.max(1, ...values);
      const yTicks = Math.min(6, maxV);
      const tickStep = Math.max(1, Math.ceil(maxV / yTicks));
      const yMax = tickStep * yTicks;

      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(15,23,42,.12)";
      ctx.fillStyle = "rgba(15,23,42,.92)";
      ctx.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

      for (let i = 0; i <= yTicks; i++) {
        const v = i * tickStep;
        const y = padT + gh - (v / yMax) * gh;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + gw, y);
        ctx.stroke();
        ctx.fillText(String(v), 18, y + 4);
      }

      const n = values.length;
      const gap = 16;
      const barW = Math.max(10, Math.floor((gw - gap * (n - 1)) / n));
      const totalW = barW * n + gap * (n - 1);
      const x0 = padL + Math.max(0, (gw - totalW) / 2);

      for (let i = 0; i < n; i++) {
        const v = values[i];
        const bh = (v / yMax) * gh;
        const x = x0 + i * (barW + gap);
        const y = padT + gh - bh;

        ctx.fillStyle = metric === "clicks" ? "rgba(59,130,246,.45)" : "rgba(16,185,129,.45)";
        ctx.fillRect(x, y, barW, bh);

        if (i === hoverIndex) {
          ctx.strokeStyle = metric === "clicks" ? "rgba(59,130,246,.95)" : "rgba(16,185,129,.95)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, bh - 1);
          ctx.lineWidth = 1;
        }

        const lab = labels[i] || "";
        ctx.save();
        ctx.translate(x + barW / 2, padT + gh + 22);
        ctx.rotate(-0.35);
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(15,23,42,.92)";
        ctx.fillText(lab, 0, 0);
        ctx.restore();
      }
    }

    function getBarIndexFromEvent(ev){
      const set = getSet();
      const values = set.values || [];
      if (!values.length) return -1;
      const rect = $canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const padL = 56, padR = 18, padT = 18, padB = 46;
      const gw = rect.width - padL - padR;
      const gh = rect.height - padT - padB;
      if (mx < padL || mx > padL + gw || my < padT || my > padT + gh) return -1;
      const n = values.length;
      const gap = 16;
      const barW = Math.max(10, Math.floor((gw - gap * (n - 1)) / n));
      const totalW = barW * n + gap * (n - 1);
      const x0 = padL + Math.max(0, (gw - totalW) / 2);
      for (let i = 0; i < n; i++) {
        const x = x0 + i * (barW + gap);
        if (mx >= x && mx <= x + barW) return i;
      }
      return -1;
    }

    function showTip(ev, idx){
      if (!$tip) return;
      const set = getSet();
      const labels = set.labels || [];
      const values = set.values || [];
      const value = Number(values[idx] || 0);
      $tip.textContent =
        String(labels[idx] || "") +
        ": " +
        value.toLocaleString("en-US") +
        " " +
        (metric === "clicks" ? "clicks" : "views");
      $tip.style.display = "block";
      const rect = $canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const tipRect = $tip.getBoundingClientRect();
      const left = Math.min(rect.width - tipRect.width - 10, x + 12);
      const top = Math.max(10, y - 32);
      $tip.style.left = left + "px";
      $tip.style.top = top + "px";
    }

    function hideTip(){
      if ($tip) $tip.style.display = "none";
    }

    $metricSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-metric]");
      if (!btn) return;
      metric = btn.getAttribute("data-metric") || "views";
      hoverIndex = -1;
      hideTip();
      setActiveBtn();
      draw();
    });

    $canvas.addEventListener("mousemove", (e) => {
      const idx = getBarIndexFromEvent(e);
      if (idx !== hoverIndex) {
        hoverIndex = idx;
        draw();
      }
      if (idx >= 0) showTip(e, idx); else hideTip();
    });
    $canvas.addEventListener("mouseleave", () => {
      hoverIndex = -1;
      hideTip();
      draw();
    });

    setActiveBtn();
    draw();
    window.addEventListener("resize", () => window.requestAnimationFrame(draw));
  }

  function initAdChart(){
    const $data = document.getElementById("adChartData");
    const $canvas = document.getElementById("adChart");
    const $wrap = document.getElementById("adChartWrap");
    const $tip = document.getElementById("adChartTip");
    const $metricSeg = document.getElementById("adChartMetricSeg");
    if (!$canvas || !$wrap || !$metricSeg) return;

    const ctx = $canvas.getContext("2d");
    if (!ctx) return;

    let chartSets = {
      views: { labels: [], values: [] },
      clicks: { labels: [], values: [] },
    };
    try {
      if ($data) {
        const parsed = JSON.parse($data.getAttribute("data-chart") || "{}");
        if (parsed && typeof parsed === "object") {
          chartSets = {
            views: {
              labels: Array.isArray(parsed.views?.labels) ? parsed.views.labels : [],
              values: Array.isArray(parsed.views?.values) ? parsed.views.values : [],
            },
            clicks: {
              labels: Array.isArray(parsed.clicks?.labels) ? parsed.clicks.labels : [],
              values: Array.isArray(parsed.clicks?.values) ? parsed.clicks.values : [],
            },
          };
        }
      }
    } catch (_) {}

    let metric = "views";
    let hoverIndex = -1;

    function getSet(){
      return chartSets[metric] || { labels: [], values: [] };
    }

    function setActiveBtn(){
      $metricSeg.querySelectorAll("[data-metric]").forEach((btn) => {
        const on = btn.getAttribute("data-metric") === metric;
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    function sizeCanvas(){
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      let w = $wrap.clientWidth;
      if (!w || w < 10) w = Math.floor($wrap.getBoundingClientRect().width || 0);
      w = Math.max(320, w);
      let h = $wrap.clientHeight;
      if (!h || h < 10) h = Math.floor($wrap.getBoundingClientRect().height || 0);
      h = Math.max(260, h || 320);
      $canvas.style.width = w + "px";
      $canvas.style.height = h + "px";
      $canvas.width = Math.floor(w * dpr);
      $canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }

    function draw(){
      const set = getSet();
      const labels = set.labels || [];
      const values = set.values || [];
      const out = sizeCanvas();
      const w = out.w;
      const h = out.h;
      ctx.clearRect(0, 0, w, h);

      if (!labels.length || !values.length) {
        ctx.fillStyle = "rgba(15,23,42,.75)";
        ctx.font = "600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.fillText("No monthly ad history yet", 18, 90);
        return;
      }

      const padL = 56, padR = 18, padT = 18, padB = 46;
      const gw = w - padL - padR;
      const gh = h - padT - padB;
      const maxV = Math.max(1, ...values);
      const yTicks = Math.min(6, maxV);
      const tickStep = Math.max(1, Math.ceil(maxV / yTicks));
      const yMax = tickStep * yTicks;

      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(15,23,42,.12)";
      ctx.fillStyle = "rgba(15,23,42,.92)";
      ctx.font = "600 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

      for (let i = 0; i <= yTicks; i++) {
        const v = i * tickStep;
        const y = padT + gh - (v / yMax) * gh;
        ctx.beginPath();
        ctx.moveTo(padL, y);
        ctx.lineTo(padL + gw, y);
        ctx.stroke();
        ctx.fillText(String(v), 18, y + 4);
      }

      const n = values.length;
      const gap = 16;
      const barW = Math.max(10, Math.floor((gw - gap * (n - 1)) / n));
      const totalW = barW * n + gap * (n - 1);
      const x0 = padL + Math.max(0, (gw - totalW) / 2);

      for (let i = 0; i < n; i++) {
        const v = values[i];
        const bh = (v / yMax) * gh;
        const x = x0 + i * (barW + gap);
        const y = padT + gh - bh;

        ctx.fillStyle = metric === "clicks" ? "rgba(59,130,246,.45)" : "rgba(16,185,129,.45)";
        ctx.fillRect(x, y, barW, bh);

        if (i === hoverIndex) {
          ctx.strokeStyle = metric === "clicks" ? "rgba(59,130,246,.95)" : "rgba(16,185,129,.95)";
          ctx.lineWidth = 2;
          ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, bh - 1);
          ctx.lineWidth = 1;
        }

        const lab = labels[i] || "";
        ctx.save();
        ctx.translate(x + barW / 2, padT + gh + 22);
        ctx.rotate(-0.35);
        ctx.textAlign = "center";
        ctx.fillStyle = "rgba(15,23,42,.92)";
        ctx.fillText(lab, 0, 0);
        ctx.restore();
      }
    }

    function getBarIndexFromEvent(ev){
      const set = getSet();
      const values = set.values || [];
      if (!values.length) return -1;
      const rect = $canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const padL = 56, padR = 18, padT = 18, padB = 46;
      const gw = rect.width - padL - padR;
      const gh = rect.height - padT - padB;
      if (mx < padL || mx > padL + gw || my < padT || my > padT + gh) return -1;
      const n = values.length;
      const gap = 16;
      const barW = Math.max(10, Math.floor((gw - gap * (n - 1)) / n));
      const totalW = barW * n + gap * (n - 1);
      const x0 = padL + Math.max(0, (gw - totalW) / 2);
      for (let i = 0; i < n; i++) {
        const x = x0 + i * (barW + gap);
        if (mx >= x && mx <= x + barW) return i;
      }
      return -1;
    }

    function showTip(ev, idx){
      if (!$tip) return;
      const set = getSet();
      const labels = set.labels || [];
      const values = set.values || [];
      const value = Number(values[idx] || 0);
      $tip.textContent =
        String(labels[idx] || "") +
        ": " +
        value.toLocaleString("en-US") +
        " " +
        (metric === "clicks" ? "clicks" : "views");
      $tip.style.display = "block";
      const rect = $canvas.getBoundingClientRect();
      const x = ev.clientX - rect.left;
      const y = ev.clientY - rect.top;
      const tipRect = $tip.getBoundingClientRect();
      const left = Math.min(rect.width - tipRect.width - 10, x + 12);
      const top = Math.max(10, y - 32);
      $tip.style.left = left + "px";
      $tip.style.top = top + "px";
    }

    function hideTip(){
      if ($tip) $tip.style.display = "none";
    }

    $metricSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-metric]");
      if (!btn) return;
      metric = btn.getAttribute("data-metric") || "views";
      hoverIndex = -1;
      hideTip();
      setActiveBtn();
      draw();
    });

    $canvas.addEventListener("mousemove", (e) => {
      const idx = getBarIndexFromEvent(e);
      if (idx !== hoverIndex) {
        hoverIndex = idx;
        draw();
      }
      if (idx >= 0) showTip(e, idx); else hideTip();
    });
    $canvas.addEventListener("mouseleave", () => {
      hoverIndex = -1;
      hideTip();
      draw();
    });

    setActiveBtn();
    draw();
    window.addEventListener("resize", () => window.requestAnimationFrame(draw));
  }

  initEventsChart();
  initVenueChart();
  initAdChart();
})();</script>
  </body>
</html>`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Internal server error");
  }
}

router.get("/", async (req, res) => renderAdmin(req, res, "dashboard"));
router.get("/events-analytics", async (req, res) => renderAdmin(req, res, "events-analytics"));
router.get("/create-events", async (req, res) => renderAdmin(req, res, "create"));
router.get("/approve-events", async (req, res) => renderAdmin(req, res, "approve"));
router.get("/existing-events", async (req, res) => renderAdmin(req, res, "existing"));
router.get("/venues", async (req, res) => renderAdmin(req, res, "venues-existing"));
router.get("/venues/create", async (req, res) => renderAdmin(req, res, "venues-create"));
router.get("/venues/analytics", async (req, res) => renderAdmin(req, res, "venues-analytics"));
router.get("/jobs", async (req, res) => renderAdmin(req, res, "jobs-existing"));
router.get("/jobs/create", async (req, res) => renderAdmin(req, res, "jobs-create"));
router.get("/jobs/applicants", async (req, res) => renderAdmin(req, res, "jobs-applicants"));
router.get("/jobs/analytics", async (req, res) => renderAdmin(req, res, "jobs-analytics"));
router.get("/ads", async (req, res) => renderAdmin(req, res, "ads-existing"));
router.get("/ads/create", async (req, res) => renderAdmin(req, res, "ads-create"));
router.get("/ads/analytics", async (req, res) => renderAdmin(req, res, "ads-analytics"));
router.get("/preferences", async (req, res) => renderAdmin(req, res, "preferences"));
router.get("/invites", async (req, res) => renderAdmin(req, res, "invites"));
router.get("/users", async (req, res) => renderAdmin(req, res, "users"));
router.get("/pending-count", async (req, res) => {
  try {
    const city = String(req.query.city || "Enumclaw");
    const row = await get("SELECT COUNT(*) AS n FROM pending_events WHERE city = ?", [city]);
    return res.json({ ok: true, count: Number(row?.n || 0) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, count: 0 });
  }
});

// Create invite (admin)
router.post("/invites", async (req, res) => {
  try {
    const userRole = req.user?.role || "creator";
    if (userRole !== "admin") return res.status(403).send("Forbidden");
    const email = String(req.body?.email || "").trim().toLowerCase() || null;
    const role = String(req.body?.role || "creator");
    const city = String(req.body?.city || req.query.city || "Enumclaw");
    const days = Math.max(1, Math.min(30, parseInt(req.body?.days || "7", 10)));
    const token = crypto.randomBytes(20).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    await run(
      "INSERT INTO invites (email, tokenHash, role, city, expiresAt) VALUES (?, ?, ?, ?, ?)",
      [email, tokenHash, role, city, expiresAt]
    );
    return res.redirect(`/admin/invites?invite=${encodeURIComponent(token)}&city=${encodeURIComponent(city)}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to create invite.");
  }
});

router.post("/preferences", upload.single("profilePhoto"), async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor" || role === "creator")) {
      return res.status(403).send("Forbidden");
    }
    const u = await resolveSessionUser(req);
    if (!u?.id) return res.redirect("/admin/preferences?notice=user_not_found");

    const displayName = String(req.body?.displayName || "").trim().slice(0, 120);
    const phone = String(req.body?.phone || "").trim().slice(0, 40);
    const bio = String(req.body?.bio || "").trim().slice(0, 3000);
    let photoUrl = normalizeHttpUrl(req.body?.photoUrl || "");

    if (req.file) {
      if (useR2) {
        const base = (R2_PUBLIC_URL || "").replace(/\/+$/, "");
        const keyName = req.file.key || req.file.filename || "";
        if (base && keyName) photoUrl = `${base}/${keyName}`;
      } else if (req.file.filename) {
        const proto = req.get("x-forwarded-proto") || req.protocol;
        const host = req.get("host");
        photoUrl = `${proto}://${host}/uploads/${req.file.filename}`;
      }
    }

    await run(
      "UPDATE users SET displayName = ?, phone = ?, bio = ?, photoUrl = ?, updatedAt = datetime('now') WHERE id = ?",
      [displayName || null, phone || null, bio || null, photoUrl || null, u.id]
    );
    return res.redirect("/admin/preferences?notice=profile_saved");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to update preferences.");
  }
});

router.post("/preferences/password", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor" || role === "creator")) {
      return res.status(403).send("Forbidden");
    }
    const sessionUser = await resolveSessionUser(req);
    const u = sessionUser?.id
      ? await get("SELECT id, passwordHash FROM users WHERE id = ? LIMIT 1", [sessionUser.id])
      : null;
    if (!u?.id) return res.redirect("/admin/preferences?notice=user_not_found");

    const currentPassword = String(req.body?.currentPassword || "");
    const newPassword = String(req.body?.newPassword || "");
    const confirmPassword = String(req.body?.confirmPassword || "");

    if (newPassword.length < 8) return res.redirect("/admin/preferences?notice=password_short");
    if (newPassword !== confirmPassword) return res.redirect("/admin/preferences?notice=password_mismatch");
    if (!verifyPassword(currentPassword, u.passwordHash || "")) return res.redirect("/admin/preferences?notice=password_invalid");

    const nextHash = hashPassword(newPassword);
    await run("UPDATE users SET passwordHash = ?, updatedAt = datetime('now') WHERE id = ?", [nextHash, u.id]);
    return res.redirect("/admin/preferences?notice=password_saved");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to update password.");
  }
});

router.post("/invites/:id/delete", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (role !== "admin") return res.status(403).send("Forbidden");
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.redirect("/admin/invites");
    await run("DELETE FROM invites WHERE id = ?", [id]);
    return res.redirect("/admin/invites");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to delete invite.");
  }
});

// Users admin actions
router.post("/users/:id/role", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (role !== "admin") return res.status(403).send("Forbidden");
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.redirect("/admin/users");
    const newRole = String(req.body?.role || "creator");
    const newCity = String(req.body?.city || "Enumclaw");
    await run("UPDATE users SET role = ?, city = ? WHERE id = ?", [newRole, newCity, id]);
    return res.redirect("/admin/users");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to update user.");
  }
});

router.post("/users/:id/delete", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (role !== "admin") return res.status(403).send("Forbidden");
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.redirect("/admin/users");
    await run("DELETE FROM users WHERE id = ?", [id]);
    return res.redirect("/admin/users");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to delete user.");
  }
});

router.post("/users/:id/reset", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (role !== "admin") return res.status(403).send("Forbidden");
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.redirect("/admin/users");

    const u = await get("SELECT id, email FROM users WHERE id = ?", [id]);
    if (!u || !u.email) return res.redirect("/admin/users");

    const token = crypto.randomBytes(24).toString("hex");
    const tokenHash = hashToken(token);
    const exp = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await run(
      "INSERT INTO password_resets (userId, tokenHash, expiresAt) VALUES (?, ?, ?)",
      [u.id, tokenHash, exp]
    );
    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const link = `${baseUrl}/reset?token=${encodeURIComponent(token)}`;
    const subject = "Reset your OpenCircle password";
    const text = `Reset your password: ${link}`;
    const html = `<p>Reset your password:</p><p><a href="${link}">${link}</a></p>`;
    try { await sendEmail({ to: u.email, subject, text, html }); } catch (_) {}
    return res.redirect("/admin/users");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to send reset.");
  }
});

router.post("/users/:id/resend-invite", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (role !== "admin") return res.status(403).send("Forbidden");
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.redirect("/admin/users");

    const u = await get("SELECT id, email, role, city FROM users WHERE id = ?", [id]);
    if (!u || !u.email) return res.redirect("/admin/users?notice=no_email");

    const token = crypto.randomBytes(20).toString("hex");
    const tokenHash = hashToken(token);
    const exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    await run(
      "INSERT INTO invites (email, tokenHash, role, city, expiresAt) VALUES (?, ?, ?, ?, ?)",
      [u.email, tokenHash, u.role || "creator", u.city || "Enumclaw", exp]
    );

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const link = `${baseUrl}/invite?invite=${encodeURIComponent(token)}`;
    const subject = "You're invited to OpenCircle";
    const text = `Use this invite link to access OpenCircle: ${link}`;
    const html = `<p>Use this invite link to access OpenCircle:</p><p><a href="${link}">${link}</a></p>`;
    try {
      await sendEmail({ to: u.email, subject, text, html });
    } catch (e) {
      console.error("[MAIL] invite failed", e);
      return res.redirect("/admin/users?notice=send_failed");
    }

    return res.redirect("/admin/users?notice=sent");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to resend invite.");
  }
});

// POST /admin/events (create or update)
router.post("/venues", upload.fields([{ name: "venueImageFile", maxCount: 1 }, { name: "venueGalleryFiles", maxCount: 3 }]), async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor" || role === "creator")) {
      return res.status(403).send("Forbidden");
    }
    await ensureVenueSchema();

    const idRaw = String(req.body?.id || "").trim();
    const id = idRaw ? parseInt(idRaw, 10) : null;
    const isUpdate = Number.isInteger(id) && id > 0;

    const userCity = String(req.user?.city || "Enumclaw");
    const city = role === "admin"
      ? String(req.body?.city || req.query.city || userCity || "Enumclaw").trim() || "Enumclaw"
      : userCity;

    const name = String(req.body?.name || "").trim();
    const address = String(req.body?.address || "").trim();
    const website = normalizeHttpUrl(req.body?.website || "");
    const phone = String(req.body?.phone || "").trim();
    let imageUrl = String(req.body?.imageUrl || "").trim();
    let galleryImages = normalizeGalleryImages([
      req.body?.galleryImage1,
      req.body?.galleryImage2,
      req.body?.galleryImage3,
    ], 3);
    const description = String(req.body?.description || "").trim();
    const seoTitle = String(req.body?.seoTitle || "").trim();
    const metaDescription = String(req.body?.metaDescription || "").trim();
    const focusKeyphrase = String(req.body?.focusKeyphrase || "").trim();
    const imageAlt = String(req.body?.imageAlt || "").trim();
    const social = {
      facebook: String(req.body?.socialFacebook || "").trim(),
      instagram: String(req.body?.socialInstagram || "").trim(),
      x: String(req.body?.socialX || "").trim(),
      tiktok: String(req.body?.socialTiktok || "").trim(),
      youtube: String(req.body?.socialYoutube || "").trim(),
      linkedin: String(req.body?.socialLinkedin || "").trim(),
    };
    const socialJson = JSON.stringify(social);
    const venueCats = normalizeVenueCategories([
      req.body?.venueCategory1,
      req.body?.venueCategory2,
      req.body?.venueCategory3,
    ]);
    if (venueCats.length < 1) {
      return res.status(400).send("At least one venue category is required.");
    }
    const categoriesJson = JSON.stringify(venueCats);
    const venueDays = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
    const venueHours = {};
    for (const d of venueDays) {
      venueHours[d] = {
        open: String(req.body?.[`venueHours_${d}_open`] || "").trim(),
        close: String(req.body?.[`venueHours_${d}_close`] || "").trim(),
        closed: String(req.body?.[`venueHours_${d}_closed`] || "") === "1",
      };
    }
    const hoursJson = JSON.stringify(venueHours);

    const primaryFile = req.files?.venueImageFile?.[0] || null;
    const galleryFiles = Array.isArray(req.files?.venueGalleryFiles) ? req.files.venueGalleryFiles : [];

    if (primaryFile) {
      if (useR2) {
        const base = String(R2_PUBLIC_URL || "").replace(/\/$/, "");
        const key = primaryFile.key || primaryFile.filename || "";
        if (base && key) imageUrl = `${base}/${key}`;
      } else if (primaryFile.filename) {
        const proto = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["x-forwarded-host"] || req.get("host");
        imageUrl = `${proto}://${host}/uploads/${primaryFile.filename}`;
      }
    }

    if (galleryFiles.length) {
      const proto = req.headers["x-forwarded-proto"] || req.protocol;
      const host = req.headers["x-forwarded-host"] || req.get("host");
      const base = String(R2_PUBLIC_URL || "").replace(/\/$/, "");
      const uploaded = [];
      for (const f of galleryFiles.slice(0, 3)) {
        if (useR2) {
          const key = f.key || f.filename || "";
          if (base && key) uploaded.push(`${base}/${key}`);
        } else if (f.filename) {
          uploaded.push(`${proto}://${host}/uploads/${f.filename}`);
        }
      }
      galleryImages = normalizeGalleryImages([...(galleryImages || []), ...uploaded], 3);
    }

    const galleryJson = JSON.stringify(galleryImages);

    if (!name) return res.status(400).send("Venue name is required.");

    const baseSlug = slugify(name);
    const slug = await ensureUniqueVenueSlug(baseSlug, isUpdate ? id : null);

    if (isUpdate) {
      await run(
        `UPDATE venues
            SET city = ?, slug = ?, name = ?, address = ?, website = ?, phone = ?, imageUrl = ?, galleryJson = ?, categoriesJson = ?, socialJson = ?, hoursJson = ?, seoTitle = ?, metaDescription = ?, focusKeyphrase = ?, imageAlt = ?, description = ?, updatedAt = datetime('now')
          WHERE id = ?`,
        [city, slug, name, address || null, website || null, phone || null, imageUrl || null, galleryJson, categoriesJson, socialJson, hoursJson, seoTitle, metaDescription, focusKeyphrase, imageAlt, description || null, id]
      );
    } else {
      await run(
        `INSERT INTO venues (city, slug, name, address, website, phone, imageUrl, galleryJson, categoriesJson, socialJson, hoursJson, seoTitle, metaDescription, focusKeyphrase, imageAlt, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [city, slug, name, address || null, website || null, phone || null, imageUrl || null, galleryJson, categoriesJson, socialJson, hoursJson, seoTitle, metaDescription, focusKeyphrase, imageAlt, description || null]
      );
    }

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const sp = new URLSearchParams({ pg, limit });
    if (q) sp.set("q", q);
    return res.redirect(`/admin/venues?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

router.post("/venues/:id/delete", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor" || role === "creator")) {
      return res.status(403).send("Forbidden");
    }
    await ensureVenueSchema();

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    await run("DELETE FROM venues WHERE id = ?", [id]);

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const sp = new URLSearchParams({ pg, limit });
    if (q) sp.set("q", q);
    return res.redirect(`/admin/venues?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

router.post("/jobs", upload.single("jobImageFile"), async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor" || role === "creator")) {
      return res.status(403).send("Forbidden");
    }
    await ensureJobSchema();

    const idRaw = String(req.body?.id || "").trim();
    const id = idRaw ? parseInt(idRaw, 10) : null;
    const isUpdate = Number.isInteger(id) && id > 0;

    const userCity = String(req.user?.city || "Enumclaw");
    const city = role === "admin"
      ? String(req.body?.city || req.query.city || userCity || "Enumclaw").trim() || "Enumclaw"
      : userCity;

    const title = String(req.body?.title || "").trim();
    const company = String(req.body?.company || "").trim();
    const location = String(req.body?.location || "").trim();
    const employmentType = String(req.body?.employmentType || "").trim();
    const salaryRange = String(req.body?.salaryRange || "").trim();
    const applyUrl = normalizeHttpUrl(req.body?.applyUrl || "");
    const description = String(req.body?.description || "").trim();
    const statusRaw = String(req.body?.status || "active").trim().toLowerCase();
    const status = ["active", "paused", "filled"].includes(statusRaw) ? statusRaw : "active";
    let imageUrl = String(req.body?.imageUrl || "").trim();

    if (!title) return res.status(400).send("Job title is required.");
    if (!applyUrl) return res.status(400).send("Apply URL is required.");

    const imageFile = req.file || null;
    if (imageFile) {
      if (useR2) {
        const base = String(R2_PUBLIC_URL || "").replace(/\/$/, "");
        const key = imageFile.key || imageFile.filename || "";
        if (base && key) imageUrl = `${base}/${key}`;
      } else if (imageFile.filename) {
        const proto = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["x-forwarded-host"] || req.get("host");
        imageUrl = `${proto}://${host}/uploads/${imageFile.filename}`;
      }
    }

    const baseSlug = slugify(`${title}-${company}`);
    const slug = await ensureUniqueJobSlug(baseSlug, isUpdate ? id : null);

    if (isUpdate) {
      await run(
        `UPDATE jobs
            SET city = ?, slug = ?, title = ?, company = ?, location = ?, employmentType = ?, salaryRange = ?, applyUrl = ?, imageUrl = ?, description = ?, status = ?, updatedAt = datetime('now')
          WHERE id = ?`,
        [city, slug, title, company || null, location || null, employmentType || null, salaryRange || null, applyUrl || null, imageUrl || null, description || null, status, id]
      );
    } else {
      await run(
        `INSERT INTO jobs (city, slug, title, company, location, employmentType, salaryRange, applyUrl, imageUrl, description, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [city, slug, title, company || null, location || null, employmentType || null, salaryRange || null, applyUrl || null, imageUrl || null, description || null, status]
      );
    }

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const sp = new URLSearchParams({ pg, limit });
    if (q) sp.set("q", q);
    return res.redirect(`/admin/jobs?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

router.post("/jobs/:id/delete", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor" || role === "creator")) {
      return res.status(403).send("Forbidden");
    }
    await ensureJobSchema();

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    await run("DELETE FROM jobs WHERE id = ?", [id]);

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const sp = new URLSearchParams({ pg, limit });
    if (q) sp.set("q", q);
    return res.redirect(`/admin/jobs?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

router.post("/ads", upload.single("adImageFile"), async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor" || role === "creator")) {
      return res.status(403).send("Forbidden");
    }
    await ensureAdSchema();

    const idRaw = String(req.body?.id || "").trim();
    const id = idRaw ? parseInt(idRaw, 10) : null;
    const isUpdate = Number.isInteger(id) && id > 0;

    const userCity = String(req.user?.city || "Enumclaw");
    const city = role === "admin"
      ? String(req.body?.city || req.query.city || userCity || "Enumclaw").trim() || "Enumclaw"
      : userCity;

    const name = String(req.body?.name || "").trim();
    const placement = String(req.body?.placement || "default").trim() || "default";
    const targetUrl = normalizeHttpUrl(req.body?.targetUrl || "");
    let imageUrl = String(req.body?.imageUrl || "").trim();
    const altText = String(req.body?.altText || "").trim();
    const visibilityRaw = parseFloat(String(req.body?.visibilityPercent || "100"));
    const visibilityPercent = Number.isFinite(visibilityRaw)
      ? Math.max(0, Math.min(100, visibilityRaw))
      : 100;
    const statusRaw = String(req.body?.status || "active").trim().toLowerCase();
    const status = ["active", "paused"].includes(statusRaw) ? statusRaw : "active";
    const startsAtRaw = String(req.body?.startsAt || "").trim();
    const endsAtRaw = String(req.body?.endsAt || "").trim();
    const startsAt = startsAtRaw ? `${startsAtRaw}T00:00:00` : null;
    const endsAt = endsAtRaw ? `${endsAtRaw}T23:59:59` : null;
    const notes = String(req.body?.notes || "").trim();

    if (!name) return res.status(400).send("Ad name is required.");
    if (!targetUrl) return res.status(400).send("Target URL is required.");

    const imageFile = req.file || null;
    if (imageFile) {
      if (useR2) {
        const base = String(R2_PUBLIC_URL || "").replace(/\/$/, "");
        const key = imageFile.key || imageFile.filename || "";
        if (base && key) imageUrl = `${base}/${key}`;
      } else if (imageFile.filename) {
        const proto = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["x-forwarded-host"] || req.get("host");
        imageUrl = `${proto}://${host}/uploads/${imageFile.filename}`;
      }
    }

    const baseSlug = slugify(`${name}-${placement}`);
    const slug = await ensureUniqueAdSlug(baseSlug, isUpdate ? id : null);

    if (isUpdate) {
      await run(
        `UPDATE ads
            SET city = ?, slug = ?, name = ?, placement = ?, imageUrl = ?, targetUrl = ?, altText = ?, visibilityPercent = ?, status = ?, startsAt = ?, endsAt = ?, notes = ?, updatedAt = datetime('now')
          WHERE id = ?`,
        [city, slug, name, placement, imageUrl || null, targetUrl || null, altText || null, visibilityPercent, status, startsAt, endsAt, notes || null, id]
      );
    } else {
      await run(
        `INSERT INTO ads (city, slug, name, placement, imageUrl, targetUrl, altText, visibilityPercent, status, startsAt, endsAt, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [city, slug, name, placement, imageUrl || null, targetUrl || null, altText || null, visibilityPercent, status, startsAt, endsAt, notes || null]
      );
    }

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const sp = new URLSearchParams({ pg, limit });
    if (q) sp.set("q", q);
    return res.redirect(`/admin/ads?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

router.post("/ads/:id/delete", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor" || role === "creator")) {
      return res.status(403).send("Forbidden");
    }
    await ensureAdSchema();

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    await run("DELETE FROM ads WHERE id = ?", [id]);

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const sp = new URLSearchParams({ pg, limit });
    if (q) sp.set("q", q);
    return res.redirect(`/admin/ads?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

router.post("/events", upload.single("imageFile"), async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor" || role === "creator")) {
      return res.status(403).send("Forbidden");
    }
    await ensurePickSchema();

    let {
      id,
      city = "Enumclaw",
      title,
      description,
      eventDetails,
      goodToKnow,
      startDateTime,
      endDateTime,
      location,
      organizer,
      imageUrl,
      ticketUrl,
      ticketLabel,
      categories,
      featured,
      eddiesPick,
      pendingId,
      seoTitle,
      metaDescription,
      focusKeyphrase,
      imageAlt,

      hasRecurrence,
      recurrenceType,
      recurrenceInterval,
      weeklyByDay,
      monthlyMode,
      byMonthday,
      setPos,
      monthlyByDay,

      recurrenceStartDate,
      recurrenceUntilDate,

      // legacy/simple custom dates
      recurrenceDates,
    } = req.body;

    // If a file was uploaded, prefer it over the URL field
    if (req.file) {
      if (useR2) {
        const base = String(R2_PUBLIC_URL || "").replace(/\/$/, "");
        const key = req.file.key || req.file.filename || "";
        if (base && key) imageUrl = `${base}/${key}`;
      } else if (req.file.filename) {
        const proto = req.headers["x-forwarded-proto"] || req.protocol;
        const host = req.headers["x-forwarded-host"] || req.get("host");
        imageUrl = `${proto}://${host}/uploads/${req.file.filename}`;
      }
    }

    // Prefer browser-generated ISO with offset (prevents UTC shift)
    const startISO = (req.body.startDateTimeISO || "").trim();
    const endISO = (req.body.endDateTimeISO || "").trim();

    if (startISO) startDateTime = startISO;
    if (endISO) endDateTime = endISO;
    if (!startISO) startDateTime = toLocalISOWithOffset(startDateTime);
    if (!endISO) endDateTime = toLocalISOWithOffset(endDateTime);

    if (!endDateTime && startDateTime) {
      endDateTime = addHoursIso(startDateTime, 1);
    }

    // Validate required fields
    const missing = [];
    if (!title) missing.push("title");
    if (!description) missing.push("description");
    if (!startDateTime) missing.push("startDateTime");
    if (!endDateTime) missing.push("endDateTime");
    if (!location) missing.push("location");
    if (role !== "creator" && !organizer) missing.push("organizer");
    if (missing.length) {
      return res.status(400).send("Missing required fields: " + missing.join(", "));
    }

    if (ticketUrl && !/^https?:\/\//i.test(ticketUrl)) {
      return res.status(400).send("Ticket link must start with http:// or https://");
    }

    const finalTicketLabel =
      ticketLabel && String(ticketLabel).trim() ? String(ticketLabel).trim() : "Tickets";

    const startMs = Date.parse(startDateTime);
    const endMs = Date.parse(endDateTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return res.status(400).send("Invalid date/time.");
    }
    if (endMs <= startMs) {
      return res.status(400).send("End time must be after start time.");
    }

    const featuredFlag = role === "creator" ? 0 : (String(featured || "") === "1" ? 1 : 0);
    const eddiesPickFlag = role === "creator" ? 0 : (String(eddiesPick || "") === "1" ? 1 : 0);

    // Slug
    const rawSlug = String(req.body.slug || "").trim();
    const baseSlug = rawSlug ? slugify(rawSlug) : slugify(title);
    const slug = await ensureUniqueSlug(baseSlug, id ? Number(id) : null);

    // Categories (max 3, from allow-list)
    const cats = normalizeCategories(categories);
    const catsJson = JSON.stringify(cats);

    // ---- Recurrence normalize ----
    const hasRec = String(hasRecurrence || "") === "1" ? 1 : 0;
    const t = String(recurrenceType || "none").toLowerCase();

    let recurrenceRule = null;
    let recurrenceDatesJson = null;

    if (hasRec && t !== "none") {
      if (t === "custom") {
        // Prefer the hidden JSON emitted by the admin UI (keeps per-date start/end)
        let raw = safeParseJson((req.body.recurrenceDatesJson || "").trim(), []);
        if (!Array.isArray(raw)) raw = [];

        // Back-compat: if hidden JSON missing, build from the visible fields
        if (raw.length === 0) {
          const dates  = Array.isArray(req.body.customDate)  ? req.body.customDate  : (req.body.customDate  ? [req.body.customDate]  : []);
          const starts = Array.isArray(req.body.customStart) ? req.body.customStart : (req.body.customStart ? [req.body.customStart] : []);
          const ends   = Array.isArray(req.body.customEnd)   ? req.body.customEnd   : (req.body.customEnd   ? [req.body.customEnd]   : []);

          const baseStartTime = String(startDateTime || "").slice(11,16) || "00:00";
          const baseEndTime   = String(endDateTime || "").slice(11,16) || baseStartTime;

          for (let i = 0; i < dates.length; i++) {
            const date = String(dates[i] || "").trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            const st = String(starts[i] || "").trim();
            const en = String(ends[i] || "").trim();

            // NOTE: this is a fallback; the UI should normally submit full ISO strings.
            const startIso = toLocalISOWithOffset(`${date}T${st || baseStartTime}`);
            const endIso   = toLocalISOWithOffset(`${date}T${en || baseEndTime}`);

            raw.push({ date, start: startIso, end: endIso });
          }
        }

        // Legacy: accept recurrenceDates (date-only array)
        if (raw.length === 0) {
          let arr = [];
          if (Array.isArray(recurrenceDates)) arr = recurrenceDates;
          else if (typeof recurrenceDates === "string" && recurrenceDates.trim() !== "") arr = [recurrenceDates];
          raw = arr;
        }

        const uniqDates = [];
        const items = [];

        for (const it of raw) {
          // Date-only string
          if (typeof it === "string") {
            const date = String(it || "").trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            if (!uniqDates.includes(date)) uniqDates.push(date);

            // Create an item using the base times so the admin UI can round-trip
            if (String(startDateTime || "").length >= 16 && String(endDateTime || "").length >= 16) {
              items.push({
                date,
                start: date + String(startDateTime).slice(10),
                end: date + String(endDateTime).slice(10),
              });
            }
            continue;
          }

          // Object with start/end
          if (it && typeof it === "object") {
            const s = String(it.start || "").trim();
            const e = String(it.end || "").trim();
            let date = String(it.date || "").trim();
            if (!date && s.length >= 10) date = s.slice(0,10);
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

            if (!uniqDates.includes(date)) uniqDates.push(date);
            if (s && e) items.push({ date, start: s, end: e });
          }
        }

        uniqDates.sort();
        items.sort((a,b) => String(a.start||"").localeCompare(String(b.start||"")));

        recurrenceRule = items.length ? { type: "custom", items } : { type: "custom" };
        recurrenceDatesJson = JSON.stringify(uniqDates);
      }

      if (t === "weekly") {
        let days = [];
        if (Array.isArray(weeklyByDay)) days = weeklyByDay;
        else if (typeof weeklyByDay === "string" && weeklyByDay.trim() !== "") days = [weeklyByDay];

        const allowed = new Set(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
        const uniq = [];
        for (const d of days.map((x) => String(x).trim()).filter(Boolean)) {
          if (!allowed.has(d)) continue;
          if (!uniq.includes(d)) uniq.push(d);
        }

        const interval = Math.max(1, parseInt(recurrenceInterval || "1", 10) || 1);
        recurrenceRule = { type: "weekly", interval, byDay: uniq };
      }

      if (t === "monthly") {
        const interval = Math.max(1, parseInt(recurrenceInterval || "1", 10) || 1);
        const mode = String(monthlyMode || "monthday");

        if (mode === "nthweekday") {
          let days = [];
          if (Array.isArray(monthlyByDay)) days = monthlyByDay;
          else if (typeof monthlyByDay === "string" && monthlyByDay.trim() !== "") days = [monthlyByDay];

          const allowed = new Set(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
          const uniq = [];
          for (const d of days.map((x) => String(x || "").trim().toUpperCase()).filter(Boolean)) {
            if (!allowed.has(d)) continue;
            if (!uniq.includes(d)) uniq.push(d);
          }
          if (!uniq.length) uniq.push("MO");

          const sp = parseInt(setPos || "1", 10);
          recurrenceRule = { type: "monthly", interval, mode: "nthweekday", setPos: sp, byDay: uniq };
        } else {
          const md = Math.max(1, Math.min(31, parseInt(byMonthday || "0", 10) || 0));
          recurrenceRule = { type: "monthly", interval, mode: "monthday", byMonthday: md };
        }
      }
    }

    // Creator submissions should go to pending approvals instead of publishing
    if (role === "creator" && !id && !pendingId) {
      const organizerSafe = organizer ? String(organizer).trim() : "";
      const eventLinkSafe = String(req.body.eventLink || "").trim() || null;
      const submitterEmail = String(req.body.submitterEmail || "").trim() || "";
      const approvalNotes = String(req.body.approvalNotes || "").trim() || "";
      const source = "admin_creator";

      await run(
        `INSERT INTO pending_events
          (city, title, description, eventDetails, goodToKnow, ticketUrl, ticketLabel,
           startDateTime, endDateTime, location, organizer, imageUrl, eventLink, categories,
           submitterEmail, approvalNotes, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          city, title, description, eventDetails || "", goodToKnow || "", ticketUrl || "", finalTicketLabel,
          startDateTime, endDateTime, location, organizerSafe, imageUrl || "", eventLinkSafe, catsJson,
          submitterEmail, approvalNotes, source
        ]
      );

      return res.redirect(`/admin/create-events?submitted=1&city=${encodeURIComponent(city)}`);
    }

    const recurrenceRuleJson = recurrenceRule ? JSON.stringify(recurrenceRule) : null;

    const cols = await getEventsColumns();

    const normYmd = (v) => {
      const s = String(v || "").trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    };

    const recurrenceStartDateClean = normYmd(recurrenceStartDate);
    const recurrenceUntilDateClean = normYmd(recurrenceUntilDate);

    // ---- Build fields ----
    const baseFields = [
      ["city", city],
      ["slug", slug],
      ["title", title],
      ["description", description],
      ["eventDetails", eventDetails || ""],
      ["goodToKnow", goodToKnow || ""],
      ["seoTitle", String(seoTitle || "")],
      ["metaDescription", String(metaDescription || "")],
      ["focusKeyphrase", String(focusKeyphrase || "")],
      ["imageAlt", String(imageAlt || "")],
      ["startDateTime", startDateTime],
      ["endDateTime", endDateTime],
      ["location", location],
      ["organizer", organizer],
      ["imageUrl", imageUrl || null],
      ["ticketUrl", ticketUrl || null],
      ["ticketLabel", finalTicketLabel],
      ["categories", catsJson],
      ["featured", featuredFlag],
      ["eddiesPick", eddiesPickFlag],
    ];

    const recFields = [
      ["hasRecurrence", hasRec],
      ["recurrenceRule", recurrenceRuleJson],
      ["recurrenceDates", recurrenceDatesJson],
      ["recurrenceStartDate", recurrenceStartDateClean],
      ["recurrenceUntilDate", recurrenceUntilDateClean],
    ];

    const fields = [...baseFields];

    // Only include recurrence columns if they exist in DB
    const hasRecCols =
      cols.has("hasRecurrence") &&
      cols.has("recurrenceRule") &&
      cols.has("recurrenceDates") &&
      cols.has("recurrenceStartDate") &&
      cols.has("recurrenceUntilDate");

    if (hasRecCols) fields.push(...recFields);

    const isUpdate = id !== undefined && id !== null && String(id).trim() !== "";

    if (isUpdate) {
      const sets = [];
      const vals = [];
      for (const [k, v] of fields) {
        if (!cols.size || cols.has(k)) {
          sets.push(`${k}=?`);
          vals.push(v);
        }
      }
      vals.push(Number(id));

await run(`UPDATE events SET ${sets.join(", ")} WHERE id=?`, vals);

// preserve list state (pg/limit/q) if present
const pg = req.query.pg ? String(req.query.pg) : "1";
const limit = req.query.limit ? String(req.query.limit) : "20";
const q = req.query.q ? String(req.query.q) : "";
const from = req.query.from ? String(req.query.from) : "";
const to = req.query.to ? String(req.query.to) : "";

const status = req.query.status ? String(req.query.status) : "upcoming";
const recurring = req.query.recurring ? String(req.query.recurring) : "0";

const sp = new URLSearchParams({ edit: String(id), pg, limit, status });
if (recurring === "1") sp.set("recurring", "1");
if (q) sp.set("q", q);
if (from) sp.set("from", from);
if (to) sp.set("to", to);

return res.redirect(`/admin/create-events?${sp.toString()}`);

    } else {
      const insertCols = [];
      const placeholders = [];
      const insertVals = [];

      for (const [k, v] of fields) {
        if (!cols.size || cols.has(k)) {
          insertCols.push(k);
          placeholders.push("?");
          insertVals.push(v);
        }
      }

await run(
  `INSERT INTO events (${insertCols.join(", ")}) VALUES (${placeholders.join(", ")})`,
  insertVals
);

// If this event came from a pending submission, remove it from the queue
if (pendingId) {
  const pid = parseInt(pendingId, 10);
  if (!Number.isNaN(pid)) {
    await run("DELETE FROM pending_events WHERE id = ?", [pid]);
  }
}

const pg = req.query.pg ? String(req.query.pg) : "1";
const limit = req.query.limit ? String(req.query.limit) : "20";
const q = req.query.q ? String(req.query.q) : "";
const from = req.query.from ? String(req.query.from) : "";
const to = req.query.to ? String(req.query.to) : "";

const status = req.query.status ? String(req.query.status) : "upcoming";
const recurring = req.query.recurring ? String(req.query.recurring) : "0";

const sp = new URLSearchParams({ pg, limit, status });
if (recurring === "1") sp.set("recurring", "1");
if (q) sp.set("q", q);
if (from) sp.set("from", from);
if (to) sp.set("to", to);

return res.redirect(`/admin/create-events?${sp.toString()}`);

    }
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error.");
  }
});

// Approve pending submission (create event)
router.post("/approve-events/:id/approve", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor")) return res.status(403).send("Forbidden");
    await ensurePickSchema();
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    const pending = await get("SELECT * FROM pending_events WHERE id = ?", [id]);
    if (!pending) return res.redirect("/admin/approve-events");

    const newId = await insertEventFromPending(pending);
    await run("DELETE FROM pending_events WHERE id = ?", [id]);

    if (newId) return res.redirect(`/admin/create-events?edit=${newId}`);
    return res.redirect("/admin/approve-events");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

// Deny pending submission (delete)
router.post("/approve-events/:id/deny", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor")) return res.status(403).send("Forbidden");
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");
    await run("DELETE FROM pending_events WHERE id = ?", [id]);
    return res.redirect("/admin/approve-events");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

router.post("/events/:id/delete", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor")) {
      return res.status(403).send("Forbidden");
    }
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    await run("DELETE FROM events WHERE id = ?", [id]);

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const from = req.query.from ? String(req.query.from) : "";
    const to = req.query.to ? String(req.query.to) : "";
    const status = req.query.status ? String(req.query.status) : "upcoming";
    const recurring = req.query.recurring ? String(req.query.recurring) : "0";
    const sort = req.query.sort ? String(req.query.sort) : "datetime";

    const sp = new URLSearchParams({ pg, limit, status, sort });
    if (recurring === "1") sp.set("recurring", "1");
    if (q) sp.set("q", q);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);

    return res.redirect(`/admin/existing-events?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

// Soft-archive (best practice) — works with either (archived, archived_at, archived_reason)
// or legacy (isArchived, archivedAt) columns depending on what's present.
router.post("/events/:id/archive", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor")) {
      return res.status(403).send("Forbidden");
    }
    await ensureArchiveSchema();

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    const cols = await getEventsColumns();

    const colArchived = cols.has("archived") ? "archived" : (cols.has("isArchived") ? "isArchived" : null);
    const colArchivedAt = cols.has("archived_at") ? "archived_at" : (cols.has("archivedAt") ? "archivedAt" : null);
    const colReason = cols.has("archived_reason") ? "archived_reason" : (cols.has("archivedReason") ? "archivedReason" : null);

    const sets = [];
    const params = [];

    if (colArchived) sets.push(`${colArchived} = 1`);
    if (colArchivedAt) sets.push(`${colArchivedAt} = datetime('now')`);
    if (colReason) { sets.push(`${colReason} = ?`); params.push("manual"); }

    if (sets.length === 0) return res.status(400).send("Archive not supported by schema.");

    await run(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`, [...params, id]);

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const from = req.query.from ? String(req.query.from) : "";
    const to = req.query.to ? String(req.query.to) : "";
    const status = req.query.status ? String(req.query.status) : "upcoming";
    const recurring = req.query.recurring ? String(req.query.recurring) : "0";
    const sort = req.query.sort ? String(req.query.sort) : "datetime";

    const sp = new URLSearchParams({ pg, limit, status, sort });
    if (recurring === "1") sp.set("recurring", "1");
    if (q) sp.set("q", q);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);

    return res.redirect(`/admin/existing-events?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

router.post("/events/:id/unarchive", async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor")) {
      return res.status(403).send("Forbidden");
    }
    await ensureArchiveSchema();

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    const cols = await getEventsColumns();

    const colArchived = cols.has("archived") ? "archived" : (cols.has("isArchived") ? "isArchived" : null);
    const colArchivedAt = cols.has("archived_at") ? "archived_at" : (cols.has("archivedAt") ? "archivedAt" : null);
    const colReason = cols.has("archived_reason") ? "archived_reason" : (cols.has("archivedReason") ? "archivedReason" : null);

    const sets = [];
    if (colArchived) sets.push(`${colArchived} = 0`);
    if (colArchivedAt) sets.push(`${colArchivedAt} = NULL`);
    if (colReason) sets.push(`${colReason} = NULL`);

    if (sets.length === 0) return res.status(400).send("Unarchive not supported by schema.");

    await run(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`, [id]);

    const pg = req.query.pg ? String(req.query.pg) : "1";
    const limit = req.query.limit ? String(req.query.limit) : "20";
    const q = req.query.q ? String(req.query.q) : "";
    const from = req.query.from ? String(req.query.from) : "";
    const to = req.query.to ? String(req.query.to) : "";
    const status = req.query.status ? String(req.query.status) : "upcoming";
    const recurring = req.query.recurring ? String(req.query.recurring) : "0";
    const sort = req.query.sort ? String(req.query.sort) : "datetime";

    const sp = new URLSearchParams({ pg, limit, status, sort });
    if (recurring === "1") sp.set("recurring", "1");
    if (q) sp.set("q", q);
    if (from) sp.set("from", from);
    if (to) sp.set("to", to);

    return res.redirect(`/admin/existing-events?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

module.exports = router;
