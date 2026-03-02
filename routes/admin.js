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

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
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

// GET /admin
async function renderAdmin(req, res, view) {
  try {
    await ensurePickSchema();
    await ensureVenueSchema();
    // ✅ Pagination + total count + optional server-side search
const limit = Math.max(5, Math.min(200, parseInt(req.query.limit || "20", 10)));
const pg = Math.max(1, parseInt(req.query.pg || "1", 10));
const offset = (pg - 1) * limit;

const q = String(req.query.q || "").trim();
const sort = String(req.query.sort || "datetime"); // datetime | alpha | recent | id

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
    const monthlyByDay = rule.byDay ? String(rule.byDay) : "MO";
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
          <a class="btn btn-edit" href="/admin/create-events?edit=${e.id}&pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${statusMode ? `&status=${encodeURIComponent(statusMode)}` : ""}${recurringOnly ? `&recurring=1` : ""}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}">Edit</a>

          <form method="POST"
                action="/admin/events/${e.id}/delete?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${statusMode ? `&status=${encodeURIComponent(statusMode)}` : ""}${recurringOnly ? `&recurring=1` : ""}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}"
                class="inline"
                onsubmit="return confirm('Delete this event permanently? This cannot be undone.');">
            <button type="submit" class="btn btn-danger">Delete</button>
          </form>

          ${
            Number(e.isArchived || 0) === 1
              ? `
                <form method="POST"
                      action="/admin/events/${e.id}/unarchive?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${statusMode ? `&status=${encodeURIComponent(statusMode)}` : ""}${recurringOnly ? `&recurring=1` : ""}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}"
                      class="inline"
                      onsubmit="return confirm('Unarchive this event?');">
                  <button type="submit" class="btn">Unarchive</button>
                </form>
              `
              : `
                <form method="POST"
                      action="/admin/events/${e.id}/archive?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${statusMode ? `&status=${encodeURIComponent(statusMode)}` : ""}${recurringOnly ? `&recurring=1` : ""}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}"
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

    const fmt = (n) => Number(n || 0).toLocaleString("en-US");

    const diskInfo = getDiskInfo();
    const diskFree = diskInfo ? bytesToHuman(diskInfo.freeBytes) : "N/A";
    const diskTotal = diskInfo ? bytesToHuman(diskInfo.totalBytes) : "N/A";
    const dbSize = bytesToHuman(getDbSizeBytes());

const appVersion = String(process.env.APP_VERSION || "v0.0.4");
    const reqCount5m = Array.isArray(req.app?.locals?.reqTimes)
      ? req.app.locals.reqTimes.length
      : 0;
    const stats = {
      total: fmt(totalOccurrences || total),
      upcoming: fmt(upcoming),
      past: fmt(past),
      featured: fmt(featuredCount),
      views: fmt(viewsSum),
      upcomingViews: fmt(upcomingViews),
      pastViews: fmt(pastViews),
      serverTime: new Date().toISOString().replace("T", " ").slice(0, 19) + "Z",
      diskFree,
      diskTotal,
      appVersion,
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
    const showUsers = view === "users";
    const showInvites = view === "invites";

    if (showUsers && !isAdminUser) return res.status(403).send("Forbidden");
    if (showInvites && !isAdminUser) return res.status(403).send("Forbidden");
    if (showApprove && !(isAdminUser || isCityEditor)) return res.status(403).send("Forbidden");
    if (showCreate && !(isAdminUser || isCityEditor || isCityViewer)) return res.status(403).send("Forbidden");
    if (showVenueCreate && !(isAdminUser || isCityEditor || isCityViewer)) return res.status(403).send("Forbidden");
    if (showVenueExisting && !(isAdminUser || isCityEditor || isCityViewer)) return res.status(403).send("Forbidden");
    if (showVenueAnalytics && !(isAdminUser || isCityEditor)) return res.status(403).send("Forbidden");
    const showSearch = showAnalytics || showExisting || showVenueExisting;
    const isSingleManage = (showCreate ^ showExisting ^ showVenueCreate ^ showVenueExisting);

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

    let editVenue = null;
    if (showVenueCreate && req.query.edit) {
      const venueId = parseInt(String(req.query.edit), 10);
      if (!Number.isNaN(venueId)) {
        editVenue = await get("SELECT * FROM venues WHERE id = ?", [venueId]);
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
      : showUsers
      ? "Users"
      : showInvites
      ? "Invites"
      : "Dashboard";
    const pageTitle = `OpenCircle | ${pageTitleBase}`;

    res.send(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link rel="icon" href="/assets/brand/favicon.ico" />
    <title>${pageTitle}</title>
    <style>
      :root{
        /* Main (light, WordPress-like) */
        --bg:#eef2f6;
        --panel:#ffffff;
        --panel2:#f8fafc;
        --text:#0f172a;
        --muted:#475569;
        --line:rgba(15,23,42,.12);
        --brand:#00c08b;
        --brand2:#0ea5e9;
        --danger:#ef4444;
        --shadow:none;
        --radius:8px;
        --radius-inner:6px;
        --radius2:8px;
        --event-side-h: 140px;
        --ctrl-h: 44px;
        --gap:22px;

        /* Sidebar (dark) */
        --sidebar-bg:#0b1220;
        --sidebar-panel:#0f172a;
        --sidebar-text:#e5e7eb;
        --sidebar-muted:#475569;
        --sidebar-line:rgba(148,163,184,.16);
      }

      *{ box-sizing:border-box; }
      body{
        margin:0;
        background:var(--bg);
        color:var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial;
      }

      /* Layout */
      .app{ display:flex; min-height:100vh; }

      .sidebar{
        width:220px;
        background:var(--sidebar-panel);
        border-right:1px solid var(--sidebar-line);
        padding:5px 18px 18px;
        position:sticky; top:0; height:100vh; overflow:auto;
        display:flex; flex-direction:column;
        color:var(--sidebar-text);
      }
      .sidebar .card{
        background: rgba(255,255,255,.04);
        border-color: var(--sidebar-line);
        color: var(--sidebar-text);
        box-shadow:none;
      }
      .sidebar .card .muted{ color: var(--sidebar-muted); }
      .sb-brand{
        display:flex; align-items:center; justify-content:flex-start; margin-bottom:24px;
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
        margin: 10px -18px;
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
        box-shadow: 0 16px 40px rgba(2,6,23,.45);
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
        gap:8px;
        margin:10px -18px 0;
        width:calc(100% + 36px);
      }
      .nav-group{
        display:grid;
        gap:6px;
      }
      .nav-title{
        color: var(--sidebar-muted);
        font-size:12px;
        font-weight:700;
        letter-spacing:.08em;
        text-transform:uppercase;
        padding:6px 18px 2px;
      }
      .subnav-link{
        text-decoration:none;
        color:#ffffff !important;
        display:flex;
        align-items:center;
        padding:8px 18px;
        font-weight:300;
        font-size:14px;
        border-left:2px solid transparent;
      }
      .subnav-link:hover{
        color:#ffffff;
        background: rgba(255,255,255,.04);
      }
      .subnav-link.active{
        color:#ffffff !important;
        background: rgba(0,192,139,.10);
        border-left-color: var(--brand);
      }
      .subnav-link:visited,
      .subnav-link:focus,
      .subnav-link:active{
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
      .nav a.active .n-dot{ background: var(--brand); }

      .main{
        flex:1;
        padding:22px;
        min-width:0;
      }

      /* Header */
      .header{
        display:flex; align-items:center; justify-content:space-between; gap:14px;
        margin-bottom:var(--gap);
      }
      .h-left h1{ margin:0; font-size:22px; letter-spacing:.2px; font-weight:600; }
      .h-left p{ margin:6px 0 0; color:var(--muted); font-size:13px; }
      .h-right{ display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
      .h-right{ flex:1; justify-content:flex-end; }

      .search{
        display:flex; align-items:center; gap:10px;
        background:var(--panel);
        border:1px solid var(--line);
        border-radius: var(--radius-inner);
        padding: 10px 12px;
        box-shadow: var(--shadow);
        width:100%;
        max-width:700px;
      }
      .search input{
        border:0; outline:none; background:transparent;
        width:auto;
        min-width:0;
        flex:1 1 auto;
        font-size:14px; font-weight:500; color:var(--text);
        height: var(--ctrl-h);
      }

      /* Cards + widgets */
      .card{
        background:var(--panel);
        border:1px solid var(--line);
        border-radius: var(--radius);
        box-shadow: var(--shadow);
        padding: 16px;
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
        padding:14px;
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

      h2{ margin:0 0 10px; font-size:16px; font-weight:600; }
      .sub{ margin:0; color:var(--muted); font-size:13px; }

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
        background: var(--panel2);
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
        background: var(--panel);
        cursor:pointer;
        font-weight:600;
        text-decoration:none;
        color: var(--text);
        font-size:14px;
        line-height:1;
        height: var(--ctrl-h);
      }
      .btn:hover{ transform: translateY(-1px); }
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

      a:not(.btn){ color: var(--brand2); text-decoration:none; font-weight:600; font-size:14px; }
      a:not(.btn):hover{ text-decoration:underline; }
      .event-actions a:not(.btn){ font-size:14px; }

      /* Small widgets */
      .mini{
        border: 1px solid var(--line);
        background: var(--panel2);
        border-radius: var(--radius-inner);
        padding: 12px;
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
        padding: 12px;
        background: var(--panel);
        display:flex;
        justify-content:space-between;
        gap:14px;
        align-items:center;
      }
      .event-left{ flex: 1; min-width: 0; display:flex; flex-direction:column; height: var(--event-side-h); justify-content:space-between; }
      .event-main{ min-width:0; }
      .event-title{ font-weight:650; margin-bottom:6px; }
      .event-meta{ color: var(--muted); font-size: 13px; display:grid; gap:2px; }
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
      .stat{ display:flex; justify-content:space-between; align-items:center; font-size: 13px; color: var(--muted); margin: 6px 0; }
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
      .listSearchRow{
        display:grid;
        grid-template-columns: 1fr auto auto;
        gap:12px;
        align-items:center;
        margin: 10px 0 14px;
      }
      .listSearchRow #eventSearch{ flex: 1 1 auto; min-width: 280px; }
      .listSearchRow .btn{ min-width:140px; }
      @media (max-width: 900px){
        .listSearchRow{ flex-wrap: wrap; }
        .listSearchRow #eventSearch{ flex: 1 1 100%; min-width: 0; }
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
        margin-bottom:10px;
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
        padding: 4px 0 12px;
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
          <div class="nav-group">
            <div class="nav-title">Dashboard</div>
            <a class="subnav-link ${showDashboard ? "active" : ""}" href="/admin${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Overview</a>
          </div>
          <div class="sb-divider"></div>
          ` : ``}
          <div class="nav-group">
            <div class="nav-title">Events</div>
            <a class="subnav-link ${showExisting ? "active" : ""}" href="/admin/existing-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Events</a>
            ${(isCityViewer || isCityEditor || isAdminUser) ? `<a class="subnav-link ${showCreate ? "active" : ""}" href="/admin/create-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Events</a>` : ``}
            ${(isAdminUser || isCityEditor) ? `
            <a class="subnav-link ${showApprove ? "active" : ""}" href="/admin/approve-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" style="display:flex; align-items:center; gap:8px;">
              <span>Approve Events</span>
              ${pendingCount > 0 ? `<span class="badge badge--nav">${pendingCount}</span>` : ``}
            </a>` : ``}
            ${(isAdminUser || isCityEditor) ? `<a class="subnav-link ${showAnalytics ? "active" : ""}" href="/admin/events-analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Analytics</a>` : ``}
          </div>
          <div class="sb-divider"></div>
          <div class="nav-group" style="margin-top:16px;">
            <div class="nav-title">Venues</div>
            ${(isCityViewer || isCityEditor || isAdminUser) ? `<a class="subnav-link ${showVenueExisting ? "active" : ""}" href="/admin/venues${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Venues</a>` : ``}
            ${(isCityViewer || isCityEditor || isAdminUser) ? `<a class="subnav-link ${showVenueCreate ? "active" : ""}" href="/admin/venues/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Venues</a>` : ``}
            ${(isAdminUser || isCityEditor) ? `<a class="subnav-link ${showVenueAnalytics ? "active" : ""}" href="/admin/venues/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Analytics</a>` : ``}
          </div>
          ${isAdminUser ? `<div class="sb-divider"></div>
          <div class="nav-group" style="margin-top:16px;">
            <div class="nav-title">Admin</div>
            <a class="subnav-link ${showUsers ? "active" : ""}" href="/admin/users">Users</a>
            <a class="subnav-link ${showInvites ? "active" : ""}" href="/admin/invites">Invites</a>
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
                : "Combined events/venues overview with quick actions"
            }</p>
          </div>

          <div class="h-right">
            ${showSearch ? `
            <form class="search" method="GET" action="${showVenueExisting ? "/admin/venues" : (showAnalytics ? "/admin/events-analytics" : "/admin/existing-events")}">
              <input name="q" value="${esc(q)}" placeholder="${showVenueExisting ? "Search venues (name, slug, address, ID)..." : "Search events (title, slug, location, ID)..."}" />
              <input type="hidden" name="pg" value="1" />
              <input type="hidden" name="limit" value="${esc(String(limit))}" />
              ${showVenueExisting ? `` : `<input type="hidden" name="status" value="${esc(String(statusMode))}" />`}
              ${showVenueExisting ? `` : (recurringOnly ? `<input type="hidden" name="recurring" value="1" />` : ``)}
              <button class="btn btn-primary" type="submit">Search</button>
              ${q ? (showVenueExisting
                ? `<a class="btn" href="/admin/venues?pg=1&limit=${esc(String(limit))}">Reset</a>`
                : (showAnalytics
                  ? `<a class="btn" href="/admin/events-analytics?pg=1&limit=${esc(String(limit))}&status=${esc(String(statusMode))}${recurringOnly ? `&recurring=1` : ``}">Reset</a>`
                  : `<a class="btn" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}&status=${esc(String(statusMode))}${recurringOnly ? `&recurring=1` : ``}">Reset</a>`)) : ``}
            </form>
            ` : ``}
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
            <section class="card dashboard-card" id="dashboard-quick-links">
              <div class="sectionTitle">
                <div>
                  <h2>Quick links</h2>
                  <p class="sub">Most common admin tasks</p>
                </div>
              </div>
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
              </div>
            </section>

            <div class="card dashboard-card">
              <div class="sectionTitle">
                <div>
                  <h2>Release notes</h2>
                  <p class="sub">Latest platform updates</p>
                </div>
              </div>
              <div class="mini">
                <div style="font-weight:650; margin-bottom:8px;">Release notes</div>
                <div class="release-meta">
                  <div class="release-row"><div class="label">App version</div><div class="value">${esc(stats.appVersion)}</div></div>
                  <div class="release-row"><div class="label">Latest updates</div><div class="value">Venues module, categories, social, hours, SEO, image upload</div></div>
                  <div class="release-row"><div class="label">Updated at</div><div class="value">${esc(stats.serverTime)}</div></div>
                </div>
              </div>
            </div>
          </div>

          <div class="dashboard-col dashboard-col-fill dashboard-insights">
            <div class="card dashboard-card">
              <div class="sectionTitle">
                <div>
                  <h2>Event insights</h2>
                  <p class="sub">Events snapshot</p>
                </div>
              </div>
              <div class="insight-list">
                <div class="insight-row"><div class="label">Events</div><div class="value">${esc(stats.total)}</div></div>
                <div class="insight-row"><div class="label">Upcoming</div><div class="value">${esc(stats.upcoming)}</div></div>
                <div class="insight-row"><div class="label">Featured</div><div class="value">${esc(stats.featured)}</div></div>
                <div class="insight-row"><div class="label">Views</div><div class="value">${esc(stats.views)}</div></div>
              </div>
            </div>

            <div class="card dashboard-card">
              <div class="sectionTitle">
                <div>
                  <h2>Venue insights</h2>
                  <p class="sub">Venues snapshot</p>
                </div>
              </div>
              <div class="insight-list">
                <div class="insight-row"><div class="label">Venues</div><div class="value">${esc(venueStats.total)}</div></div>
                <div class="insight-row"><div class="label">Views</div><div class="value">${esc(venueStats.views)}</div></div>
                <div class="insight-row"><div class="label">Total Link Clicks</div><div class="value">${esc(venueStats.totalClicks)}</div></div>
                <div class="insight-row"><div class="label">With Website</div><div class="value">${esc(venueStats.withWebsite)} (${esc(venueStats.withWebsitePct)})</div></div>
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
              <canvas id="eventsChart" style="width:100%; height:260px; display:block;"></canvas>
                <div id="eventsChartTip" style="position:absolute; display:none; pointer-events:none; padding:6px 8px; border-radius:10px; border:1px solid rgba(148,163,184,.35); background:rgba(255,255,255,.98); color:rgba(15,23,42,.95); font-size:12px; line-height:1.2; box-shadow:0 8px 20px rgba(15,23,42,.12);"></div>
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

              <div class="rec-box" style="margin-top:0;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px;">
                  <div style="display:flex; align-items:center; gap:10px;">
                    <label style="margin:0; font-weight:650;">Paste Event Extraction JSON (optional)</label>
                    <span id="jsonBadge" class="json-badge">JSON detected</span>
                  </div>
                  <button type="button" class="btn" onclick="(function(){var t=document.getElementById('rawJson'); if(t) t.value=''; var b=document.getElementById('jsonBadge'); if(b) b.classList.remove('on');})()">Clear JSON</button>
                </div>
                <textarea class="ctrl" id="rawJson" name="rawJson" placeholder="Paste the JSON output from ChatGPT here…" style="min-height:140px; margin-top:8px;"></textarea>
                <div class="note">If provided, the server will parse and auto-fill fields. You can still edit fields below before saving.</div>
              </div>

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
                        <div class="rec-label">Weekday</div>
                        <select name="monthlyByDay" class="ctrl">
                          <option value="SU" ${monthlyByDay === "SU" ? "selected" : ""}>Sunday</option>
                          <option value="MO" ${monthlyByDay === "MO" ? "selected" : ""}>Monday</option>
                          <option value="TU" ${monthlyByDay === "TU" ? "selected" : ""}>Tuesday</option>
                          <option value="WE" ${monthlyByDay === "WE" ? "selected" : ""}>Wednesday</option>
                          <option value="TH" ${monthlyByDay === "TH" ? "selected" : ""}>Thursday</option>
                          <option value="FR" ${monthlyByDay === "FR" ? "selected" : ""}>Friday</option>
                          <option value="SA" ${monthlyByDay === "SA" ? "selected" : ""}>Saturday</option>
                        </select>
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
                ${editEvent ? `<a class="btn btn-link" href="/admin/existing-events?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${statusMode ? `&status=${encodeURIComponent(statusMode)}` : ""}${recurringOnly ? `&recurring=1` : ""}">Cancel</a>` : ""}
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
              <div class="right">
                <div class="rightRow">
                  <a class="btn ${statusMode === "upcoming" ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}&sort=${encodeURIComponent(sort)}&status=upcoming${recurringOnly ? `&recurring=1` : ``}">Upcoming</a>
                  <a class="btn ${statusMode === "past" ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}&sort=${encodeURIComponent(sort)}&status=past${recurringOnly ? `&recurring=1` : ``}">Past</a>
                  <a class="btn ${statusMode === "archived" ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}&sort=${encodeURIComponent(sort)}&status=archived${recurringOnly ? `&recurring=1` : ``}">Archived</a>
                  <a class="btn ${recurringOnly ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}&sort=${encodeURIComponent(sort)}&status=${encodeURIComponent(statusMode)}${recurringOnly ? `` : `&recurring=1`}">${recurringOnly ? "Recurring: On" : "Recurring Only"}</a>

                  <select id="sortBy" class="ctrl sortBy">
                    <option value="datetime" ${sort === "datetime" ? "selected" : ""}>Sort: Event date/time</option>
                    <option value="alpha" ${sort === "alpha" ? "selected" : ""}>Sort: Alphabetical (A–Z)</option>
                    <option value="recent" ${sort === "recent" ? "selected" : ""}>Sort: Recently added</option>
                    <option value="id" ${sort === "id" ? "selected" : ""}>Sort: ID (newest)</option>
                  </select></div>
              </div>
            </div>

            <div class="listSearchRow">
              <input id="eventSearch" class="ctrl" type="text" placeholder="Filter all events..." value="${esc(q)}" />
              <button id="eventSearchApply" type="button" class="btn btn-primary">Apply</button>
              <button id="eventSearchClear" type="button" class="btn">Clear</button>
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
            <div class="kpis">
              <div class="kpi"><div class="label">Total Venues</div><div class="value">${esc(venueStats.total)}</div></div>
              <div class="kpi"><div class="label">Cities</div><div class="value">${venueByCity.length}</div></div>
              <div class="kpi"><div class="label">Venue Views</div><div class="value">${esc(venueStats.views)}</div></div>
              <div class="kpi"><div class="label">Total Link Clicks</div><div class="value">${esc(venueStats.totalClicks)}</div></div>
              <div class="kpi"><div class="label">Avg Views / Venue</div><div class="value">${esc(venueStats.avgViewsPerVenue)}</div></div>
              <div class="kpi"><div class="label">Avg Clicks / Venue</div><div class="value">${esc(venueStats.avgClicksPerVenue)}</div></div>
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

            <div class="venue-analytics-grid2" style="margin-top:14px;">
              <div class="card">
                <div class="sectionTitle">
                  <div>
                    <h2>Data completeness</h2>
                    <p class="sub">Coverage for key venue fields</p>
                  </div>
                </div>
                <div class="mini">
                  <div class="kv"><span class="k">With Website</span><strong class="v">${esc(venueStats.withWebsite)} (${esc(venueStats.withWebsitePct)})</strong></div>
                  <div class="kv"><span class="k">With Image</span><strong class="v">${esc(venueStats.withImage)} (${esc(venueStats.withImagePct)})</strong></div>
                  <div class="kv"><span class="k">With Gallery</span><strong class="v">${esc(venueStats.withGallery)} (${esc(venueStats.withGalleryPct)})</strong></div>
                  <div class="kv"><span class="k">With Social</span><strong class="v">${esc(venueStats.withSocial)} (${esc(venueStats.withSocialPct)})</strong></div>
                  <div class="kv"><span class="k">With Hours</span><strong class="v">${esc(venueStats.withHours)} (${esc(venueStats.withHoursPct)})</strong></div>
                </div>
              </div>

              <div class="card">
                <div class="sectionTitle">
                  <div>
                    <h2>City breakdown</h2>
                    <p class="sub">Venue count by city</p>
                  </div>
                </div>
                <div class="mini">
                  ${venueByCity.length ? venueByCity.map((r) => `
                    <div class="kv">
                      <span class="k">${esc(r.city || "Unknown")}</span>
                      <strong class="v">${Number(r.n || 0).toLocaleString("en-US")}</strong>
                    </div>
                  `).join("") : `<div class="muted">No venue analytics yet.</div>`}
                </div>
              </div>
            </div>

            <div class="grid4" style="margin-top:14px;">
              <div class="metric"><div><div class="k">Phone clicks</div><div class="v">${esc(venueStats.phoneClicks)}</div></div></div>
              <div class="metric"><div><div class="k">Website clicks</div><div class="v">${esc(venueStats.websiteClicks)}</div></div></div>
              <div class="metric"><div><div class="k">Social clicks</div><div class="v">${esc(venueStats.socialClicks)}</div></div></div>
              <div class="metric"><div><div class="k">Total clicks</div><div class="v">${esc(venueStats.totalClicks)}</div></div></div>
            </div>
          </div>
          ` : ``}
        </section>
        ` : ``}

      </main>
    </div>

    <script>
      // ---- helpers ----
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
        var rawJsonEl = document.getElementById("rawJson");
        var jsonBadge = document.getElementById("jsonBadge");
        var allowedCategories = ${JSON.stringify(ALLOWED_CATEGORIES)};

        function extractPlainUrl(str){
          var s = String(str || "").trim();
          if (!s) return "";
          var paren = s.match(/\\((https?:\\/\\/[^)]+)\\)/i);
          if (paren && paren[1]) return paren[1];
          var raw = s.match(/https?:\\/\\/[^\\s)]+/i);
          return raw ? raw[0] : "";
        }

        function mapCategories(list){
          var map = {
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
          var out = [];
          (Array.isArray(list) ? list : []).forEach(function(x){
            var key = String(x || "").trim().toLowerCase();
            if (!key) return;
            var mapped = map[key] || x;
            if (allowedCategories.indexOf(mapped) !== -1) out.push(mapped);
          });
          return out.slice(0,3);
        }

        function mapLocation(j){
          var v = String(j.venue_name || "").trim();
          if (v) return v;
          var l = String(j.location_name || "").trim();
          if (l) return l;
          var parts = [];
          if (j.address_line1) parts.push(String(j.address_line1).trim());
          var city = String(j.city || "").trim();
          var state = String(j.state || "").trim();
          var zip = String(j.postal_code || "").trim();
          var cityLine = "";
          if (city) cityLine += city;
          if (state) cityLine += (cityLine ? ", " : "") + state;
          if (zip) cityLine += (cityLine ? " " : "") + zip;
          if (cityLine) parts.push(cityLine);
          return parts.join(", ");
        }

        function setVal(sel, val, force){
          var el = form.querySelector(sel);
          if (!el || val === undefined || val === null || val === "") return;
          if (!force && String(el.value || "").trim()) return;
          el.value = String(val);
        }

        function applyJson(j){
          if (!j || typeof j !== "object") return;
          setVal('input[name="title"]', j.title, true);
          setVal('textarea[name="description"]', j.description_html || j.description, true);
          setVal('textarea[name="eventDetails"]', j.event_details_html || j.event_details, true);
          setVal('textarea[name="goodToKnow"]', j.good_to_know_html || j.good_to_know, true);
          setVal('input[name="location"]', mapLocation(j), true);
          setVal('input[name="organizer"]', j.organizer_name, true);

          var ticket = extractPlainUrl(j.ticket_url || j.event_url || "");
          setVal('input[name="ticketUrl"]', ticket, true);
          setVal('input[name="eventLink"]', extractPlainUrl(j.event_url || "") || j.event_url, true);

          if (j.seo && typeof j.seo === "object") {
            setVal('input[name="seoTitle"]', j.seo.seo_title, true);
            setVal('textarea[name="metaDescription"]', j.seo.meta_description, true);
            setVal('input[name="focusKeyphrase"]', j.seo.focus_keyphrase, true);
          }
          if (j.image && typeof j.image === "object") {
            setVal('input[name="imageAlt"]', j.image.alt_text, true);
          }

          var cats = mapCategories(j.categories);
          if (cats.length) {
            var selects = form.querySelectorAll('select[name="categories"]');
            for (var i=0;i<selects.length;i++){
              if (cats[i]) selects[i].value = cats[i];
            }
          }

          var startIso = String(j.start_datetime || j.start_date_time || j.startDateTime || "");
          var endIso = String(j.end_datetime || j.end_date_time || j.endDateTime || "");
          if (startIso) {
            setVal('#startDateTimeISO', startIso, true);
            setVal('#startDateTime', startIso.slice(0,16), true);
          }
          if (endIso) {
            setVal('#endDateTimeISO', endIso, true);
            setVal('#endDateTime', endIso.slice(0,16), true);
          }

          // Recurring occurrences -> custom dates
          if (Array.isArray(j.occurrences) && j.occurrences.length) {
            var hasRecEl = document.getElementById("hasRecurrence");
            var typeEl = document.getElementById("recurrenceType");
            var customBox = document.getElementById("customBox");
            var wrap = document.getElementById("customDatesWrap");
            var addBtn = document.getElementById("addCustomDate");

            if (hasRecEl) hasRecEl.checked = true;
            if (typeEl) typeEl.value = "custom";
            if (typeEl) typeEl.dispatchEvent(new Event("change"));
            if (hasRecEl) hasRecEl.dispatchEvent(new Event("change"));
            if (customBox) customBox.style.display = "";

            function makeChip(dateStr, startTime, endTime){
              if (!wrap) return;
              var chip = document.createElement("span");
              chip.className = "chip";
              chip.innerHTML =
                '<input class="ctrl" style="width:160px; padding:8px 10px;" type="date" name="customDate" value="' + dateStr + '" />' +
                '<input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customStart" value="' + startTime + '" />' +
                '<input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customEnd" value="' + endTime + '" />' +
                '<button type="button" data-remove-date="1" aria-label="Remove">×</button>';
              wrap.appendChild(chip);
            }

            if (wrap) wrap.innerHTML = "";
            j.occurrences.forEach(function(o){
              var s = String(o.start_datetime || o.startDateTime || "");
              var e = String(o.end_datetime || o.endDateTime || "");
              if (!s) return;
              var dateStr = s.slice(0,10);
              var st = s.slice(11,16);
              var en = e ? e.slice(11,16) : st;
              makeChip(dateStr, st, en);
            });

            // wire remove buttons
            if (wrap) {
              var btns = wrap.querySelectorAll("button[data-remove-date]");
              for (var i=0;i<btns.length;i++){
                btns[i].onclick = function(){
                  var chip = this.closest(".chip");
                  if(chip) chip.remove();
                };
              }
            }
          }
        }

        function syncNoValidate(){
          if (!rawJsonEl) return;
          var hasJson = String(rawJsonEl.value || "").trim().length > 0;
          if (hasJson) form.setAttribute("novalidate", "novalidate");
          else form.removeAttribute("novalidate");
          if (jsonBadge) jsonBadge.classList.toggle("on", hasJson);
        }
        if (rawJsonEl) {
          rawJsonEl.addEventListener("input", function(){
            syncNoValidate();
            try { applyJson(JSON.parse(rawJsonEl.value || "{}")); } catch (_) {}
          });
          rawJsonEl.addEventListener("change", function(){
            syncNoValidate();
            try { applyJson(JSON.parse(rawJsonEl.value || "{}")); } catch (_) {}
          });
          syncNoValidate();
        }

        form.addEventListener("submit", function(){
          if (rawJsonEl && String(rawJsonEl.value || "").trim()) {
            form.setAttribute("novalidate", "novalidate");
          }
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
        var applyBtn = document.getElementById('eventSearchApply');
        var clearBtn = document.getElementById('eventSearchClear');
        if(!input) return;

        function go(){
          try {
            sessionStorage.setItem("oc_admin_scroll", String(window.scrollY || 0));
          } catch (_) {}
          var q = String(input.value || '').trim();
          var sp = new URLSearchParams(window.location.search || '');
          if (q) sp.set('q', q); else sp.delete('q');
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
    const chartSets = ${chartDataJson};
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

  initEventsChart();
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

router.post("/events", upload.single("imageFile"), async (req, res) => {
  try {
    const role = req.user?.role || "creator";
    if (!(role === "admin" || role === "editor" || role === "creator")) {
      return res.status(403).send("Forbidden");
    }
    await ensurePickSchema();

    const rawJson = String(req.body?.rawJson || "").trim();
    if (rawJson) {
      let parsed = null;
      try {
        parsed = JSON.parse(rawJson);
      } catch (e) {
        return res.status(400).send("Invalid JSON in Paste Event Extraction JSON box.");
      }
      const j = parsed && typeof parsed === "object" ? parsed : null;
      if (j) {
        req.body.title = req.body.title || j.title || "";
        req.body.description = req.body.description || j.description_html || "";
        req.body.eventDetails = req.body.eventDetails || j.event_details_html || j.event_details || "";
        req.body.goodToKnow = req.body.goodToKnow || j.good_to_know_html || "";

        if (j.seo && typeof j.seo === "object") {
          if (!req.body.seoTitle && j.seo.seo_title) req.body.seoTitle = String(j.seo.seo_title);
          if (!req.body.metaDescription && j.seo.meta_description) req.body.metaDescription = stripHtml(j.seo.meta_description);
          if (!req.body.focusKeyphrase && j.seo.focus_keyphrase) req.body.focusKeyphrase = String(j.seo.focus_keyphrase);
          if (!req.body.slug && j.seo.slug) req.body.slug = String(j.seo.slug);
        }
        if (j.image && typeof j.image === "object") {
          if (!req.body.imageAlt && j.image.alt_text) req.body.imageAlt = String(j.image.alt_text);
        }

        const loc = req.body.location || mapLocationFromJson(j) || "";
        if (loc) req.body.location = loc;

        req.body.organizer = req.body.organizer || j.organizer_name || "";

        const ticket = extractPlainUrl(j.ticket_url || j.event_url || "");
        if (!req.body.ticketUrl && ticket) req.body.ticketUrl = ticket;
        const eventUrl = extractPlainUrl(j.event_url || "") || String(j.event_url || "").trim();
        if (!req.body.eventLink && eventUrl) req.body.eventLink = eventUrl;

        if (!req.body.categories && Array.isArray(j.categories)) {
          req.body.categories = j.categories;
        }

        req.body.startDateTimeISO = req.body.startDateTimeISO || j.start_datetime || j.start_date_time || j.startDateTime || "";
        req.body.endDateTimeISO = req.body.endDateTimeISO || j.end_datetime || j.end_date_time || j.endDateTime || "";
        if (req.body.startDateTimeISO && !req.body.startDateTime) {
          req.body.startDateTime = String(req.body.startDateTimeISO).slice(0, 16);
        }
        if (req.body.endDateTimeISO && !req.body.endDateTime) {
          req.body.endDateTime = String(req.body.endDateTimeISO).slice(0, 16);
        }
      }
    }

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
          const sp = parseInt(setPos || "1", 10);
          const wd = String(monthlyByDay || "").trim() || "MO";
          recurrenceRule = { type: "monthly", interval, mode: "nthweekday", setPos: sp, byDay: wd };
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

const status = req.query.status ? String(req.query.status) : "upcoming";
const recurring = req.query.recurring ? String(req.query.recurring) : "0";

const sp = new URLSearchParams({ edit: String(id), pg, limit, status });
if (recurring === "1") sp.set("recurring", "1");
if (q) sp.set("q", q);

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

const status = req.query.status ? String(req.query.status) : "upcoming";
const recurring = req.query.recurring ? String(req.query.recurring) : "0";

const sp = new URLSearchParams({ pg, limit, status });
if (recurring === "1") sp.set("recurring", "1");
if (q) sp.set("q", q);

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
    const status = req.query.status ? String(req.query.status) : "upcoming";
    const recurring = req.query.recurring ? String(req.query.recurring) : "0";
    const sort = req.query.sort ? String(req.query.sort) : "datetime";

    const sp = new URLSearchParams({ pg, limit, status, sort });
    if (recurring === "1") sp.set("recurring", "1");
    if (q) sp.set("q", q);

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
    const status = req.query.status ? String(req.query.status) : "upcoming";
    const recurring = req.query.recurring ? String(req.query.recurring) : "0";
    const sort = req.query.sort ? String(req.query.sort) : "datetime";

    const sp = new URLSearchParams({ pg, limit, status, sort });
    if (recurring === "1") sp.set("recurring", "1");
    if (q) sp.set("q", q);

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
    const status = req.query.status ? String(req.query.status) : "upcoming";
    const recurring = req.query.recurring ? String(req.query.recurring) : "0";
    const sort = req.query.sort ? String(req.query.sort) : "datetime";

    const sp = new URLSearchParams({ pg, limit, status, sort });
    if (recurring === "1") sp.set("recurring", "1");
    if (q) sp.set("q", q);

    return res.redirect(`/admin/existing-events?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Server error.");
  }
});

module.exports = router;
