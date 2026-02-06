"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");

const { initDB, archiveExpiredEvents, run, all, get, slugify, ensureUniqueSlug } = require("./db");

const eventsRouter = require("./routes/events");
const adminRouter = require("./routes/admin");

const app = express();
app.locals.reqTimes = [];

// If behind Render proxy, this helps req.protocol be correct
app.set("trust proxy", 1);

// --------------------
// KCLS RSS Import (Enumclaw Library)
// --------------------
const KCLS_RSS_URL =
  process.env.KCLS_RSS_URL ||
  "https://gateway.bibliocommons.com/v2/libraries/kcls/rss/events?locations=BC_VIRTUAL%2C119&startDate=2026-02-05";

const KCLS_DEFAULT_CITY = process.env.KCLS_RSS_CITY || "Enumclaw";
const KCLS_DEFAULT_LOCATION = process.env.KCLS_RSS_LOCATION || "1700 1st Street";
const KCLS_DEFAULT_ORGANIZER = process.env.KCLS_RSS_ORGANIZER || "Enumclaw Library";
const KCLS_TZ = process.env.EVENTS_TZ || "America/Los_Angeles";

let _sourceSchemaEnsured = false;
async function ensureSourceSchema() {
  if (_sourceSchemaEnsured) return;
  try {
    const cols = await all("PRAGMA table_info(events)");
    const names = new Set((cols || []).map((r) => String(r.name)));
    if (!names.has("sourceKey")) {
      await run("ALTER TABLE events ADD COLUMN sourceKey TEXT");
    }
    if (!names.has("sourceUrl")) {
      await run("ALTER TABLE events ADD COLUMN sourceUrl TEXT");
    }
    _sourceSchemaEnsured = true;
  } catch (e) {
    console.error("[KCLS] Failed to ensure source schema:", e);
  }
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]*>/g, "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function readTag(xml, tag) {
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i");
  const m = String(xml || "").match(re);
  if (!m) return "";
  let v = m[1] || "";
  v = v.replace(/<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>/gi, "$1");
  return v.trim();
}

function parseWhenFromText(text) {
  const t = String(text || "");
  const re =
    /When:\s*(?:[A-Za-z]+,\s*)?([A-Za-z]+ \d{1,2}, \d{4})[, ]+(\d{1,2}:\d{2}\s*[ap]m)(?:\s*[–-]\s*(\d{1,2}:\d{2}\s*[ap]m))?/i;
  const m = t.match(re);
  if (!m) return null;
  const dateStr = m[1];
  const startStr = m[2];
  const endStr = m[3] || "";
  return { dateStr, startStr, endStr };
}

function toIsoWithTz(dateStr, timeStr) {
  const { DateTime } = require("luxon");
  const fmtList = [
    "LLLL d, yyyy h:mma",
    "LLLL d, yyyy h:mm a",
    "LLL d, yyyy h:mma",
    "LLL d, yyyy h:mm a",
  ];
  for (const fmt of fmtList) {
    const dt = DateTime.fromFormat(`${dateStr} ${timeStr}`, fmt, { zone: KCLS_TZ });
    if (dt.isValid) return dt.toISO();
  }
  return null;
}

function parseOrganizerFromText(text) {
  const t = String(text || "");
  const m = t.match(/(?:Presenter|Organizer|Hosted by|Presented by):\s*([^\n]+)/i);
  return m ? String(m[1]).trim() : "";
}

function parseLocationFromText(text) {
  const t = String(text || "");
  const m = t.match(/Location:\s*([^\n]+)/i);
  return m ? String(m[1]).trim() : "";
}

async function importKclsRssDaily() {
  await ensureSourceSchema();
  const { DateTime } = require("luxon");
  const colsRows = await all("PRAGMA table_info(events)");
  const colsSet = new Set((colsRows || []).map((r) => String(r.name)));

  let fetchUrl = KCLS_RSS_URL;
  try {
    const u = new URL(KCLS_RSS_URL);
    u.searchParams.set("startDate", DateTime.now().toISODate());
    fetchUrl = u.toString();
  } catch (_) {}

  let xml = "";
  try {
    const resp = await fetch(fetchUrl, { headers: { Accept: "application/rss+xml, application/xml, text/xml" } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    xml = await resp.text();
  } catch (e) {
    console.error("[KCLS] RSS fetch failed:", e);
    return;
  }

  const items = String(xml).split(/<item\b[^>]*>/i).slice(1).map((s) => s.split(/<\/item>/i)[0]);
  if (!items.length) {
    console.warn("[KCLS] RSS had no items");
    return;
  }

  const groups = new Map();

  for (const raw of items) {
    const title = readTag(raw, "title");
    const link = readTag(raw, "link") || readTag(raw, "guid");
    const desc = readTag(raw, "description");
    const pubDate = readTag(raw, "pubDate");

    const plain = stripHtml(desc);
    const when = parseWhenFromText(plain);

    let startISO = null;
    let endISO = null;

    if (when) {
      startISO = toIsoWithTz(when.dateStr, when.startStr);
      if (when.endStr) endISO = toIsoWithTz(when.dateStr, when.endStr);
    }

    if (!startISO && pubDate) {
      const dt = DateTime.fromRFC2822(pubDate, { zone: KCLS_TZ });
      if (dt.isValid) startISO = dt.toISO();
    }

    if (!startISO) continue;

    if (!endISO) {
      const dt = DateTime.fromISO(startISO).plus({ hours: 1 });
      endISO = dt.isValid ? dt.toISO() : startISO;
    }

    const organizer = parseOrganizerFromText(plain) || KCLS_DEFAULT_ORGANIZER;
    const location = parseLocationFromText(plain) || KCLS_DEFAULT_LOCATION;

    const key = [
      String(title || "").trim().toLowerCase(),
      String(location || "").trim().toLowerCase(),
      String(organizer || "").trim().toLowerCase(),
    ].join("|");

    if (!groups.has(key)) {
      groups.set(key, {
        title,
        description: plain,
        organizer,
        location,
        city: KCLS_DEFAULT_CITY,
        sourceUrl: link,
        occurrences: [],
      });
    }

    const g = groups.get(key);
    g.occurrences.push({ start: startISO, end: endISO });
  }

  for (const [key, g] of groups.entries()) {
    const occs = g.occurrences
      .filter((o) => o.start)
      .sort((a, b) => String(a.start).localeCompare(String(b.start)));

    if (!occs.length) continue;

    const startDateTime = occs[0].start;
    const endDateTime = occs[0].end || occs[0].start;
    const hasRecurrence = occs.length > 1 ? 1 : 0;

    const recurrenceRule =
      hasRecurrence
        ? {
            type: "custom",
            items: occs.map((o) => ({
              date: String(o.start).slice(0, 10),
              start: o.start,
              end: o.end || o.start,
            })),
          }
        : null;

    const recurrenceDates = hasRecurrence
      ? JSON.stringify(occs.map((o) => String(o.start).slice(0, 10)))
      : null;

    const recurrenceStartDate = String(occs[0].start).slice(0, 10);
    const recurrenceUntilDate = String(occs[occs.length - 1].start).slice(0, 10);

    const sourceKey = `kcls:${Buffer.from(key).toString("base64").slice(0, 48)}`;
    const existing = await get("SELECT id, slug FROM events WHERE sourceKey = ?", [sourceKey]);

    const catsJson = JSON.stringify(["Community"]);
    const baseFields = [];

    function addField(k, v) {
      if (!colsSet.size || colsSet.has(k)) baseFields.push([k, v]);
    }

    addField("city", g.city);
    addField("title", g.title);
    addField("description", g.description || "");
    addField("eventDetails", "");
    addField("goodToKnow", "");
    addField("startDateTime", startDateTime);
    addField("endDateTime", endDateTime);
    addField("location", g.location);
    addField("organizer", g.organizer);
    addField("imageUrl", null);
    addField("ticketUrl", null);
    addField("ticketLabel", "Tickets");
    addField("categories", catsJson);
    addField("featured", 0);
    addField("hasRecurrence", hasRecurrence);
    addField("recurrenceRule", recurrenceRule ? JSON.stringify(recurrenceRule) : null);
    addField("recurrenceDates", recurrenceDates);
    addField("recurrenceStartDate", recurrenceStartDate);
    addField("recurrenceUntilDate", recurrenceUntilDate);
    addField("sourceKey", sourceKey);
    addField("sourceUrl", g.sourceUrl || null);

    if (existing?.id) {
      const sets = baseFields.map(([k]) => `${k}=?`).join(", ");
      const vals = baseFields.map(([, v]) => v);
      vals.push(existing.id);
      await run(`UPDATE events SET ${sets} WHERE id=?`, vals);
    } else {
      const baseSlug = slugify(g.title || "event");
      const slug = await ensureUniqueSlug(baseSlug, null);
      const insertFields = [["slug", slug], ...baseFields];
      const cols = insertFields.map(([k]) => k).join(", ");
      const placeholders = insertFields.map(() => "?").join(", ");
      const vals = insertFields.map(([, v]) => v);
      await run(`INSERT INTO events (${cols}) VALUES (${placeholders})`, vals);
    }
  }

  console.log(`[KCLS] Imported/updated ${groups.size} series`);
}

// --------------------
// Persistent uploads
// --------------------
const UPLOADS_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.RENDER_DISK_PATH
    ? path.join(process.env.RENDER_DISK_PATH, "uploads")
    : path.join(process.cwd(), "uploads"));

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
console.log("[UPLOADS] Using folder:", UPLOADS_DIR);

// Host uploads publicly
app.use("/uploads", express.static(UPLOADS_DIR));

// Static assets
app.use("/assets", express.static(path.join(__dirname, "public")));

// Middleware
const allowedOrigins = [
  "https://enumclawevents.org",
  "https://www.enumclawevents.org",
  "https://api.opencircleapi.com",
].filter(Boolean);

const envAllow = String(process.env.CORS_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, _res, next) => {
  const now = Date.now();
  const arr = app.locals.reqTimes || [];
  arr.push(now);
  const cutoff = now - 5 * 60 * 1000;
  while (arr.length && arr[0] < cutoff) arr.shift();
  app.locals.reqTimes = arr;
  next();
});

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server / curl with no origin
      if (!origin) return cb(null, true);

      // allow explicit allowlist
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (envAllow.includes(origin)) return cb(null, true);

      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// --------------------
// Basic Auth for /admin
// --------------------
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "opencircle";

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Basic" || !token) {
    res.setHeader("WWW-Authenticate", 'Basic realm="OpenCircle Admin"');
    return res.status(401).send("Authentication required.");
  }

  let decoded = "";
  try {
    decoded = Buffer.from(token, "base64").toString("utf8");
  } catch (_) {
    res.setHeader("WWW-Authenticate", 'Basic realm="OpenCircle Admin"');
    return res.status(401).send("Invalid authorization header.");
  }

  const idx = decoded.indexOf(":");
  const user = idx >= 0 ? decoded.slice(0, idx) : "";
  const pass = idx >= 0 ? decoded.slice(idx + 1) : "";

  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();

  res.setHeader("WWW-Authenticate", 'Basic realm="OpenCircle Admin"');
  return res.status(401).send("Invalid credentials.");
}

// Home test route
app.get("/", (req, res) => {
  res.json({
    name: "OpenCircle API",
    status: "ok",
    endpoints: ["/events", "/events/:id", "/admin", "/uploads/*", "/assets/brand/*"],
  });
});

app.get("/health", (req, res) => res.status(200).send("ok"));
app.use(express.json());
app.use(express.text({ type: "text/plain" })); // for sendBeacon payloads

// Routes
app.use("/events", eventsRouter);
app.use("/admin", requireAdmin, adminRouter);

// Global error handler (so 500s are logged)
app.use((err, req, res, next) => {
  console.error("[EXPRESS] Unhandled error:", err);
  res.status(500).json({ error: "Server error" });
});

// Start only AFTER DB init (prevents random 500s)
const PORT = Number(process.env.PORT) || 3000;

initDB()
  .then(async () => {
    // Run once on boot
    try {
      const r = await archiveExpiredEvents();
      if (r?.archived) console.log("[ARCHIVE] Archived on boot:", r.archived);
    } catch (e) {
      console.error("[ARCHIVE] Boot run failed:", e);
    }

    // KCLS RSS import (daily)
    try {
      await importKclsRssDaily();
    } catch (e) {
      console.error("[KCLS] Boot import failed:", e);
    }

    // Run every 15 minutes
    setInterval(() => {
      archiveExpiredEvents()
        .then((r) => {
          if (r?.archived) console.log("[ARCHIVE] Archived:", r.archived);
        })
        .catch((e) => console.error("[ARCHIVE] Interval failed:", e));
    }, 15 * 60 * 1000);

    // Run daily
    setInterval(() => {
      importKclsRssDaily().catch((e) => console.error("[KCLS] Daily import failed:", e));
    }, 24 * 60 * 60 * 1000);

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`OpenCircle API running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[BOOT] DB init failed:", err);
    process.exit(1);
  });

// Export for routers if needed
module.exports = { UPLOADS_DIR };
