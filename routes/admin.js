"use strict";

const express = require("express");
const router = express.Router();
const { run, all, get, slugify, ensureUniqueSlug, DB_PATH } = require("../db");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { execSync, execFileSync } = require("child_process");
const { sendEmail, PASSWORD_RESET_FROM, PASSWORD_RESET_REPLY_TO } = require("../mailer");
const { findLikelyEventDuplicates } = require("../lib/event-dedupe");
const crypto = require("crypto");
const packageMeta = require("../package.json");
const { hashPassword, hashToken, verifyPassword } = require("../lib/auth");
const { DateTime } = require("luxon");
const { esc } = require("../lib/html");
const { safeParseJson } = require("../lib/json");
const { ALLOWED_CATEGORIES, ALLOWED_VENUE_CATEGORIES, DEFAULT_TZ } = require("../lib/admin-constants");
const {
  JOB_APPLICATION_FIELDS,
  JOB_EMPLOYMENT_TYPE_OPTIONS,
  formatEmploymentTypeDisplay,
  getJobEmploymentTypesForEdit,
  normalizeJobApplicationFields,
  normalizeJobApplicationMode,
} = require("../lib/job-utils");
const { bulkImportUpload, persistImportedImage, persistUploadedImage, upload } = require("../lib/uploads");

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

function parseCsvBoolean(input) {
  const value = String(input || "").trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "y";
}

function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === '"') {
      if (inQuotes && next === '"') {
        field += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (ch === "," && !inQuotes) {
      row.push(field);
      field = "";
      continue;
    }

    if ((ch === "\n" || ch === "\r") && !inQuotes) {
      if (ch === "\r" && next === "\n") i += 1;
      row.push(field);
      if (row.some((cell) => String(cell || "").trim() !== "")) rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += ch;
  }

  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((cell) => String(cell || "").trim() !== "")) rows.push(row);
  }

  if (!rows.length) return [];

  const headers = rows[0].map((cell) => String(cell || "").trim());
  return rows.slice(1).map((cells, index) => {
    const out = { __rowNumber: index + 2 };
    headers.forEach((header, cellIndex) => {
      if (!header) return;
      out[header] = String(cells[cellIndex] || "").trim();
    });
    return out;
  });
}

function getCsvValue(row, keys) {
  for (const key of keys) {
    if (row[key] !== undefined && row[key] !== null && String(row[key]).trim() !== "") {
      return String(row[key]).trim();
    }
  }
  return "";
}

function parseCsvListValues(input) {
  return String(input || "")
    .split(/[|,;]/g)
    .map((part) => String(part || "").trim())
    .filter(Boolean);
}

function normalizeAssetKey(input) {
  return String(input || "")
    .trim()
    .toLowerCase()
    .replace(/\\/g, "/")
    .split("/")
    .pop()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function buildZipImageMap(zipBuffer) {
  if (!zipBuffer || !zipBuffer.length) return new Map();

  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "oc-bulk-images-"));
  const zipPath = path.join(baseDir, "images.zip");
  const extractDir = path.join(baseDir, "unzipped");
  fs.mkdirSync(extractDir, { recursive: true });
  fs.writeFileSync(zipPath, zipBuffer);

  try {
    execFileSync("unzip", ["-o", zipPath, "-d", extractDir], { stdio: "ignore" });
  } catch (err) {
    try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {}
    throw new Error("Failed to extract image ZIP. Make sure it is a valid .zip archive.");
  }

  const imageMap = new Map();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      const key = normalizeAssetKey(entry.name);
      if (!key) continue;
      imageMap.set(key, full);
    }
  };

  walk(extractDir);
  return { imageMap, cleanup: () => { try { fs.rmSync(baseDir, { recursive: true, force: true }); } catch (_) {} } };
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

function normalizeMultiDaySchedule(input) {
  const items = safeParseJson(input, []);
  if (!Array.isArray(items)) return [];
  return items
    .map((item) => {
      const date = String(item?.date || "").trim();
      const startTime = String(item?.startTime || "").trim();
      const endTime = String(item?.endTime || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
      if (!/^\d{2}:\d{2}$/.test(startTime)) return null;
      if (!/^\d{2}:\d{2}$/.test(endTime)) return null;
      return { date, startTime, endTime };
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
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
  const extras = [];
  const parsedJson = !Array.isArray(input) && typeof input === "string" ? safeParseJson(input, null) : null;
  const source = Array.isArray(parsedJson) ? [...rawItems, ...parsedJson] : rawItems;
  if (fallbackPlacement) source.push(fallbackPlacement);

  const seen = new Set();
  for (const item of source) {
    const v = String(item || "").trim();
    if (!v || seen.has(v)) continue;
    if (allowed.has(v) || v === fallbackPlacement) {
      extras.push(v);
      seen.add(v);
    }
  }
  return extras;
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

function truncatePlainText(str, max) {
  const text = String(str || "").replace(/\s+/g, " ").trim();
  const limit = Math.max(0, Number(max || 0));
  if (!limit || text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + "…";
}

function buildBasicEventSeoFields(input = {}) {
  const title = String(input.title || "").replace(/\s+/g, " ").trim();
  const location = String(input.location || "").replace(/\s+/g, " ").trim();
  const organizer = String(input.organizer || "").replace(/\s+/g, " ").trim();
  const description = truncatePlainText(stripHtml(input.description || ""), 160);

  const seoTitleBase = [title, location].filter(Boolean).join(" | ");
  const seoTitle = truncatePlainText(seoTitleBase || title, 60);

  let metaDescription = description;
  if (!metaDescription) {
    metaDescription = truncatePlainText(
      [title, location ? `at ${location}` : "", organizer ? `hosted by ${organizer}` : ""]
        .filter(Boolean)
        .join(" "),
      160
    );
  }

  return {
    seoTitle,
    metaDescription,
    focusKeyphrase: truncatePlainText(title, 100),
    imageAlt: truncatePlainText(
      [title, location ? `at ${location}` : ""].filter(Boolean).join(" "),
      120
    ),
  };
}

function buildBasicJobSeoFields(input = {}) {
  const title = String(input.title || "").replace(/\s+/g, " ").trim();
  const company = String(input.company || "").replace(/\s+/g, " ").trim();
  const location = String(input.location || "").replace(/\s+/g, " ").trim();
  const description = truncatePlainText(stripHtml(input.description || ""), 160);

  const seoTitleBase = [title, company].filter(Boolean).join(" | ");
  const seoTitle = truncatePlainText(seoTitleBase || title, 60);

  let metaDescription = description;
  if (!metaDescription) {
    metaDescription = truncatePlainText(
      [title, company ? `at ${company}` : "", location || ""]
        .filter(Boolean)
        .join(" "),
      160
    );
  }

  return {
    seoTitle,
    metaDescription,
    focusKeyphrase: truncatePlainText([title, company].filter(Boolean).join(" "), 100),
    imageAlt: truncatePlainText([title, company].filter(Boolean).join(" "), 120),
  };
}

function resolveSeoFieldValue(manualValue, generatedValue) {
  const manual = String(manualValue || "").trim();
  if (manual) return manual;
  return String(generatedValue || "").trim();
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

function normalizeIsoToTzKeepClock(iso, tz = DEFAULT_TZ) {
  const s = String(iso || "").trim();
  if (!s) return s;
  if (s.endsWith("Z")) {
    return normalizeIsoToTzKeepClock(`${s.slice(0, -1)}+00:00`, tz);
  }
  if (/[+-]\d{2}:\d{2}$/.test(s) && !s.endsWith("+00:00")) return s;
  if (!s.endsWith("+00:00")) return s;
  const dt = new Date(s);
  if (Number.isNaN(dt.getTime())) return s;
  const local = new Date(dt.getTime());
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(fmt.formatToParts(local).filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
  const wall = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
  const guess = new Date(`${wall}Z`);
  const offsetMinutes = Math.round((guess.getTime() - dt.getTime()) / 60000);
  const sign = offsetMinutes <= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const offH = String(Math.floor(abs / 60)).padStart(2, "0");
  const offM = String(abs % 60).padStart(2, "0");
  return `${wall}${sign}${offH}:${offM}`;
}

function normalizeRowTimes(row, tz = DEFAULT_TZ) {
  if (!row) return row;
  return {
    ...row,
    startDateTime: normalizeIsoToTzKeepClock(row.startDateTime, tz),
    endDateTime: normalizeIsoToTzKeepClock(row.endDateTime, tz),
  };
}

function hasRecurringData(row) {
  if (parseStoredRule(row?.recurrenceRule)) return true;
  const dates = parseStoredDates(row?.recurrenceDates);
  return Array.isArray(dates) && dates.length > 0;
}

function getRecurringSeriesEndUtcMs(row, fallbackUtcMs) {
  const rule = parseStoredRule(row?.recurrenceRule);
  const dates = parseStoredDates(row?.recurrenceDates);
  const candidates = [];

  if (rule && Array.isArray(rule.items)) {
    for (const item of rule.items) {
      const ts = Date.parse(String(item?.start || "").trim());
      if (Number.isFinite(ts)) candidates.push(ts);
    }
  }

  if (Array.isArray(dates)) {
    for (const item of dates) {
      if (item && typeof item === "object") {
        const ts = Date.parse(String(item.start || "").trim());
        if (Number.isFinite(ts)) candidates.push(ts);
        continue;
      }
      const raw = String(item || "").trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
        const startIso = String(row?.startDateTime || "").trim();
        const timePart = startIso.length >= 19 ? startIso.slice(10) : "T00:00:00+00:00";
        const ts = Date.parse(`${raw}${timePart}`);
        if (Number.isFinite(ts)) candidates.push(ts);
      }
    }
  }

  const untilDate = String(row?.recurrenceUntilDate || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(untilDate)) {
    const startParts = parseIsoParts(String(row?.startDateTime || "").trim());
    if (startParts) {
      const [year, month, day] = untilDate.split("-").map(Number);
      candidates.push(partsToUtcMs({
        year,
        month,
        day,
        hour: startParts.hour,
        minute: startParts.minute,
        second: startParts.second,
        offset: startParts.offset,
      }));
    }
  }

  return candidates.length ? Math.max(...candidates) : fallbackUtcMs;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function toYmd(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`;
}

function localOffsetStringForParts(year, month, day, hour = 0, minute = 0, second = 0) {
  const local = new Date(year, month - 1, day, hour, minute, second, 0);
  const offsetMin = -local.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMin);
  return `${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

function parseIsoParts(iso) {
  const s = String(iso || "").trim();
  const m = s.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?(?:([+-]\d{2}:\d{2}|Z))?$/
  );
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  const hour = Number(m[4] || "00");
  const minute = Number(m[5] || "00");
  const second = Number(m[6] || "00");
  const rawOffset = m[7] || "";
  const offset = rawOffset === "Z"
    ? "+00:00"
    : (rawOffset || localOffsetStringForParts(year, month, day, hour, minute, second));
  return {
    year,
    month,
    day,
    hour,
    minute,
    second,
    offset,
  };
}

function offsetToMinutes(offset) {
  const m = String(offset || "").match(/^([+-])(\d{2}):(\d{2})$/);
  if (!m) return 0;
  const sign = m[1] === "-" ? -1 : 1;
  return sign * (Number(m[2]) * 60 + Number(m[3]));
}

function partsToUtcMs(parts) {
  const offMin = offsetToMinutes(parts.offset);
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second || 0);
  return localAsUtc - offMin * 60 * 1000;
}

function utcMsToLocalParts(utcMs, offset) {
  const offMin = offsetToMinutes(offset);
  const localMs = utcMs + offMin * 60 * 1000;
  const d = new Date(localMs);
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    offset,
  };
}

function partsToIso(parts) {
  return (
    `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}` +
    `T${pad2(parts.hour)}:${pad2(parts.minute)}:${pad2(parts.second || 0)}` +
    `${parts.offset}`
  );
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayKeyFromLocalParts(parts) {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 12, 0, 0);
  const d = new Date(localAsUtc);
  return ["SU", "MO", "TU", "WE", "TH", "FR", "SA"][d.getUTCDay()];
}

function startOfWeekLocalDate(parts) {
  const localAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  const d = new Date(localAsUtc);
  const dow = d.getUTCDay();
  d.setUTCDate(d.getUTCDate() - ((dow + 6) % 7));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function monthsDiff(y1, m1, y2, m2) {
  return (y2 - y1) * 12 + (m2 - m1);
}

function nthWeekdayOfMonth(year, month, weekdayKey, setPos) {
  const map = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
  const target = map[weekdayKey];
  if (target === undefined) return null;
  const dim = daysInMonth(year, month);
  if (setPos === -1) {
    for (let day = dim; day >= 1; day--) {
      const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
      if (d.getUTCDay() === target) return day;
    }
    return null;
  }
  let count = 0;
  for (let day = 1; day <= dim; day++) {
    const d = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    if (d.getUTCDay() === target) {
      count++;
      if (count === setPos) return day;
    }
  }
  return null;
}

function buildRecurrenceBounds(row, offset, windowStartUtcMs, windowEndUtcMs) {
  let startMs = windowStartUtcMs;
  let endMs = windowEndUtcMs;
  const startDate = String(row?.recurrenceStartDate || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(startDate)) {
    const [year, month, day] = startDate.split("-").map(Number);
    startMs = Math.max(startMs, partsToUtcMs({ year, month, day, hour: 0, minute: 0, second: 0, offset }));
  }
  const untilDate = String(row?.recurrenceUntilDate || "").trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(untilDate)) {
    const [year, month, day] = untilDate.split("-").map(Number);
    endMs = Math.min(endMs, partsToUtcMs({ year, month, day, hour: 23, minute: 59, second: 59, offset }));
  }
  return { startMs, endMs };
}

function generateAdminOccurrences(eventRow, windowStartUtcMs, windowEndUtcMs) {
  const startIso = String(eventRow?.startDateTime || "").trim();
  const fallbackEndIso = startIso ? addHoursIso(startIso, 1) : "";
  const endIso = String(eventRow?.endDateTime || "").trim() || fallbackEndIso;
  const startParts = parseIsoParts(startIso);
  const endParts = parseIsoParts(endIso);
  if (!startParts || !endParts) return [];

  const startUtc = Date.parse(startIso);
  const endUtc = Date.parse(endIso);
  if (!Number.isFinite(startUtc) || !Number.isFinite(endUtc)) return [];

  const rule = parseStoredRule(eventRow.recurrenceRule);
  if (!rule || !hasRecurringData(eventRow)) return [];

  const durationMs = Math.max(0, endUtc - startUtc);
  const offset = startParts.offset;
  const boundedStart = windowStartUtcMs;
  const boundedEnd = windowEndUtcMs;
  if (boundedStart > boundedEnd) return [];

  const type = String(rule.type || "").toLowerCase();
  const interval = Math.max(1, Number(rule.interval || 1) || 1);
  const out = [];

  if (type === "custom") {
    if (Array.isArray(rule.items) && rule.items.length) {
      for (const item of rule.items) {
        const startIso = String(item?.start || "").trim();
        const endIso = String(item?.end || "").trim();
        const occStartUtc = Date.parse(startIso);
        if (!Number.isFinite(occStartUtc)) continue;
        if (occStartUtc < boundedStart || occStartUtc > boundedEnd || occStartUtc < startUtc) continue;
        const startIsoParts = parseIsoParts(startIso);
        out.push({
          occurrenceDate: startIso.slice(0, 10),
          startDateTime: startIso,
          endDateTime: endIso || "",
          parts: startIsoParts,
        });
      }
      return out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
    }

    const dates = parseStoredDates(eventRow.recurrenceDates);
    for (const dateStr of dates) {
      const s = String(dateStr || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) continue;
      const [year, month, day] = s.split("-").map(Number);
      const occLocal = { year, month, day, hour: startParts.hour, minute: startParts.minute, second: startParts.second, offset };
      const occStartUtc = partsToUtcMs(occLocal);
      if (occStartUtc < boundedStart || occStartUtc > boundedEnd || occStartUtc < startUtc) continue;
      const occEnd = utcMsToLocalParts(occStartUtc + durationMs, offset);
      out.push({
        occurrenceDate: toYmd(occLocal),
        startDateTime: partsToIso(occLocal),
        endDateTime: partsToIso(occEnd),
        parts: occLocal,
      });
    }
    return out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
  }

  const anchorLocal = {
    year: startParts.year,
    month: startParts.month,
    day: startParts.day,
    hour: startParts.hour,
    minute: startParts.minute,
    second: startParts.second,
    offset,
  };
  const anchorWeekStart = startOfWeekLocalDate(anchorLocal);

  if (type === "weekly") {
    const byDay = Array.isArray(rule.byDay) ? rule.byDay : [];
    const allowedDays = new Set(byDay.map((d) => String(d || "").trim().toUpperCase()).filter(Boolean));
    const dayMs = 86400 * 1000;
    for (let t = boundedStart; t <= boundedEnd; t += dayMs) {
      const lp = utcMsToLocalParts(t, offset);
      const weekday = weekdayKeyFromLocalParts(lp);
      if (!allowedDays.has(weekday)) continue;
      const candWeekStart = startOfWeekLocalDate(lp);
      const anchorWsUtc = Date.UTC(anchorWeekStart.year, anchorWeekStart.month - 1, anchorWeekStart.day, 0, 0, 0);
      const candWsUtc = Date.UTC(candWeekStart.year, candWeekStart.month - 1, candWeekStart.day, 0, 0, 0);
      const weekIndex = Math.floor((candWsUtc - anchorWsUtc) / (7 * dayMs));
      if (weekIndex < 0 || weekIndex % interval !== 0) continue;
      const occLocal = {
        year: lp.year,
        month: lp.month,
        day: lp.day,
        hour: startParts.hour,
        minute: startParts.minute,
        second: startParts.second,
        offset,
      };
      const occStartUtc = partsToUtcMs(occLocal);
      if (occStartUtc < boundedStart || occStartUtc > boundedEnd || occStartUtc < startUtc) continue;
      const occEnd = utcMsToLocalParts(occStartUtc + durationMs, offset);
      out.push({
        occurrenceDate: toYmd(occLocal),
        startDateTime: partsToIso(occLocal),
        endDateTime: partsToIso(occEnd),
        parts: occLocal,
      });
    }
    return out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
  }

  if (type === "monthly") {
    const mode = rule.mode === "nthweekday" ? "nthweekday" : "monthday";
    const windowStartLocal = utcMsToLocalParts(boundedStart, offset);
    const windowEndLocal = utcMsToLocalParts(boundedEnd, offset);
    const startMonthIndex = Math.max(0, monthsDiff(anchorLocal.year, anchorLocal.month, windowStartLocal.year, windowStartLocal.month));
    const endMonthIndex = Math.max(0, monthsDiff(anchorLocal.year, anchorLocal.month, windowEndLocal.year, windowEndLocal.month));

    for (let mi = startMonthIndex; mi <= endMonthIndex; mi++) {
      if (mi % interval !== 0) continue;
      const base = new Date(Date.UTC(anchorLocal.year, anchorLocal.month - 1, 1, 12, 0, 0));
      base.setUTCMonth(base.getUTCMonth() + mi);
      const year = base.getUTCFullYear();
      const month = base.getUTCMonth() + 1;
      let days = [];

      if (mode === "monthday") {
        const md = Number(rule.byMonthday || 0);
        if (!md) continue;
        days = [Math.min(md, daysInMonth(year, month))];
      } else {
        const setPos = Number(rule.setPos || 1);
        const byDayRaw = Array.isArray(rule.byDay) ? rule.byDay : [rule.byDay];
        const byDays = byDayRaw.map((d) => String(d || "").trim().toUpperCase()).filter(Boolean);
        const fallbackDay = weekdayKeyFromLocalParts(startParts);
        if (!byDays.length) byDays.push(fallbackDay);
        const uniq = [];
        for (const wd of byDays) {
          const day = nthWeekdayOfMonth(year, month, wd, setPos);
          if (day && !uniq.includes(day)) uniq.push(day);
        }
        days = uniq;
      }

      for (const day of days) {
        const occLocal = { year, month, day, hour: startParts.hour, minute: startParts.minute, second: startParts.second, offset };
        const occStartUtc = partsToUtcMs(occLocal);
        if (occStartUtc < boundedStart || occStartUtc > boundedEnd || occStartUtc < startUtc) continue;
        const occEnd = utcMsToLocalParts(occStartUtc + durationMs, offset);
        out.push({
          occurrenceDate: toYmd(occLocal),
          startDateTime: partsToIso(occLocal),
          endDateTime: partsToIso(occEnd),
          parts: occLocal,
        });
      }
    }
    return out.sort((a, b) => Date.parse(a.startDateTime) - Date.parse(b.startDateTime));
  }

  return [];
}

function getZonedDateParts(date = new Date(), tz = DEFAULT_TZ) {
  const dt = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(dt.getTime())) return null;
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(dt).filter((p) => p.type !== "literal").map((p) => [p.type, p.value])
  );
  if (!parts.year || !parts.month || !parts.day) return null;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekdayShort: String(parts.weekday || ""),
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
  };
}

function getTimeZoneOffsetStringForInstant(date = new Date(), tz = DEFAULT_TZ) {
  const dt = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(dt.getTime())) return "+00:00";
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "longOffset",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const tzName = fmt.formatToParts(dt).find((part) => part.type === "timeZoneName")?.value || "";
    const match = tzName.match(/GMT([+-]\d{2}):(\d{2})$/);
    if (match) return `${match[1]}:${match[2]}`;
  } catch (_) {}
  return "+00:00";
}

function zonedYmdBoundaryToUtcIso(ymd, boundary, tz = DEFAULT_TZ) {
  const s = String(ymd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const [year, month, day] = s.split("-").map(Number);
  const hour = boundary === "end" ? 23 : 0;
  const minute = boundary === "end" ? 59 : 0;
  const second = boundary === "end" ? 59 : 0;
  const offset = getTimeZoneOffsetStringForInstant(new Date(Date.UTC(year, month - 1, day, 12, 0, 0)), tz);
  return partsToIso({ year, month, day, hour, minute, second, offset });
}

function addDaysToYmd(ymd, delta) {
  const s = String(ymd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const [year, month, day] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  dt.setUTCDate(dt.getUTCDate() + Number(delta || 0));
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, "0"),
    String(dt.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function addMonthsToYmd(ymd, delta) {
  const s = String(ymd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const [year, month, day] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, 1, 12, 0, 0));
  dt.setUTCMonth(dt.getUTCMonth() + Number(delta || 0));
  const targetYear = dt.getUTCFullYear();
  const targetMonth = dt.getUTCMonth() + 1;
  const targetDay = Math.min(day, new Date(Date.UTC(targetYear, targetMonth, 0, 12, 0, 0)).getUTCDate());
  return [
    targetYear,
    String(targetMonth).padStart(2, "0"),
    String(targetDay).padStart(2, "0"),
  ].join("-");
}

function startOfWeekYmd(ymd) {
  const s = String(ymd || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return "";
  const [year, month, day] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const dow = dt.getUTCDay();
  dt.setUTCDate(dt.getUTCDate() - dow);
  return [
    dt.getUTCFullYear(),
    String(dt.getUTCMonth() + 1).padStart(2, "0"),
    String(dt.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

function enumerateDateRangeYmd(startIso, endIso) {
  const startParts = parseIsoParts(String(startIso || "").trim());
  const endParts = parseIsoParts(String(endIso || "").trim()) || startParts;
  if (!startParts || !endParts) return [];
  const startYmd = toYmd(startParts);
  const endYmd = toYmd(endParts);
  if (!startYmd || !endYmd) return [];
  const out = [];
  let cursor = startYmd;
  let guard = 0;
  while (cursor && cursor <= endYmd && guard < 366) {
    out.push(cursor);
    cursor = addDaysToYmd(cursor, 1);
    guard++;
  }
  return out;
}

// Convert datetime-local (no timezone) into ISO with local timezone offset
function toLocalISOWithOffset(dtLocal) {
  const raw = String(dtLocal || "").trim();
  if (!raw) return null;

  const zonedLocal = DateTime.fromFormat(raw, "yyyy-MM-dd'T'HH:mm", { zone: DEFAULT_TZ });
  if (zonedLocal.isValid) {
    return zonedLocal.toISO({ suppressMilliseconds: true, includeOffset: true });
  }

  const zonedWithSeconds = DateTime.fromFormat(raw, "yyyy-MM-dd'T'HH:mm:ss", { zone: DEFAULT_TZ });
  if (zonedWithSeconds.isValid) {
    return zonedWithSeconds.toISO({ suppressMilliseconds: true, includeOffset: true });
  }

  const parsed = DateTime.fromISO(raw, { setZone: true });
  if (parsed.isValid) {
    return parsed.toISO({ suppressMilliseconds: true, includeOffset: true });
  }

  return null;
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
    ["hasRecurrence", String(p.hasRecurrence || "") === "1" || Number(p.hasRecurrence || 0) === 1 ? 1 : 0],
    ["recurrenceRule", String(p.recurrenceRule || "") || null],
    ["recurrenceDates", String(p.recurrenceDates || "") || null],
    ["recurrenceStartDate", String(p.recurrenceStartDate || "") || null],
    ["recurrenceUntilDate", String(p.recurrenceUntilDate || "") || null],
    ["multiDaySchedule", String(p.multiDaySchedule || "") || null],
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

function buildHiddenAdminFormInputs(payload) {
  const rows = [];
  const append = (key, value) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) {
      value.forEach((item) => append(key, item));
      return;
    }
    rows.push(`<input type="hidden" name="${esc(key)}" value="${esc(String(value))}" />`);
  };
  Object.entries(payload || {}).forEach(([key, value]) => append(key, value));
  return rows.join("");
}

function buildAdminDuplicateResponse(submitted, matches, originalPayload) {
  const first = matches[0] || {};
  const replayInputs = buildHiddenAdminFormInputs({
    ...(originalPayload || {}),
    forceDuplicateSave: "1",
  });
  const items = (matches || []).slice(0, 8).map((match) => {
    const href = match.source === "events" && match.id
      ? `/admin/create-events?edit=${encodeURIComponent(String(match.id))}`
      : "";
    const reasons = Array.isArray(match.reasons) ? match.reasons.join(" · ") : "";
    return `
      <div style="border:1px solid rgba(15,23,42,.10); border-radius:12px; background:#fff; padding:14px;">
        <div style="font-weight:700; font-size:16px; color:#0f172a;">${esc(match.title || "Potential duplicate")}</div>
        <div style="margin-top:6px; color:#526377;">${esc(match.startDateTime || "")}${match.location ? ` · ${esc(match.location)}` : ""}</div>
        <div style="margin-top:6px; color:#526377;">Score: ${esc(String(match.score || 0))}</div>
        ${reasons ? `<div style="margin-top:6px; color:#526377;">${esc(reasons)}</div>` : ""}
        ${href ? `<div style="margin-top:10px;"><a href="${href}" style="color:#0ea5e9; text-decoration:none; font-weight:700;">Open existing event</a></div>` : ""}
      </div>
    `;
  }).join("");

  return `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Possible Duplicate Event</title>
      <style>
        body{margin:0;background:#edf2f7;color:#0f172a;font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial;}
        .wrap{max-width:920px;margin:0 auto;padding:24px;}
        .card{background:#fff;border:1px solid rgba(15,23,42,.10);border-radius:16px;padding:22px;}
        .matches{display:grid;gap:12px;margin-top:18px;}
        .actions{display:flex;gap:10px;flex-wrap:wrap;margin-top:18px;}
        .btn{display:inline-flex;align-items:center;justify-content:center;height:44px;padding:0 16px;border-radius:12px;border:1px solid rgba(15,23,42,.10);background:#fff;color:#0f172a;text-decoration:none;font-weight:700;}
        .btn-primary{background:#00c08b;color:#fff;border-color:#00c08b;}
        .note{margin-top:10px;color:#526377;}
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="card">
          <h1 style="margin:0;font-size:30px;line-height:1.1;">Possible duplicate event detected</h1>
          <p style="margin:12px 0 0;color:#526377;">"${esc(submitted.title || "")}" looks close to an existing event. This save was paused to protect current content.</p>
          ${first.title ? `<p class="note">Top match: ${esc(first.title)} on ${esc(first.startDateTime || "")}.</p>` : ``}
          <div class="matches">${items || `<div style="color:#526377;">No detailed matches available.</div>`}</div>
          <div class="actions">
            <a class="btn" href="javascript:history.back()">Go Back</a>
            <form method="POST" action="/admin/events" style="display:inline;">
              ${replayInputs}
              <button class="btn btn-primary" type="submit">Save Anyway</button>
            </form>
          </div>
          <div class="note">Use Save Anyway only when you are sure this is a separate event and not an accidental duplicate.</div>
        </div>
      </div>
    </body>
  </html>`;
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

async function findAdminEventDuplicateMatches({ city, title, startDateTime, endDateTime, location, organizer, ticketUrl, eventLink, excludeEventId = null, excludePendingId = null }) {
  const activeEvents = await all(
    `SELECT id, title, startDateTime, endDateTime, location, organizer, ticketUrl, slug
       FROM events
      WHERE LOWER(city) = LOWER(?)
        AND COALESCE(archived, 0) = 0
        ${excludeEventId ? "AND id <> ?" : ""}
      ORDER BY datetime(startDateTime) DESC
      LIMIT 800`,
    excludeEventId ? [city, excludeEventId] : [city]
  );

  const pendingEvents = await all(
    `SELECT id, title, startDateTime, endDateTime, location, organizer, ticketUrl, eventLink
       FROM pending_events
      WHERE LOWER(city) = LOWER(?)
        ${excludePendingId ? "AND id <> ?" : ""}
      ORDER BY datetime(startDateTime) DESC
      LIMIT 800`,
    excludePendingId ? [city, excludePendingId] : [city]
  );

  return findLikelyEventDuplicates(
    { city, title, startDateTime, endDateTime, location, organizer, ticketUrl, eventLink },
    [
      ...(activeEvents || []).map((row) => ({ ...row, source: "events" })),
      ...(pendingEvents || []).map((row) => ({ ...row, source: "pending_events" })),
    ]
  );
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
      createdByUserId INTEGER,
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
  if (!cols.has("createdByUserId")) {
    await run(`ALTER TABLE venues ADD COLUMN createdByUserId INTEGER`);
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
      employmentTypesJson TEXT,
      salaryRange TEXT,
      applyUrl TEXT,
      imageUrl TEXT,
      description TEXT,
      seoTitle TEXT,
      metaDescription TEXT,
      focusKeyphrase TEXT,
      imageAlt TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      viewCount INTEGER NOT NULL DEFAULT 0,
      createdByUserId INTEGER,
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
  if (!cols.has("employmentTypesJson")) await run(`ALTER TABLE jobs ADD COLUMN employmentTypesJson TEXT`);
  if (!cols.has("salaryRange")) await run(`ALTER TABLE jobs ADD COLUMN salaryRange TEXT`);
  if (!cols.has("applyUrl")) await run(`ALTER TABLE jobs ADD COLUMN applyUrl TEXT`);
  if (!cols.has("imageUrl")) await run(`ALTER TABLE jobs ADD COLUMN imageUrl TEXT`);
  if (!cols.has("description")) await run(`ALTER TABLE jobs ADD COLUMN description TEXT`);
  if (!cols.has("seoTitle")) await run(`ALTER TABLE jobs ADD COLUMN seoTitle TEXT`);
  if (!cols.has("metaDescription")) await run(`ALTER TABLE jobs ADD COLUMN metaDescription TEXT`);
  if (!cols.has("focusKeyphrase")) await run(`ALTER TABLE jobs ADD COLUMN focusKeyphrase TEXT`);
  if (!cols.has("imageAlt")) await run(`ALTER TABLE jobs ADD COLUMN imageAlt TEXT`);
  if (!cols.has("status")) await run(`ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  if (!cols.has("applicationMode")) await run(`ALTER TABLE jobs ADD COLUMN applicationMode TEXT NOT NULL DEFAULT 'external'`);
  if (!cols.has("applicationFieldsJson")) await run(`ALTER TABLE jobs ADD COLUMN applicationFieldsJson TEXT`);
  if (!cols.has("viewCount")) await run(`ALTER TABLE jobs ADD COLUMN viewCount INTEGER NOT NULL DEFAULT 0`);
  if (!cols.has("createdByUserId")) await run(`ALTER TABLE jobs ADD COLUMN createdByUserId INTEGER`);
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
      createdByUserId INTEGER,
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
  if (!cols.has("placementsJson")) await run(`ALTER TABLE ads ADD COLUMN placementsJson TEXT`);
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
  if (!cols.has("createdByUserId")) await run(`ALTER TABLE ads ADD COLUMN createdByUserId INTEGER`);
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
      fieldsJson TEXT,
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

  const applicantCols = await all("PRAGMA table_info(job_applicants)");
  const applicantNames = new Set((applicantCols || []).map((r) => String(r.name)));
  if (!applicantNames.has("fieldsJson")) await run(`ALTER TABLE job_applicants ADD COLUMN fieldsJson TEXT`);

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
      role TEXT DEFAULT 'organizer',
      city TEXT DEFAULT 'Enumclaw',
      permissionsJson TEXT,
      displayName TEXT,
      phone TEXT,
      photoUrl TEXT,
      bio TEXT,
      presenceStatus TEXT,
      lastSeenAt TEXT,
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
  await addCol("permissionsJson", "ALTER TABLE users ADD COLUMN permissionsJson TEXT");
  await addCol("presenceStatus", "ALTER TABLE users ADD COLUMN presenceStatus TEXT");
  await addCol("lastSeenAt", "ALTER TABLE users ADD COLUMN lastSeenAt TEXT");
  await addCol("updatedAt", "ALTER TABLE users ADD COLUMN updatedAt TEXT");

  try {
    await run(`UPDATE users SET role = 'developer' WHERE lower(COALESCE(role,'')) IN ('admin','developer','area_manager')`);
    await run(`UPDATE users SET role = 'organizer' WHERE lower(COALESCE(role,'')) NOT IN ('developer') OR role IS NULL OR role = ''`);
    await run(
      `UPDATE users
          SET permissionsJson = ?
        WHERE lower(COALESCE(role,'')) = 'organizer'
          AND (permissionsJson IS NULL OR trim(permissionsJson) = '')`,
      [JSON.stringify({ events: true, venues: true, jobs: true, ads: true, featureEvents: false })]
    );
  } catch (_) {}

  _userProfileSchemaEnsured = true;
}

let _messageSchemaEnsured = false;
async function ensureMessageSchema() {
  if (_messageSchemaEnsured) return;
  await run(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL DEFAULT 'Enumclaw',
      senderUserId INTEGER NOT NULL,
      recipientUserId INTEGER NOT NULL,
      body TEXT NOT NULL,
      readAt TEXT,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);
  try { await run("CREATE INDEX IF NOT EXISTS idx_messages_city_createdAt ON messages(city, createdAt DESC)"); } catch (_) {}
  try { await run("CREATE INDEX IF NOT EXISTS idx_messages_recipient_readAt ON messages(recipientUserId, readAt)"); } catch (_) {}
  try { await run("CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(senderUserId, recipientUserId, createdAt DESC)"); } catch (_) {}
  await run(`
    CREATE TABLE IF NOT EXISTS message_typing_status (
      city TEXT NOT NULL DEFAULT 'Enumclaw',
      senderUserId INTEGER NOT NULL,
      recipientUserId INTEGER NOT NULL,
      isTyping INTEGER NOT NULL DEFAULT 0,
      updatedAt TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (city, senderUserId, recipientUserId)
    )
  `);
  try { await run("CREATE INDEX IF NOT EXISTS idx_message_typing_lookup ON message_typing_status(city, recipientUserId, senderUserId, updatedAt DESC)"); } catch (_) {}
  _messageSchemaEnsured = true;
}

async function resolveSessionUser(req) {
  await ensureUserProfileSchema();
  const rawKey = String(req.user?.user || "").trim();
  const role = normalizeRoleValue(req.user?.role || "organizer");
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
      "SELECT id, email, username, role, city, permissionsJson, displayName, phone, photoUrl, bio, presenceStatus, lastSeenAt, createdAt FROM users WHERE lower(COALESCE(username,'')) = lower(?) OR lower(COALESCE(email,'')) = lower(?) LIMIT 1",
      [key, key]
    );
    if (row?.id) return row;
  }

  if (role === "developer") {
    let adminRow = await get(
      "SELECT id, email, username, role, city, permissionsJson, displayName, phone, photoUrl, bio, presenceStatus, lastSeenAt, createdAt FROM users WHERE lower(COALESCE(role,'')) = 'developer' ORDER BY id ASC LIMIT 1"
    );
    if (adminRow?.id) return adminRow;

    const username = rawKey && !rawKey.includes("@") ? rawKey : "admin";
    const email = rawKey.includes("@") ? lowerKey : null;
    await run(
      "INSERT INTO users (email, username, passwordHash, role, city, permissionsJson, createdAt, updatedAt) VALUES (?, ?, ?, 'developer', ?, NULL, datetime('now'), datetime('now'))",
      [email, username, "", city]
    );
    adminRow = await get(
      "SELECT id, email, username, role, city, permissionsJson, displayName, phone, photoUrl, bio, presenceStatus, lastSeenAt, createdAt FROM users WHERE lower(COALESCE(username,'')) = lower(?) OR lower(COALESCE(email,'')) = lower(?) LIMIT 1",
      [username, email || username]
    );
    if (adminRow?.id) return adminRow;
  }

  return null;
}

async function resolveSupportCircleUser() {
  await ensureUserProfileSchema();
  const preferred = [
    { displayName: "Daniel Osterholt" },
    { username: "danielosterholt" },
    { email: "daniel@opencircleapi.com" },
    { email: "daniel@enumclawevents.org" },
    { role: "admin" }
  ];

  for (const candidate of preferred) {
    let row = null;
    if (candidate.displayName) {
      row = await get(
        "SELECT id, email, username, role, city, displayName, phone, photoUrl, bio, presenceStatus, lastSeenAt, createdAt FROM users WHERE lower(COALESCE(displayName,'')) = lower(?) LIMIT 1",
        [candidate.displayName]
      );
    } else if (candidate.username) {
      row = await get(
        "SELECT id, email, username, role, city, displayName, phone, photoUrl, bio, presenceStatus, lastSeenAt, createdAt FROM users WHERE lower(COALESCE(username,'')) = lower(?) LIMIT 1",
        [candidate.username]
      );
    } else if (candidate.email) {
      row = await get(
        "SELECT id, email, username, role, city, displayName, phone, photoUrl, bio, presenceStatus, lastSeenAt, createdAt FROM users WHERE lower(COALESCE(email,'')) = lower(?) LIMIT 1",
        [candidate.email]
      );
    } else if (candidate.role) {
      row = await get(
        "SELECT id, email, username, role, city, displayName, phone, photoUrl, bio, presenceStatus, lastSeenAt, createdAt FROM users WHERE lower(COALESCE(role,'')) = lower(?) ORDER BY id ASC LIMIT 1",
        [candidate.role]
      );
    }
    if (row?.id) return row;
  }

  return null;
}

function isUserOnline(lastSeenAt) {
  if (!lastSeenAt) return false;
  const ts = new Date(String(lastSeenAt)).getTime();
  if (!Number.isFinite(ts)) return false;
  return (Date.now() - ts) <= 5 * 60 * 1000;
}

function normalizePresenceStatus(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return ["available", "away", "dnd"].includes(normalized) ? normalized : "available";
}

function formatPresenceStatusLabel(value) {
  const normalized = normalizePresenceStatus(value);
  if (normalized === "away") return "Away";
  if (normalized === "dnd") return "Do Not Disturb";
  return "Available";
}

function getPresenceStatusClass(value, isOnline = true) {
  if (!isOnline) return "is-offline";
  const normalized = normalizePresenceStatus(value);
  if (normalized === "away") return "is-away";
  if (normalized === "dnd") return "is-dnd";
  return "is-available";
}

function getPresenceState(presenceStatus, lastSeenAt) {
  const online = isUserOnline(lastSeenAt);
  return {
    online,
    className: getPresenceStatusClass(presenceStatus, online),
    label: online ? formatPresenceStatusLabel(presenceStatus) : "Offline",
  };
}

function onlineStatusMarkup(lastSeenAtOrOptions, label = "User status") {
  const options = lastSeenAtOrOptions && typeof lastSeenAtOrOptions === "object" && !Array.isArray(lastSeenAtOrOptions)
    ? lastSeenAtOrOptions
    : { lastSeenAt: lastSeenAtOrOptions, label };
  const userId = Number(options.userId || 0);
  const state = getPresenceState(options.presenceStatus, options.lastSeenAt);
  const finalLabel = String(options.label || label || "User status");
  const userAttr = userId ? ` data-presence-user-id="${userId}"` : "";
  return `<span class="online-dot ${state.className}" data-presence-dot${userAttr} title="${esc(`${finalLabel}: ${state.label}`)}" aria-label="${esc(`${finalLabel}: ${state.label}`)}"></span>`;
}

function safeAdminRedirectPath(input, fallback = "/admin/preferences") {
  const raw = String(input || "").trim();
  if (!raw.startsWith("/")) return fallback;
  if (raw.startsWith("//")) return fallback;
  return raw;
}

function renderInlineIcon(name) {
  if (name === "gear") {
    return `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M19.14 12.94c.04-.31.06-.62.06-.94s-.02-.63-.06-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96c-.5-.4-1.05-.73-1.63-.96l-.36-2.52a.5.5 0 0 0-.49-.42h-3.84a.5.5 0 0 0-.49.42l-.36 2.52c-.58.23-1.13.56-1.63.96l-2.39-.96a.5.5 0 0 0-.6.22L2.71 8.46a.5.5 0 0 0 .12.64l2.03 1.58c-.04.31-.06.62-.06.94s.02.63.06.94L2.83 14.14a.5.5 0 0 0-.12.64l1.92 3.32a.5.5 0 0 0 .6.22l2.39-.96c.5.4 1.05.73 1.63.96l.36 2.52a.5.5 0 0 0 .49.42h3.84a.5.5 0 0 0 .49-.42l.36-2.52c.58-.23 1.13-.56 1.63-.96l2.39.96a.5.5 0 0 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"/>
      </svg>
    `;
  }
  if (name === "logout") {
    return `
      <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false">
        <path fill="currentColor" d="M10 17.25a.75.75 0 0 1-.75.75H6.5A2.5 2.5 0 0 1 4 15.5v-7A2.5 2.5 0 0 1 6.5 6h2.75a.75.75 0 0 1 0 1.5H6.5a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h2.75a.75.75 0 0 1 .75.75Zm8.78-5.78-3.5-3.5a.75.75 0 0 0-1.06 1.06L16.44 11.25H9.75a.75.75 0 0 0 0 1.5h6.69l-2.22 2.22a.75.75 0 1 0 1.06 1.06l3.5-3.5a.75.75 0 0 0 0-1.06Z"/>
      </svg>
    `;
  }
  return "";
}

const ORGANIZER_SECTION_KEYS = ["events", "venues", "jobs", "ads", "featureEvents"];
const DEFAULT_ORGANIZER_PERMISSIONS = Object.freeze({
  events: true,
  venues: false,
  jobs: false,
  ads: false,
  featureEvents: false,
});
const EXISTING_ORGANIZER_PERMISSIONS = Object.freeze({
  events: true,
  venues: true,
  jobs: true,
  ads: true,
  featureEvents: false,
});
const ADMIN_AREAS = Object.freeze([
  "Enumclaw",
  "Buckley",
  "Wilkeson",
  "Carbonado",
  "South Prairie",
]);

function formatOrganizerPermissionLabel(key) {
  if (key === "featureEvents") return "Feature Events";
  return String(key || "").charAt(0).toUpperCase() + String(key || "").slice(1);
}

function normalizeRoleValue(value) {
  const normalized = String(value || "organizer").trim().toLowerCase();
  if (["admin", "developer", "area_manager"].includes(normalized)) return "developer";
  return "organizer";
}

function isDeveloperRole(role) {
  return normalizeRoleValue(role) === "developer";
}

function hasDeveloperAccessRole(role) {
  return isDeveloperRole(role);
}

function formatRoleLabel(role) {
  return isDeveloperRole(role) ? "Developer" : "Organizer";
}

function isLiveRole(role) {
  const normalized = normalizeRoleValue(role);
  return normalized === "developer" || normalized === "organizer";
}

function liveRoleOptionsMarkup(selectedRole, { includeLegacySelected = false } = {}) {
  const normalized = normalizeRoleValue(selectedRole || "organizer");
  let legacyOption = "";
  if (includeLegacySelected && normalized && !isLiveRole(normalized)) {
    legacyOption = `<option value="${esc(normalized)}" selected>${esc(`${formatRoleLabel(normalized)} (Legacy)`)}</option>`;
  }
  return `${legacyOption}
    <option value="organizer" ${normalized === "organizer" ? "selected" : ""}>Organizer</option>
    <option value="developer" ${normalized === "developer" ? "selected" : ""}>Developer</option>`;
}

function parsePermissionsObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value === "string" && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch (_) {}
  }
  return null;
}

function normalizeCityAccessList(value, fallbackCity = "Enumclaw") {
  const seen = new Set();
  const out = [];
  const pushCity = (cityValue) => {
    const normalized = String(cityValue || "").trim();
    if (!normalized || !ADMIN_AREAS.includes(normalized) || seen.has(normalized)) return;
    seen.add(normalized);
    out.push(normalized);
  };

  if (Array.isArray(value)) {
    value.forEach(pushCity);
  } else if (value && typeof value === "object" && !Array.isArray(value)) {
    if (Array.isArray(value.cityAccess)) value.cityAccess.forEach(pushCity);
    else if (Array.isArray(value.cities)) value.cities.forEach(pushCity);
  } else if (typeof value === "string" && value.trim()) {
    pushCity(value);
  }

  if (!out.length) pushCity(fallbackCity);
  if (!out.length) pushCity("Enumclaw");
  return out;
}

function normalizeOrganizerPermissions(value, fallback = DEFAULT_ORGANIZER_PERMISSIONS) {
  const parsed = parsePermissionsObject(value);
  const base = { ...fallback };
  for (const key of ORGANIZER_SECTION_KEYS) {
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, key)) {
      base[key] = !!parsed[key];
    }
  }
  return base;
}

function stringifyOrganizerPermissions(value, fallback = DEFAULT_ORGANIZER_PERMISSIONS) {
  const parsed = parsePermissionsObject(value) || {};
  const payload = {
    ...parsed,
    ...normalizeOrganizerPermissions(parsed, fallback),
  };
  const cityAccess = normalizeCityAccessList(parsed, null);
  if (cityAccess.length) payload.cityAccess = cityAccess;
  return JSON.stringify(payload);
}

function isCheckedValue(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "on" || normalized === "yes";
}

function getUserSectionPermissions(user) {
  if (isDeveloperRole(user?.role)) {
    return { events: true, venues: true, jobs: true, ads: true, featureEvents: true };
  }
  return normalizeOrganizerPermissions(user?.permissionsJson, EXISTING_ORGANIZER_PERMISSIONS);
}

function hasSectionAccess(user, section) {
  return !!getUserSectionPermissions(user)[section];
}

function getUserAllowedCities(user, fallbackCity = "Enumclaw") {
  if (isDeveloperRole(user?.role)) return ADMIN_AREAS.slice();
  return normalizeCityAccessList(user?.permissionsJson, user?.city || fallbackCity || "Enumclaw");
}

function pickAccessibleCity(requestedCity, user, { fallbackCity = "Enumclaw" } = {}) {
  const allowedCities = getUserAllowedCities(user, fallbackCity);
  const preferred = String(requestedCity || "").trim();
  if (preferred && allowedCities.includes(preferred)) return preferred;
  return allowedCities[0] || fallbackCity || "Enumclaw";
}

function normalizeOrganizerIdentity(value) {
  return String(value || "").trim().toLowerCase();
}

function getOrganizerAccessValues(user, req) {
  return Array.from(new Set(
    [
      user?.displayName,
      user?.username,
      user?.email,
      req.user?.user,
      req.user?.username,
      req.user?.email,
    ]
      .map((value) => normalizeOrganizerIdentity(value))
      .filter(Boolean)
  ));
}

function getOrganizerPrimaryName(user, req) {
  return [
    user?.displayName,
    user?.username,
    user?.email,
    req.user?.user,
    req.user?.username,
    req.user?.email,
  ]
    .map((value) => String(value || "").trim())
    .find(Boolean) || "";
}

function buildOrganizerOwnerClause(column, values) {
  const normalized = (values || []).map((value) => normalizeOrganizerIdentity(value)).filter(Boolean);
  if (!normalized.length) {
    return { sql: "1=0", params: [] };
  }
  const placeholders = normalized.map(() => "?").join(",");
  return {
    sql: `lower(trim(COALESCE(${column}, ''))) IN (${placeholders})`,
    params: normalized,
  };
}

function organizerOwnsEvent(row, organizerValues) {
  return !!row && !!normalizeOrganizerIdentity(row.organizer) && (organizerValues || []).includes(normalizeOrganizerIdentity(row.organizer));
}

function buildCreatedByOwnerClause(userId) {
  const normalizedId = Number(userId || 0);
  if (!Number.isInteger(normalizedId) || normalizedId <= 0) {
    return { sql: "1=0", params: [] };
  }
  return {
    sql: "createdByUserId = ?",
    params: [normalizedId],
  };
}

// GET /admin
async function renderAdmin(req, res, view) {
  try {
    await ensurePickSchema();
    await ensureVenueSchema();
    const sessionUser = await resolveSessionUser(req);
    await ensureJobSchema();
    await ensureAdSchema();
    await ensureJobApplicantSchema();
    await ensureUserProfileSchema();
    await ensureMessageSchema();
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
const analyticsMetricHelp = {
  organizers: "The number of organizers being counted here.",
  totalEvents: "The total number of event dates being counted here.",
  uniqueEvents: "The number of different events, without counting repeats over and over.",
  upcoming: "Events or event dates that have not ended yet.",
  featured: "Events that are marked as featured.",
  allViews: "All views added together.",
  directViews: "Views from people who came straight to this page.",
  referralViews: "Views from people who came from another website or link.",
  internalViews: "Views that came from inside OpenCircle.",
};
const analyticsMetricLabel = (label, helpText) => `${esc(label)}<span class="metricInfo" tabindex="0" role="img" aria-label="${esc(`${label}: ${helpText}`)}" data-tip="${esc(helpText)}">i</span>`;

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

    const currentUser = await resolveSessionUser(req);
    const userRole = normalizeRoleValue(req.user?.role || "organizer");
    const hasDeveloperAccess = hasDeveloperAccessRole(userRole);
    const isOrganizerUser = userRole === "organizer";
    const sectionPermissions = getUserSectionPermissions(currentUser || { role: userRole });
    const userAllowedCities = getUserAllowedCities(currentUser || { role: userRole, city: req.user?.city || "Enumclaw" }, req.user?.city || "Enumclaw");
    const organizerAccessValues = isOrganizerUser ? getOrganizerAccessValues(currentUser, req) : [];
    const organizerPrimaryName = isOrganizerUser ? getOrganizerPrimaryName(currentUser, req) : "";
    const organizerOwnerClause = isOrganizerUser ? buildOrganizerOwnerClause("organizer", organizerAccessValues) : null;
    const organizerVenueOwnerClause = isOrganizerUser ? buildCreatedByOwnerClause(currentUser?.id) : null;
    const currentPresenceStatus = normalizePresenceStatus(currentUser?.presenceStatus);
    const currentPresenceLabel = formatPresenceStatusLabel(currentPresenceStatus);
    const currentPresenceClass = getPresenceStatusClass(currentPresenceStatus, !!currentUser?.id);
    const currentAdminPath = safeAdminRedirectPath(req.originalUrl || "/admin", "/admin");

    // City (from URL unless locked)
    const userCity = String(req.user?.city || currentUser?.city || "Enumclaw");
    const selectedCity = pickAccessibleCity(req.query.city, hasDeveloperAccess ? { role: "developer" } : currentUser, { fallbackCity: userCity });
    const canUseMessages = !!currentUser?.id;
    const canManageEvents = hasDeveloperAccess || sectionPermissions.events;
    const canApproveEvents = hasDeveloperAccess;
    const canSeeEventsAnalytics = canManageEvents;
    const canManageVenues = hasDeveloperAccess || sectionPermissions.venues;
    const canSeeVenueAnalytics = canManageVenues;
    const canManageJobs = hasDeveloperAccess || sectionPermissions.jobs;
    const canSeeJobAnalytics = canManageJobs;
    const canManageAds = hasDeveloperAccess || sectionPermissions.ads;
    const canSeeAdsAnalytics = canManageAds;
    const canSeeOrganizerAnalytics = hasDeveloperAccess;
    const canSeeAnyAnalytics = canSeeEventsAnalytics || canSeeVenueAnalytics || canSeeJobAnalytics || canSeeAdsAnalytics || canSeeOrganizerAnalytics;

    let unreadMessagesCount = 0;
    let messageContacts = [];
    let recentMessageThreads = [];
    let selectedMessageContactId = parseInt(String(req.query.user || ""), 10);
    let selectedMessageContact = null;
    let messageConversationRows = [];
    let supportCircleUser = null;

    if (canUseMessages) {
      supportCircleUser = await resolveSupportCircleUser();
      try {
        const unreadRow = await get(
          `SELECT COUNT(*) AS count
             FROM messages
            WHERE recipientUserId = ?
              AND city = ?
              AND readAt IS NULL`,
          [currentUser.id, selectedCity]
        );
        unreadMessagesCount = Number(unreadRow?.count || 0);
      } catch (_) {
        unreadMessagesCount = 0;
      }

      try {
        messageContacts = await all(
          `SELECT
             u.id,
             u.email,
             u.username,
             u.displayName,
             u.photoUrl,
             u.lastSeenAt,
             u.role,
             u.city,
             COALESCE(unread.unreadCount, 0) AS unreadCount,
             latest.latestAt
           FROM users u
           LEFT JOIN (
             SELECT senderUserId AS otherUserId, COUNT(*) AS unreadCount
             FROM messages
             WHERE recipientUserId = ?
               AND city = ?
               AND readAt IS NULL
             GROUP BY senderUserId
           ) unread ON unread.otherUserId = u.id
           LEFT JOIN (
             SELECT
               CASE
                 WHEN senderUserId = ? THEN recipientUserId
                 ELSE senderUserId
               END AS otherUserId,
               MAX(datetime(createdAt)) AS latestAt
             FROM messages
             WHERE city = ?
               AND (senderUserId = ? OR recipientUserId = ?)
             GROUP BY otherUserId
           ) latest ON latest.otherUserId = u.id
           WHERE u.city = ?
             AND u.id <> ?
             AND (? IS NULL OR u.id <> ?)
           ORDER BY
             CASE WHEN latest.latestAt IS NULL THEN 1 ELSE 0 END ASC,
             datetime(latest.latestAt) DESC,
             lower(COALESCE(u.displayName, u.username, u.email, '')) ASC`,
          [
            currentUser.id,
            selectedCity,
            currentUser.id,
            selectedCity,
            currentUser.id,
            currentUser.id,
            currentUser.id,
            supportCircleUser?.id || null,
            supportCircleUser?.id || null
          ]
        );
        messageContacts = (messageContacts || []).filter((row) =>
          getUserAllowedCities(row, row?.city || "Enumclaw").includes(selectedCity)
        );
      } catch (_) {
        messageContacts = [];
      }

      if (supportCircleUser?.id && Number(supportCircleUser.id) !== Number(currentUser.id)) {
        try {
          const supportUnreadRow = await get(
            `SELECT COUNT(*) AS count
               FROM messages
              WHERE recipientUserId = ?
                AND senderUserId = ?
                AND city = ?
                AND readAt IS NULL`,
            [currentUser.id, supportCircleUser.id, selectedCity]
          );
          const supportLatestRow = await get(
            `SELECT MAX(datetime(createdAt)) AS latestAt
               FROM messages
              WHERE city = ?
                AND (
                  (senderUserId = ? AND recipientUserId = ?)
                  OR
                  (senderUserId = ? AND recipientUserId = ?)
                )`,
            [selectedCity, currentUser.id, supportCircleUser.id, supportCircleUser.id, currentUser.id]
          );
          const supportContact = {
            id: Number(supportCircleUser.id),
            email: supportCircleUser.email,
            username: supportCircleUser.username,
            displayName: "Support Circle",
            photoUrl: supportCircleUser.photoUrl,
            lastSeenAt: supportCircleUser.lastSeenAt,
            role: supportCircleUser.role,
            city: selectedCity,
            unreadCount: Number(supportUnreadRow?.count || 0),
            latestAt: supportLatestRow?.latestAt || null,
            supportAlias: 1,
            supportDescription: "Troubleshooting chat"
          };
          messageContacts = [
            supportContact,
            ...messageContacts.filter((row) => Number(row.id) !== Number(supportCircleUser.id))
          ];
        } catch (_) {
          messageContacts = [
            {
              id: Number(supportCircleUser.id),
              email: supportCircleUser.email,
              username: supportCircleUser.username,
              displayName: "Support Circle",
              photoUrl: supportCircleUser.photoUrl,
              lastSeenAt: supportCircleUser.lastSeenAt,
              role: supportCircleUser.role,
              city: selectedCity,
              unreadCount: 0,
              latestAt: null,
              supportAlias: 1,
              supportDescription: "Troubleshooting chat"
            },
            ...messageContacts.filter((row) => Number(row.id) !== Number(supportCircleUser.id))
          ];
        }
      }

      if (Number.isInteger(selectedMessageContactId) && messageContacts.some((row) => Number(row.id) === selectedMessageContactId)) {
        selectedMessageContact = messageContacts.find((row) => Number(row.id) === Number(selectedMessageContactId)) || null;
      }

      if (selectedMessageContactId && selectedMessageContact) {
        try {
          messageConversationRows = await all(
            `SELECT
               m.id,
               m.body,
               m.readAt,
               m.createdAt,
               m.senderUserId,
               m.recipientUserId,
               s.displayName AS senderDisplayName,
               s.username AS senderUsername,
               s.email AS senderEmail,
               s.photoUrl AS senderPhotoUrl
             FROM messages m
             LEFT JOIN users s ON s.id = m.senderUserId
             WHERE m.city = ?
               AND (
                 (m.senderUserId = ? AND m.recipientUserId = ?)
                 OR
                 (m.senderUserId = ? AND m.recipientUserId = ?)
               )
             ORDER BY datetime(m.createdAt) ASC`,
            [selectedCity, currentUser.id, selectedMessageContactId, selectedMessageContactId, currentUser.id]
          );
          await run(
            `UPDATE messages
                SET readAt = datetime('now')
              WHERE recipientUserId = ?
                AND senderUserId = ?
                AND city = ?
                AND readAt IS NULL`,
            [currentUser.id, selectedMessageContactId, selectedCity]
          );
          if (selectedMessageContact) selectedMessageContact.unreadCount = 0;
          unreadMessagesCount = Math.max(
            0,
            unreadMessagesCount - messageConversationRows.filter((row) => Number(row.recipientUserId) === Number(currentUser.id) && !row.readAt).length
          );
        } catch (_) {
          messageConversationRows = [];
        }
      }

      recentMessageThreads = messageContacts
        .filter((row) => row.latestAt || Number(row.unreadCount || 0) > 0)
        .slice(0, 5);
    }

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

    if (organizerOwnerClause) {
      whereParts.push(organizerOwnerClause.sql);
      whereParams.push(...organizerOwnerClause.params);
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
    if (isOrganizerUser && editEvent && !organizerOwnsEvent(editEvent, organizerAccessValues)) {
      return res.status(403).send("Forbidden");
    }
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
    const canFeatureEvents = hasDeveloperAccess || !!sectionPermissions.featureEvents;
    const canCurateEventPromotions = hasDeveloperAccess;
    const organizerFormValue = isOrganizerUser
      ? (organizerPrimaryName || String(editEvent?.organizer || ""))
      : String(editEvent?.organizer || "");

    // ✅ recurrence values for UI (these existed in your file, UI block was missing)
    const hasRecurrence = Number(editEvent?.hasRecurrence || 0) === 1;
    const rule = parseStoredRule(editEvent?.recurrenceRule) || { type: "none", interval: 1 };
    const ruleType = String(rule.type || (hasRecurrence ? "weekly" : "none")).toLowerCase();
    const eventStartLocalValue = toDateTimeLocalValue(editEvent?.startDateTime);
    const eventEndLocalValue = toDateTimeLocalValue(editEvent?.endDateTime);
    const inferredEventType = (function(){
      if (!editEvent) return "single";
      if (hasRecurrence) return "recurring";
      const startDate = String(eventStartLocalValue || "").slice(0, 10);
      const endDate = String(eventEndLocalValue || "").slice(0, 10);
      if (startDate && endDate && startDate !== endDate) return "multi-day";
      return "single";
    })();
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
    const displayEventStartLocalValue = eventStartLocalValue;
    const displayEventEndLocalValue = (function(){
      if (inferredEventType !== "recurring") return eventEndLocalValue;
      if (!recurrenceUntilDateVal) return eventEndLocalValue;
      const endTimePart = String(eventEndLocalValue || "").length >= 16 ? String(eventEndLocalValue).slice(10) : "T23:59";
      return `${recurrenceUntilDateVal}${endTimePart}`;
    })();
    const multiDaySchedule = normalizeMultiDaySchedule(editEvent?.multiDaySchedule);

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
    const showRecurringOptions = hasRecurrence;
    const showWeeklyOptions = hasRecurrence && ruleType === "weekly";
    const showMonthlyOptions = hasRecurrence && ruleType === "monthly";
    const showCustomOptions = hasRecurrence && ruleType === "custom";
    const showMonthdayOptions = showMonthlyOptions && monthlyMode === "monthday";
    const showNthWeekdayOptions = showMonthlyOptions && monthlyMode === "nthweekday";

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

    const allowedForUser = hasDeveloperAccess ? ADMIN_AREAS.slice() : userAllowedCities;
    const formCity = String(editEvent?.city || selectedCity);
    const cityOptions = allowedForUser.map((c) => {
      const sel = formCity === c ? "selected" : "";
      return `<option value="${esc(c)}" ${sel}>${esc(c)}</option>`;
    }).join("");
    const buildCitySwitchHref = (cityValue) => {
      const sp = new URLSearchParams(req.query || {});
      sp.set("city", cityValue);
      sp.delete("pg");
      const qs = sp.toString();
      return `${req.baseUrl || "/admin"}${req.path === "/" ? "" : (req.path || "")}${qs ? `?${qs}` : ""}`;
    };
    const cityListHtml = allowedForUser.map((c) => {
      const active = selectedCity === c ? " is-active" : "";
      return `<a class="sb-city-opt${active}" data-city="${esc(c)}" href="${esc(buildCitySwitchHref(c))}">${esc(c)}</a>`;
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
        ${canManageEvents ? `
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
  <div class="event-stats-action">
    <a class="btn" href="/admin/events-analytics?event=${encodeURIComponent(String(e.id))}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}">See Analytics</a>
  </div>
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
    if (organizerOwnerClause) {
      dashParts.push(organizerOwnerClause.sql);
      dashParams.push(...organizerOwnerClause.params);
    }

    const dashWhere = dashParts.length ? `WHERE ${dashParts.join(" AND ")}` : "";
    const dashWhereSql = dashWhere ? (dashWhere + " ") : "";
    const dashAnd = dashWhere ? (dashWhere + " AND ") : "WHERE ";
    const cityDashParts = dashParts.filter((part) => part !== organizerOwnerClause?.sql);
    const cityDashParams = organizerOwnerClause ? dashParams.slice(0, dashParams.length - organizerOwnerClause.params.length) : [...dashParams];
    const cityDashWhere = cityDashParts.length ? `WHERE ${cityDashParts.join(" AND ")}` : "";
    const cityDashWhereSql = cityDashWhere ? (cityDashWhere + " ") : "";


    // Counts
    const pastRow = await get(
      `SELECT COUNT(*) AS n FROM events ${dashAnd}datetime(startDateTime) < datetime('now')`,
      dashParams
    );
    const featuredRow = await get(`SELECT COUNT(*) AS n FROM events ${dashAnd}featured = 1`, dashParams);

    let upcoming = 0;
    let dashboardEventRows = [];
    const past = Number(pastRow?.n || 0);
    const featuredCount = Number(featuredRow?.n || 0);

    // Count occurrences for recurring events in headline metrics
    let totalOccurrences = 0;
    try {
      const occRows = await all(
        `SELECT id, title, slug, location, organizer, startDateTime, endDateTime, hasRecurrence, recurrenceRule, recurrenceDates, recurrenceStartDate, recurrenceUntilDate
         FROM events
         ${dashWhereSql}`,
        dashParams
      );
      dashboardEventRows = (occRows || []).map((row) => normalizeRowTimes(row));
      const nowMs = Date.now();
      const upcomingWindowEndMs = nowMs + 90 * 86400 * 1000;
      const currentYearEndMs = new Date(new Date().getFullYear(), 11, 31, 23, 59, 59, 999).getTime();

      totalOccurrences = dashboardEventRows.reduce((sum, row) => {
        const hasRec = hasRecurringData(row);
        if (!hasRec) return sum + 1;

        const startUtc = Date.parse(String(row?.startDateTime || ""));
        const totalWindowEndMs = getRecurringSeriesEndUtcMs(row, currentYearEndMs);
        const occ = generateAdminOccurrences(
          row,
          Number.isFinite(startUtc) ? startUtc : 0,
          totalWindowEndMs
        );
        return sum + Math.max(1, occ.length);
      }, 0);

      upcoming = dashboardEventRows.reduce((sum, row) => {
        const hasRec = hasRecurringData(row);
        if (!hasRec) {
          const startUtc = Date.parse(String(row?.startDateTime || ""));
          return sum + (Number.isFinite(startUtc) && startUtc >= nowMs ? 1 : 0);
        }
        const occ = generateAdminOccurrences(row, nowMs - 5 * 60 * 1000, upcomingWindowEndMs);
        return sum + occ.length;
      }, 0);
    } catch (_) {
      totalOccurrences = total;
      try {
        const fallbackRows = await all(
          `SELECT id, title, slug, location, organizer, startDateTime, endDateTime, hasRecurrence, recurrenceRule, recurrenceDates, recurrenceStartDate, recurrenceUntilDate
           FROM events
           ${dashWhereSql}`,
          dashParams
        );
        dashboardEventRows = (fallbackRows || []).map((row) => normalizeRowTimes(row));
      } catch (_) {}
      const upcomingRow = await get(
        `SELECT COUNT(*) AS n FROM events ${dashAnd}datetime(startDateTime) >= datetime('now')`,
        dashParams
      );
      upcoming = Number(upcomingRow?.n || 0);
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
      const sourceWhereParts = [];
      const sourceWhereParams = [];
      if (selectedCity) {
        sourceWhereParts.push("city = ?");
        sourceWhereParams.push(selectedCity);
      }
      if (organizerOwnerClause) {
        sourceWhereParts.push(organizerOwnerClause.sql);
        sourceWhereParams.push(...organizerOwnerClause.params);
      }
      const sourceEventWhereSql = sourceWhereParts.length ? `WHERE ${sourceWhereParts.join(" AND ")}` : "";
      const srcRow = await get(
        `SELECT
           COUNT(*) AS tracked,
           COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:direct%' OR COALESCE(ref,'') = '__direct__' OR trim(COALESCE(ref,'')) = '' THEN 1 ELSE 0 END), 0) AS directCount,
           COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:referral%' THEN 1 ELSE 0 END), 0) AS referralCount,
           COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:internal%' THEN 1 ELSE 0 END), 0) AS internalCount,
           COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:campaign%' THEN 1 ELSE 0 END), 0) AS campaignCount,
           COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:%' THEN 0 WHEN COALESCE(ref,'') = '__direct__' OR trim(COALESCE(ref,'')) = '' THEN 0 ELSE 1 END), 0) AS unknownCount
         FROM event_views
         WHERE eventId IN (SELECT id FROM events ${sourceEventWhereSql})`,
        sourceWhereParams
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

    const packageVersion = String(packageMeta?.version || "").trim();
    const appVersion = String(process.env.APP_VERSION || (packageVersion ? `v${packageVersion}` : "v0.0.0"));
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
    const trackedEventWhereParts = [];
    const trackedEventWhereParams = [];
    if (selectedCity) {
      trackedEventWhereParts.push("city = ?");
      trackedEventWhereParams.push(selectedCity);
    }
    if (organizerOwnerClause) {
      trackedEventWhereParts.push(organizerOwnerClause.sql);
      trackedEventWhereParams.push(...organizerOwnerClause.params);
    }
    const trackedEventWhereSql = trackedEventWhereParts.length ? `WHERE ${trackedEventWhereParts.join(" AND ")}` : "";
    const releaseLogItems = [];
    releaseLogItems.push({ date: "2026-05-05", text: "Events analytics charts now pull view-series activity from tracked event view data again and show a clear empty state when there is no recent activity" });
    releaseLogItems.push({ date: "2026-04-30", text: "All Events filters now submit as a real GET form so sort options like Newest ID first reliably reach the server" });
    releaseLogItems.push({ date: "2026-04-30", text: "All Events filters now preserve and apply the selected sort option again, including Newest ID first" });
    releaseLogItems.push({ date: "2026-04-30", text: "Multi-day event schedules now build correctly even when the start and end fields are using localized 12-hour date/time values" });
    releaseLogItems.push({ date: "2026-04-30", text: "Top event dashboard cards now use Pacific-time day, week, month, and year boundaries so today and this month no longer flip early on UTC" });
    releaseLogItems.push({ date: "2026-04-30", text: "Individual event insights now include a ticket-click counter, and events expose tracked ticket click endpoints for ticket button analytics" });
    releaseLogItems.push({ date: "2026-04-30", text: "Top event dashboard cards now rank all events by view activity during today, this week, this month, and this year instead of filtering by the event date itself" });
    releaseLogItems.push({ date: "2026-04-30", text: "All admin form fields now use the same sans-serif typeface, including the SEO inputs and textareas" });
    releaseLogItems.push({ date: "2026-04-16", text: "Organizer venue access is now limited to each organizer's own venues, and the dashboard app version now follows package.json automatically" });
    releaseLogItems.push({ date: "2026-04-14", text: "Profile status badge now hangs outside the avatar circle instead of sitting inside the crop" });
    releaseLogItems.push({ date: "2026-04-14", text: "Insights tabs now use the same rounded pill style as the calendar scope toggle" });
    releaseLogItems.push({ date: "2026-04-14", text: "Account dropdown action icons now use inline SVG and status rows no longer show helper text" });
    releaseLogItems.push({ date: "2026-04-14", text: "Account dropdown status rows now show only the label and the menu icons use stronger icon glyphs" });
    releaseLogItems.push({ date: "2026-04-13", text: "The header profile avatar now matches the other top-bar circles and the account dropdown opens reliably" });
    releaseLogItems.push({ date: "2026-04-13", text: "The header profile photo now uses a true circular trigger with a cleaner account dropdown layer for Preferences, status controls, and logout" });
    releaseLogItems.push({ date: "2026-04-13", text: "The header profile photo now opens an account menu with Preferences, availability status controls, and a logout shortcut" });
    releaseLogItems.push({ date: "2026-04-13", text: "The header profile photo now includes a small online-status badge anchored to the bottom-left of the avatar" });
    releaseLogItems.push({ date: "2026-04-13", text: "Dashboard calendar scope links and month arrows now fully override the generic anchor styling so both active and inactive states keep the intended neutral control colors" });
    releaseLogItems.push({ date: "2026-04-13", text: "Live role management now only exposes Developer and Organizer while leaving older role records intact" });
    releaseLogItems.push({ date: "2026-04-13", text: "Dashboard calendar now uses a single server-rendered navigation path so month arrows and selected-day details stay in sync" });
    releaseLogItems.push({ date: "2026-04-13", text: "Dashboard calendar scope toggle now uses the same neutral and green color language as the rest of the UI" });
    releaseLogItems.push({ date: "2026-04-13", text: "Dashboard calendar header is now simplified into a cleaner month, scope, and popularity layout" });
    releaseLogItems.push({ date: "2026-04-13", text: "Dashboard calendar now lets organizers and developers compare My Events against All Events in one place" });
    releaseLogItems.push({ date: "2026-04-13", text: "Dashboard calendar heat-scale contrast is now stronger so busy days stand out more clearly" });
    releaseLogItems.push({ date: "2026-04-13", text: "Dashboard calendar now uses a color intensity scale to show which days are busiest, with a legend for quick scanning" });
    releaseLogItems.push({ date: "2026-04-12", text: "Dashboard calendar day detail now uses the selected date itself as the header without the extra Selected day label" });
    releaseLogItems.push({ date: "2026-04-12", text: "Calendar day selection now restores your scroll position after reload instead of jumping back to the top" });
    releaseLogItems.push({ date: "2026-04-12", text: "Pagination now restores your scroll position after reload so paged views do not jump back to the top" });
    releaseLogItems.push({ date: "2026-04-12", text: "Dashboard calendar month arrows and selected-day list now stay synchronized through server-rendered navigation" });
    releaseLogItems.push({ date: "2026-04-12", text: "Dashboard calendar month navigation now safely falls back to the current month instead of zeroing out the grid" });
    releaseLogItems.push({ date: "2026-04-12", text: "Dashboard calendar now has previous and next month arrows for browsing different months" });
    releaseLogItems.push({ date: "2026-04-12", text: "Dashboard calendar now greys out past days while keeping them selectable" });
    releaseLogItems.push({ date: "2026-04-12", text: "Dashboard calendar now shows the selected month total in the header for a quicker at-a-glance count" });
    releaseLogItems.push({ date: "2026-04-12", text: "Dashboard calendar day counts now follow the actual event occurrence date instead of spreading one event across every day in its date range" });
    releaseLogItems.push({ date: "2026-04-11", text: "Developer organizer analytics now uses matching vertical gap spacing across both columns" });
    releaseLogItems.push({ date: "2026-04-11", text: "Developer organizer analytics row spacing is now tuned a little looser between the chart and leaderboard" });
    releaseLogItems.push({ date: "2026-04-11", text: "Developer organizer analytics now has a little more breathing room between the chart row and leaderboard row" });
    releaseLogItems.push({ date: "2026-04-11", text: "Developer organizer analytics now lets the chart card fill the top row so the empty gap under the chart is removed" });
    releaseLogItems.push({ date: "2026-04-11", text: "Dashboard calendar now carries real event titles into the selected-day list instead of falling back to untitled placeholders" });
    releaseLogItems.push({ date: "2026-04-11", text: "Dashboard calendar now gives the month view more room by moving selected-day events underneath it and paging long event days" });
    releaseLogItems.push({ date: "2026-04-11", text: "Dashboard now includes a calendar tile so you can preview what events are happening on a selected day and across that week at a glance" });
    releaseLogItems.push({ date: "2026-04-11", text: "Dashboard activity now always keeps recent event posts represented in the 5-item feed, including your own latest event when available" });
    releaseLogItems.push({ date: "2026-04-10", text: "Fixed an event-save server error caused by duplicate-save checks reading normalized event values before they were initialized" });
    releaseLogItems.push({ date: "2026-04-10", text: "Dashboard activity now keeps your most recent published event visible in the 5-item feed instead of letting mixed content push it out" });
    releaseLogItems.push({ date: "2026-04-10", text: "Organizer event analytics tooltips now show both My events and City events so citywide daily counts are visible alongside organizer-specific totals" });
    releaseLogItems.push({ date: "2026-04-10", text: "Events analytics now counts same-day events correctly even when older rows use simpler stored date/time formats" });
    releaseLogItems.push({ date: "2026-04-10", text: "Duplicate event warnings now include a direct Save Anyway action so you can confirm and continue without going back to re-check the form" });
    releaseLogItems.push({ date: "2026-04-10", text: "Messages now show a live typing indicator while another person is actively composing in the same conversation" });
    releaseLogItems.push({ date: "2026-04-10", text: "Fixed an event-save server error and organizer accounts can now submit recurring events without the save flow forcing recurrence back off" });
    releaseLogItems.push({ date: "2026-04-10", text: "Organizer accounts can now create recurring events again alongside single and multi-day event types" });
    releaseLogItems.push({ date: "2026-04-10", text: "Multi-Day Event setup now supports optional per-day time ranges while keeping the existing event start/end fields and API responses compatible with current event data and WordPress integrations" });
    releaseLogItems.push({ date: "2026-04-10", text: "Recurring event setup now uses the top Start and End fields as the only date inputs while preserving the same stored recurrence data for existing events and WordPress integrations" });
    releaseLogItems.push({ date: "2026-04-10", text: "Create Event now begins with Single Event, Multi-Day Event, and Recurring Event choices so the matching form stays hidden until an event type is selected" });
    releaseLogItems.push({ date: "2026-04-09", text: "Dashboard activity cards now show only the 5 most recent items instead of growing taller with a longer mixed feed" });
    releaseLogItems.push({ date: "2026-04-09", text: "Organizer event submission now auto-generates SEO fields and temporarily removes recurring-event controls from organizer workflows" });
    releaseLogItems.push({ date: "2026-04-09", text: "Messages now show a simple checkmark and Read label once a sent message has been opened" });
    releaseLogItems.push({ date: "2026-04-09", text: "Support Circle now appears in messages as a built-in troubleshooting chat that routes directly to support without exposing a personal name" });
    releaseLogItems.push({ date: "2026-04-09", text: "Uploaded images now keep the full frame with a neutral grey background instead of being cropped to fill" });
    releaseLogItems.push({ date: "2026-04-09", text: "Organizer dashboard quick links now use a single full-width events column" });
    releaseLogItems.push({ date: "2026-04-09", text: "Organizer users now land on their dashboard instead of being redirected straight into My Events" });
    releaseLogItems.push({ date: "2026-04-09", text: "Organizer dashboards now focus on event-only quick links, messages, activity, release notes, and event insights scoped to that organizer" });
    releaseLogItems.push({ date: "2026-04-09", text: "The organizer-only events analytics page now uses the same row gap below the chart card as the gap above it" });
    releaseLogItems.push({ date: "2026-04-09", text: "The API root URL now redirects directly to /admin" });
    releaseLogItems.push({ date: "2026-04-09", text: "Organizer event analytics now uses the same card spacing below the chart row as the spacing above it" });
    releaseLogItems.push({ date: "2026-04-09", text: "Organizer event analytics now uses the same visual gap below the chart row as the gap above it" });
    releaseLogItems.push({ date: "2026-04-09", text: "Organizer event analytics now collapses to the chart's natural height instead of leaving a large gap before the top-events row" });
    releaseLogItems.push({ date: "2026-04-09", text: "Admin header search now fills the available left-side space without leaving a large gap before the icon buttons" });
    releaseLogItems.push({ date: "2026-04-09", text: "Organizer users now see a full-width events analytics chart without the top organizers side card" });
    releaseLogItems.push({ date: "2026-04-09", text: "Organizer users no longer see organizer analytics in the sidebar or have direct access to that page" });
    releaseLogItems.push({ date: "2026-04-09", text: "Organizer users now see only Dashboard, Events, Analytics, and Admin in the sidebar" });
    releaseLogItems.push({ date: "2026-04-09", text: "Event and organizer charts now always show Events as the main line with Views as the blue dotted comparison, without a metric toggle" });
    releaseLogItems.push({ date: "2026-04-08", text: "Header search now stretches fully toward the icon cluster instead of leaving a large empty gap" });
    releaseLogItems.push({ date: "2026-04-08", text: "Header username label removed so the top-right controls stay cleaner and more compact" });
    releaseLogItems.push({ date: "2026-04-08", text: "Header messages now uses the same icon-button style as notifications and sits beside it" });
    releaseLogItems.push({ date: "2026-04-08", text: "Admin header search now replaces the old title and helper block on the left across pages" });
    releaseLogItems.push({ date: "2026-04-08", text: "Organizer chart now expands to match the organizer overview card height so the left panel no longer ends with a blank gap" });
    releaseLogItems.push({ date: "2026-04-08", text: "Organizer chart no longer stretches to match the taller overview card, removing the large blank space below it" });
    releaseLogItems.push({ date: "2026-04-08", text: "Organizer chart row cards now top-align instead of stretching to the tallest column, removing the large gap below the chart" });
    releaseLogItems.push({ date: "2026-04-08", text: "Organizer spacing now only pulls the Top 10 organizers card upward without shifting the right-side card" });
    releaseLogItems.push({ date: "2026-04-08", text: "Organizer lower sections now sit much closer to the chart row with the extra gap removed" });
    releaseLogItems.push({ date: "2026-04-08", text: "Organizer leaderboard sections now sit tighter to the content above them without affecting the main analytics row" });
    releaseLogItems.push({ date: "2026-04-08", text: "Reverted the organizer spacing tweak that had leaked into the main analytics row" });
    releaseLogItems.push({ date: "2026-04-08", text: "Organizer analytics no longer shows a redundant standalone views summary card" });
    releaseLogItems.push({ date: "2026-04-08", text: "Dashboard activity now uses the shared role permissions early so the feed no longer blanks before rendering" });
    releaseLogItems.push({ date: "2026-04-08", text: "Dashboard activity now loads each content type independently so one bad query cannot blank the whole feed" });
    releaseLogItems.push({ date: "2026-04-08", text: "Message panes now top-align contacts and conversation bubbles instead of stretching them vertically" });
    releaseLogItems.push({ date: "2026-04-08", text: "Messages now use a fixed-height full-screen layout with scrolling panes instead of growing taller with each message" });
    releaseLogItems.push({ date: "2026-04-07", text: "Dashboard activity now fails safely so one schema mismatch cannot break the whole admin home page" });
    releaseLogItems.push({ date: "2026-04-07", text: "Dashboard activity now keeps a balanced mix of content types so recent events do not get crowded out" });
    releaseLogItems.push({ date: "2026-04-07", text: "Dashboard activity now falls back cleanly so published events still appear even on older event schemas" });
    releaseLogItems.push({ date: "2026-04-07", text: "Dashboard activity now includes recent pending event submissions alongside published content" });
    releaseLogItems.push({ date: "2026-04-07", text: "Dashboard activity now shows events alongside venues, jobs, and ads with posted-by usernames" });
    releaseLogItems.push({ date: "2026-04-07", text: "Dashboard quick-link groups now pin shorter link stacks to the top for cleaner alignment" });
    releaseLogItems.push({ date: "2026-04-07", text: "Dashboard now includes an Activity feed for recently posted events, venues, jobs, and ads" });
    releaseLogItems.push({ date: "2026-04-07", text: "Dashboard insights now live in one switchable card, and new messages trigger live notification dings" });
    releaseLogItems.push({ date: "2026-04-07", text: "Added city-scoped messaging with online status, header access, and dashboard inbox preview" });
    releaseLogItems.push({ date: "2026-04-07", text: "Dashboard quick links now show only the three most important actions per section" });
    releaseLogItems.push({ date: "2026-04-07", text: "Dashboard quick links are back to a simpler module-based layout without a separate Analytics section" });
    releaseLogItems.push({ date: "2026-04-07", text: "Content tabs now default cleanly to their main pages so analytics no longer shows a double-active sidebar state" });
    releaseLogItems.push({ date: "2026-04-07", text: "Analytics menu now uses simpler labels, a better icon, and the order Events, Organizers, Venues, Jobs, Ads" });
    releaseLogItems.push({ date: "2026-04-07", text: "Moved analytics into a dedicated Analytics tab and tailored dashboard sections by role" });
    releaseLogItems.push({ date: "2026-04-07", text: "Renamed Admin to Developer and added Area Manager role with a five-invite cap" });
    releaseLogItems.push({ date: "2026-04-07", text: "Added organizer user role with organizer-only event access and analytics" });
    releaseLogItems.push({ date: "2026-04-07", text: "Selected organizer insights now swap the top-10 table for linked top events" });
    releaseLogItems.push({ date: "2026-04-07", text: "Single-event insight grey panels now stretch to fit the card space better" });
    releaseLogItems.push({ date: "2026-04-07", text: "Removed the extra helper note from single-event insight panels" });
    releaseLogItems.push({ date: "2026-04-07", text: "Single-event insight panels now show Going and Interested counts" });
    releaseLogItems.push({ date: "2026-04-07", text: "Event stats panels can now grow slightly so the analytics button stays fully inside the grey box" });
    releaseLogItems.push({ date: "2026-04-07", text: "Event card analytics button height reduced to fit cleanly inside the stats panel" });
    releaseLogItems.push({ date: "2026-04-07", text: "Single-event analytics now shows only event-specific source stats in the top metric row" });
    releaseLogItems.push({ date: "2026-04-07", text: "Event card analytics button now stays contained inside the stats panel" });
    releaseLogItems.push({ date: "2026-04-07", text: "Event list cards now include a See Analytics button under the stats panel" });
    releaseLogItems.push({ date: "2026-04-07", text: "Top event cards now link into individual event analytics insights" });
    releaseLogItems.push({ date: "2026-04-07", text: "Header spacing now only increases between the search bar and account name, not between account icons" });
    releaseLogItems.push({ date: "2026-04-07", text: "Header search bar now stays visible across all admin tabs" });
    releaseLogItems.push({ date: "2026-04-07", text: "Header search now uses Enter to submit and has more spacing before the account name" });
    releaseLogItems.push({ date: "2026-04-07", text: "Organizer analytics now defaults to overall performance with linked organizer drill-down insights" });
    releaseLogItems.push({ date: "2026-04-07", text: "Increased the events chart card height again to line up with top organizers" });
    releaseLogItems.push({ date: "2026-04-07", text: "Moved the chart range text inline with the legend and restored the chart card height to match organizers" });
    releaseLogItems.push({ date: "2026-04-07", text: "Fixed total events overcounting by using real recurrence end dates instead of a 10-year fallback" });
    releaseLogItems.push({ date: "2026-04-07", text: "Moved the events chart legend inline with the metric toggle to free up chart height" });
    releaseLogItems.push({ date: "2026-04-07", text: "Events analytics now uses the same recurrence window rules as the public event feed" });
    releaseLogItems.push({ date: "2026-04-07", text: "Events analytics now uses the same legacy timezone normalization as the public event feed" });
    releaseLogItems.push({ date: "2026-04-07", text: "Events analytics now counts recurring rows from actual recurrence data even when flags are inconsistent" });
    releaseLogItems.push({ date: "2026-04-07", text: "Events analytics now counts recurring events even when legacy rows are missing end times" });
    releaseLogItems.push({ date: "2026-04-07", text: "Reduced the main analytics card and chart height to match the organizer card" });
    releaseLogItems.push({ date: "2026-04-07", text: "Matched top organizers card height and spacing to the top events cards" });
    releaseLogItems.push({ date: "2026-04-07", text: "Fixed top events cards so short lists stack normally instead of stretching" });
    releaseLogItems.push({ date: "2026-04-07", text: "Fixed admin login crash caused by dashboard event view timestamp query" });
    releaseLogItems.push({ date: "2026-04-07", text: "Top events today now ranks all events by today's view activity" });
    releaseLogItems.push({ date: "2026-04-07", text: "Top event cards now use the same vertical spacing as top organizers" });
    releaseLogItems.push({ date: "2026-04-06", text: "Events analytics now shows total events before unique events" });
    releaseLogItems.push({ date: "2026-04-06", text: "Removed label badges from events analytics summary cards" });
    releaseLogItems.push({ date: "2026-04-06", text: "Events analytics now shows unique events in the first row and all views in the second row" });
    releaseLogItems.push({ date: "2026-04-06", text: "Removed duplicate total views card from events analytics" });
    releaseLogItems.push({ date: "2026-04-06", text: "Total events card now uses recurrence-aware occurrence totals" });
    releaseLogItems.push({ date: "2026-04-06", text: "Events source cards now start with all views instead of campaign views" });
    releaseLogItems.push({ date: "2026-04-06", text: "Headline event totals now include recurring instances" });
    releaseLogItems.push({ date: "2026-04-06", text: "Source view cards now include archived and past events in lifetime totals" });
    releaseLogItems.push({ date: "2026-04-06", text: "Events analytics now counts recurring event instances by occurrence date" });
    releaseLogItems.push({ date: "2026-04-06", text: "All chart headlines now stay on one line" });
    releaseLogItems.push({ date: "2026-04-06", text: "Venue and ad charts now match the main events chart style" });
    releaseLogItems.push({ date: "2026-04-06", text: "Events analytics range label now stays on one line" });
    releaseLogItems.push({ date: "2026-04-06", text: "Events analytics now uses a line legend instead of past and upcoming counts" });
    releaseLogItems.push({ date: "2026-04-06", text: "Analytics row height increased so top organizers fits without scrolling" });
    releaseLogItems.push({ date: "2026-04-06", text: "Top organizers list now shows only the top 5" });
    releaseLogItems.push({ date: "2026-04-06", text: "Top organizers card height now capped with internal scroll" });
    releaseLogItems.push({ date: "2026-04-06", text: "Main analytics row height reduced again" });
    releaseLogItems.push({ date: "2026-04-06", text: "Top organizers card now matches analytics chart height" });
    releaseLogItems.push({ date: "2026-04-06", text: "Main events analytics section set closer to 500px tall" });
    releaseLogItems.push({ date: "2026-04-06", text: "Main events analytics chart height reduced further" });
    releaseLogItems.push({ date: "2026-04-06", text: "Main events analytics chart height reduced" });
    releaseLogItems.push({ date: "2026-04-06", text: "Events analytics tooltip now labels the highlighted time period" });
    releaseLogItems.push({ date: "2026-04-06", text: "Events analytics now shows events and views together with solid and dashed lines" });
    releaseLogItems.push({ date: "2026-04-06", text: "Analytics highlight dots now sit directly on the chart line" });
    releaseLogItems.push({ date: "2026-04-06", text: "Analytics line charts now show point dots only on highlight" });
    releaseLogItems.push({ date: "2026-04-06", text: "Analytics charts now use a cleaner line-chart style" });
    releaseLogItems.push({ date: "2026-04-04", text: "Collapsed dashboard headers now use even vertical padding" });
    releaseLogItems.push({ date: "2026-04-04", text: "Collapsed dashboard cards now shrink to content height" });
    releaseLogItems.push({ date: "2026-04-04", text: "Dashboard release note removed duplicate date label" });
    releaseLogItems.push({ date: "2026-04-04", text: "Dashboard release note text left aligned" });
    releaseLogItems.push({ date: "2026-04-04", text: "Login password field now shows placeholder text" });
    releaseLogItems.push({ date: "2026-03-25", text: "Dashboard ad insights now load live ad metrics" });
    releaseLogItems.push({ date: "2026-03-25", text: "Dashboard job insights replaced with ad insights" });
    releaseLogItems.push({ date: "2026-03-25", text: "Ads support multiple placement selections" });
    releaseLogItems.push({ date: "2026-03-25", text: "Ads placement dropdown with standard placement options" });
    releaseLogItems.push({ date: "2026-03-25", text: "Global nested corner radius system across admin pages" });
    releaseLogItems.push({ date: "2026-03-25", text: "Three-layer quick-link corner radius math fix" });
    releaseLogItems.push({ date: "2026-03-25", text: "Release Notes menu and dated release history" });
    releaseLogItems.push({ date: "2026-03-25", text: "Dashboard release notes now show only the latest update" });
    releaseLogItems.push({ date: "2026-03-24", text: "Mobile admin list layout cleanup" });
    releaseLogItems.push({ date: "2026-03-24", text: "Upload review panel" });
    releaseLogItems.push({ date: "2026-03-24", text: "Event import template download" });
    releaseLogItems.push({ date: "2026-03-24", text: "CSV fields aligned to event form" });
    releaseLogItems.push({ date: "2026-03-24", text: "Dedicated upload events page" });
    releaseLogItems.push({ date: "2026-03-24", text: "CSV + ZIP event image import" });
    releaseLogItems.push({ date: "2026-03-24", text: "CSV event bulk import" });
    releaseLogItems.push({ date: "2026-03-24", text: "Canonical job employment types" });
    releaseLogItems.push({ date: "2026-03-24", text: "Multi-type job postings" });
    releaseLogItems.push({ date: "2026-03-24", text: "Website job applications" });
    releaseLogItems.push({ date: "2026-03-24", text: "Configurable job application fields" });
    releaseLogItems.push({ date: "2026-03-24", text: "Public jobs JSON feed" });
    releaseLogItems.push({ date: "2026-03-24", text: "Jobs JSON link" });
    releaseLogItems.push({ date: "2026-03-23", text: "Ads module" });
    releaseLogItems.push({ date: "2026-03-23", text: "Mobile sidebar" });
    releaseLogItems.push({ date: "2026-03-23", text: "Duplicate event detection" });
    releaseLogItems.push({ date: "2026-03-23", text: "Venue analytics graph" });
    if (hasVenueTable) {
      releaseLogItems.push({ date: "2026-03-18", text: "Venues module" });
    }
    if (hasJobsTable) {
      releaseLogItems.push({ date: "2026-03-18", text: "Jobs module" });
    }
    if (hasApplicantsTable) {
      releaseLogItems.push({ date: "2026-03-18", text: "Applicants" });
    }
    if (hasSourceTrackingTable) {
      releaseLogItems.push({ date: "2026-03-18", text: "Source tracking" });
    }
    releaseLogItems.push({ date: "2026-03-18", text: "Dashboard release notes" });
    const latestRelease = releaseLogItems[0] || { date: releaseUpdatedAt.slice(0, 10), text: "Dashboard release notes" };
    const releaseSummary = String(process.env.RELEASE_NOTES || latestRelease.text);

    const reqCount5m = Array.isArray(req.app?.locals?.reqTimes)
      ? req.app.locals.reqTimes.length
      : 0;
    const sourcePct = (n) => {
      if (!sourceTracked) return "0%";
      return Math.round((Number(n || 0) / sourceTracked) * 100) + "%";
    };

    const stats = {
      uniqueTotal: fmt(total),
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

    let dashboardCalendarHtml = `<div class="muted">No events found for this calendar view.</div>`;
    try {
      const calendarPageSize = 5;
      const canCompareCalendarScopes = hasDeveloperAccess || isOrganizerUser;
      const requestedCalendarScope = String(req.query.calScope || "").trim();
      const defaultCalendarScope = isOrganizerUser ? "my" : "all";
      const calendarScope = canCompareCalendarScopes
        ? (requestedCalendarScope === "my" || requestedCalendarScope === "all" ? requestedCalendarScope : defaultCalendarScope)
        : "all";
      const nowParts = getZonedDateParts(new Date(), DEFAULT_TZ);
      const fallbackTodayYmd = new Date().toISOString().slice(0, 10);
      const todayYmd = nowParts?.ymd || fallbackTodayYmd;
      const defaultMonthStartYmd = todayYmd ? `${String(todayYmd).slice(0, 7)}-01` : "";
      const requestedMonthYmd = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.calMonth || "").trim())
        ? `${String(req.query.calMonth).trim().slice(0, 7)}-01`
        : defaultMonthStartYmd;
      const monthStartParts = /^\d{4}-\d{2}-\d{2}$/.test(requestedMonthYmd)
        ? requestedMonthYmd.split("-").map(Number)
        : null;
      const monthStartDate = monthStartParts
        ? new Date(Date.UTC(monthStartParts[0], monthStartParts[1] - 1, 1, 12, 0, 0))
        : null;
      const calendarMinMonthYmd = defaultMonthStartYmd ? addMonthsToYmd(defaultMonthStartYmd, -12) : "";
      const calendarMaxMonthYmd = defaultMonthStartYmd ? addMonthsToYmd(defaultMonthStartYmd, 12) : "";
      const gridStartYmd = calendarMinMonthYmd ? startOfWeekYmd(calendarMinMonthYmd) : "";
      const lastGridStartYmd = calendarMaxMonthYmd ? startOfWeekYmd(calendarMaxMonthYmd) : "";
      const gridEndYmd = lastGridStartYmd ? addDaysToYmd(lastGridStartYmd, 41) : "";
      const windowStartMs = gridStartYmd ? Date.parse(`${gridStartYmd}T00:00:00-08:00`) : 0;
      const windowEndMs = gridEndYmd ? Date.parse(`${gridEndYmd}T23:59:59-07:00`) : 0;
      const dayMap = new Map();
      const calendarWhereParts = [];
      const calendarWhereParams = [];
      if (selectedCity) {
        calendarWhereParts.push("city = ?");
        calendarWhereParams.push(selectedCity);
      }
      if (calendarScope === "my") {
        if (isOrganizerUser && organizerOwnerClause) {
          calendarWhereParts.push(organizerOwnerClause.sql);
          calendarWhereParams.push(...organizerOwnerClause.params);
        } else if (hasDeveloperAccess && currentUser?.id) {
          calendarWhereParts.push("createdByUserId = ?");
          calendarWhereParams.push(Number(currentUser.id));
        }
      }
      const calendarWhereSql = calendarWhereParts.length ? `WHERE ${calendarWhereParts.join(" AND ")}` : "";
      let calendarEventRows = dashboardEventRows;
      try {
        const calendarRows = await all(
          `SELECT id, title, slug, location, organizer, startDateTime, endDateTime, hasRecurrence, recurrenceRule, recurrenceDates, recurrenceStartDate, recurrenceUntilDate, createdByUserId
           FROM events
           ${calendarWhereSql ? `${calendarWhereSql} ` : ""}`,
          calendarWhereParams
        );
        calendarEventRows = (calendarRows || []).map((row) => normalizeRowTimes(row));
      } catch (_) {}
      const totalGridDays = gridStartYmd && gridEndYmd
        ? Math.max(0, Math.round((Date.parse(`${gridEndYmd}T12:00:00Z`) - Date.parse(`${gridStartYmd}T12:00:00Z`)) / 86400000)) + 1
        : 0;
      for (let i = 0; i < totalGridDays; i++) {
        const ymd = addDaysToYmd(gridStartYmd, i);
        if (!ymd) continue;
        dayMap.set(ymd, []);
      }

      const dayEntryKeys = new Map();
      const pushEventToDay = (ymd, entry) => {
        if (!dayMap.has(ymd)) return;
        const dedupeKey = String(entry?.dedupeKey || "");
        if (dedupeKey) {
          if (!dayEntryKeys.has(ymd)) dayEntryKeys.set(ymd, new Set());
          const dayKeys = dayEntryKeys.get(ymd);
          if (dayKeys.has(dedupeKey)) return;
          dayKeys.add(dedupeKey);
        }
        dayMap.get(ymd).push(entry);
      };

      for (const row of calendarEventRows) {
        const title = String(row?.title || "Untitled event");
        const location = String(row?.location || row?.organizer || selectedCity || "").trim();
        const slugOrId = row?.slug || row?.title || row?.id;
        const href = buildActivityHref("/admin/existing-events", slugOrId);
        const occurrences = hasRecurringData(row)
          ? generateAdminOccurrences(row, windowStartMs, windowEndMs)
          : [{
              occurrenceDate: String(parseIsoParts(row?.startDateTime || "") ? toYmd(parseIsoParts(row?.startDateTime || "")) : ""),
              startDateTime: row?.startDateTime || "",
              endDateTime: row?.endDateTime || row?.startDateTime || "",
              parts: parseIsoParts(row?.startDateTime || ""),
            }];

        for (const occ of occurrences) {
          const startIso = String(occ?.startDateTime || row?.startDateTime || "").trim();
          const startParts = parseIsoParts(startIso);
          const dayKey = String(occ?.occurrenceDate || (startParts ? toYmd(startParts) : "")).trim();
          if (!dayKey) continue;
          const timeLabel = startParts
            ? new Date(Date.UTC(startParts.year, startParts.month - 1, startParts.day, startParts.hour, startParts.minute, 0)).toLocaleTimeString("en-US", {
                hour: "numeric",
                minute: "2-digit",
                hour12: true,
                timeZone: "UTC",
              }).replace(":00 ", " ")
            : "";
          const entry = {
            title,
            location,
            href,
            timeLabel,
            sortKey: startIso,
            dedupeKey: `${row?.id || title}|${dayKey}|${startIso}`,
          };
          pushEventToDay(dayKey, entry);
        }
      }

      const weekdayLabels = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
      const monthLabel = monthStartDate
        ? monthStartDate.toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "UTC" })
        : "This month";
      let selectedDayYmd = "";
      const requestedDayYmd = /^\d{4}-\d{2}-\d{2}$/.test(String(req.query.calDay || "").trim())
        ? String(req.query.calDay).trim()
        : "";
      if (requestedDayYmd && requestedDayYmd.slice(0, 7) === String(requestedMonthYmd).slice(0, 7) && dayMap.has(requestedDayYmd)) {
        selectedDayYmd = requestedDayYmd;
      } else if (todayYmd && todayYmd.slice(0, 7) === String(requestedMonthYmd).slice(0, 7) && dayMap.has(todayYmd)) {
        selectedDayYmd = todayYmd;
      } else if (requestedMonthYmd && dayMap.has(requestedMonthYmd)) {
        selectedDayYmd = requestedMonthYmd;
      } else {
        selectedDayYmd = Array.from(dayMap.keys()).find((ymd) => String(ymd).slice(0, 7) === String(requestedMonthYmd).slice(0, 7)) || Array.from(dayMap.keys())[0] || todayYmd;
      }
      const currentMonthGridStart = requestedMonthYmd ? startOfWeekYmd(requestedMonthYmd) : "";
      const calendarDays = Array.from({ length: 42 }, (_, index) => {
        const ymd = addDaysToYmd(currentMonthGridStart, index);
        const entries = Array.isArray(dayMap.get(ymd)) ? dayMap.get(ymd) : [];
        const [year, month, day] = ymd.split("-").map(Number);
        return {
          ymd,
          day,
          inMonth: month === (monthStartParts ? monthStartParts[1] : nowParts.month),
          isToday: ymd === todayYmd,
          isPast: ymd < todayYmd,
          count: entries.length,
        };
      });
      const inMonthDays = calendarDays.filter((day) => day.inMonth);
      const monthMaxCount = inMonthDays.reduce((max, day) => Math.max(max, Number(day.count || 0)), 0);
      const calendarDaysWithHeat = calendarDays.map((day) => {
        const count = Number(day.count || 0);
        let heatLevel = 0;
        if (day.inMonth && monthMaxCount > 0 && count > 0) {
          const ratio = count / monthMaxCount;
          if (ratio >= 0.85) heatLevel = 4;
          else if (ratio >= 0.6) heatLevel = 3;
          else if (ratio >= 0.35) heatLevel = 2;
          else heatLevel = 1;
        }
        return {
          ...day,
          heatLevel,
        };
      });
      const monthTotalCount = calendarDaysWithHeat.reduce((sum, day) => sum + (day.inMonth ? Number(day.count || 0) : 0), 0);
      const calendarAgenda = {};
      for (const [ymd, entries] of dayMap.entries()) {
        calendarAgenda[ymd] = entries
          .slice()
          .sort((a, b) => String(a.sortKey || "").localeCompare(String(b.sortKey || "")))
          .map(({ sortKey, ...entry }) => entry);
      }
      const selectedDayEntries = Array.isArray(calendarAgenda[selectedDayYmd]) ? calendarAgenda[selectedDayYmd] : [];
      const selectedPageRaw = parseInt(String(req.query.calPage || "1"), 10);
      const selectedDayTotalPages = Math.max(1, Math.ceil(selectedDayEntries.length / calendarPageSize));
      const selectedDayPage = Math.max(1, Math.min(selectedDayTotalPages, Number.isFinite(selectedPageRaw) ? selectedPageRaw : 1));
      const selectedVisibleEntries = selectedDayEntries.slice((selectedDayPage - 1) * calendarPageSize, selectedDayPage * calendarPageSize);
      const calendarNavParams = new URLSearchParams();
      for (const [key, value] of Object.entries(req.query || {})) {
        if (value == null) continue;
        if (Array.isArray(value)) {
          for (const item of value) calendarNavParams.append(key, String(item));
        } else {
          calendarNavParams.set(key, String(value));
        }
      }
      const buildCalendarHref = (updates = {}) => {
        const sp = new URLSearchParams(calendarNavParams.toString());
        for (const [key, value] of Object.entries(updates)) {
          if (value == null || value === "") sp.delete(key);
          else sp.set(key, String(value));
        }
        const qs = sp.toString();
        return `/admin${qs ? `?${qs}` : ""}`;
      };
      const prevMonthYmd = requestedMonthYmd ? addMonthsToYmd(requestedMonthYmd, -1) : "";
      const nextMonthYmd = requestedMonthYmd ? addMonthsToYmd(requestedMonthYmd, 1) : "";
      const prevMonthHref = buildCalendarHref({ calMonth: prevMonthYmd, calDay: prevMonthYmd, calPage: null });
      const nextMonthHref = buildCalendarHref({ calMonth: nextMonthYmd, calDay: nextMonthYmd, calPage: null });
      const allEventsHref = buildCalendarHref({ calScope: "all", calPage: null });
      const myEventsHref = buildCalendarHref({ calScope: "my", calPage: null });
      const selectedDayLabel = /^\d{4}-\d{2}-\d{2}$/.test(String(selectedDayYmd || ""))
        ? new Date(`${selectedDayYmd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" })
        : "No day selected";

      dashboardCalendarHtml = `
        <div class="dashboard-calendar" id="dashboardCalendarTile">
          <div class="dashboard-calendar-main">
            <div class="dashboard-calendar-head">
              <div class="dashboard-calendar-head-top">
                <div class="dashboard-calendar-head-left">
                  <div class="dashboard-calendar-month-row">
                    <a class="dashboard-calendar-nav" href="${esc(prevMonthHref)}" aria-label="Previous month">‹</a>
                    <div class="dashboard-calendar-month">${esc(monthLabel)}</div>
                    <a class="dashboard-calendar-nav" href="${esc(nextMonthHref)}" aria-label="Next month">›</a>
                  </div>
                </div>
                <div class="dashboard-calendar-total">
                  <span class="dashboard-calendar-total-label">Month total</span>
                  <span class="dashboard-calendar-total-value">${monthTotalCount.toLocaleString("en-US")}</span>
                </div>
              </div>
              <div class="dashboard-calendar-toolbar">
                ${canCompareCalendarScopes ? `
                  <div class="dashboard-calendar-scope-toggle" role="tablist" aria-label="Calendar event scope">
                    <a class="dashboard-calendar-scope-btn${calendarScope === "my" ? " active" : ""}" href="${esc(myEventsHref)}">My Events</a>
                    <a class="dashboard-calendar-scope-btn${calendarScope === "all" ? " active" : ""}" href="${esc(allEventsHref)}">All Events</a>
                  </div>
                ` : `<div></div>`}
                <div class="dashboard-calendar-legend" aria-label="Calendar event density legend">
                  <span class="dashboard-calendar-legend-label">Popularity</span>
                  <span class="dashboard-calendar-legend-scale">
                    <span class="dashboard-calendar-legend-swatch level-1"></span>
                    <span class="dashboard-calendar-legend-swatch level-2"></span>
                    <span class="dashboard-calendar-legend-swatch level-3"></span>
                    <span class="dashboard-calendar-legend-swatch level-4"></span>
                  </span>
                  <span class="dashboard-calendar-legend-range">Less to more events</span>
                </div>
              </div>
            </div>
            <div class="dashboard-calendar-weekdays">
              ${weekdayLabels.map((label) => `<div>${esc(label)}</div>`).join("")}
            </div>
            <div class="dashboard-calendar-grid">
              ${calendarDaysWithHeat.map((day) => `
                <a
                  href="${esc(buildCalendarHref({ calMonth: `${String(day.ymd).slice(0, 7)}-01`, calDay: day.ymd, calPage: null }))}"
                  class="dashboard-calendar-day${day.inMonth ? "" : " is-outside"}${day.isToday ? " is-today" : ""}${day.isPast ? " is-past" : ""}${day.ymd === selectedDayYmd ? " is-selected" : ""}${day.heatLevel ? ` heat-${day.heatLevel}` : ""}"
                >
                  <span class="dashboard-calendar-daynum">${esc(day.day)}</span>
                  <span class="dashboard-calendar-daycount">${day.count ? `${esc(day.count)} event${day.count === 1 ? "" : "s"}` : "No events"}</span>
                </a>
              `).join("")}
            </div>
          </div>
          <div class="dashboard-calendar-panel dashboard-calendar-detail">
            <div class="dashboard-calendar-detail-head">
              <div>
                <div class="dashboard-calendar-panel-title">${esc(selectedDayLabel)}</div>
              </div>
              <div class="dashboard-calendar-pager"${selectedDayTotalPages > 1 ? "" : ` style="display:none;"`}>
                <a class="btn${selectedDayPage <= 1 ? " is-disabled" : ""}" ${selectedDayPage <= 1 ? `aria-disabled="true"` : `href="${esc(buildCalendarHref({ calMonth: requestedMonthYmd, calDay: selectedDayYmd, calPage: selectedDayPage - 1 }))}"`}>Prev</a>
                <span class="muted small">Page ${selectedDayPage} / ${selectedDayTotalPages}</span>
                <a class="btn${selectedDayPage >= selectedDayTotalPages ? " is-disabled" : ""}" ${selectedDayPage >= selectedDayTotalPages ? `aria-disabled="true"` : `href="${esc(buildCalendarHref({ calMonth: requestedMonthYmd, calDay: selectedDayYmd, calPage: selectedDayPage + 1 }))}"`}>Next</a>
              </div>
            </div>
            <div class="dashboard-calendar-list">
              ${selectedVisibleEntries.length
                ? selectedVisibleEntries.map((item) => `
                    <a class="dashboard-calendar-item" href="${esc(item.href)}">
                      <div class="dashboard-calendar-item-title">${esc(item.title)}</div>
                      <div class="dashboard-calendar-item-meta">${esc(item.timeLabel || "All day")}${item.location ? ` · ${esc(item.location)}` : ""}</div>
                    </a>
                  `).join("")
                : `<div class="muted">No events on this day.</div>`}
            </div>
          </div>
        </div>
      `;
    } catch (err) {
      console.error("[dashboard calendar]", err);
    }

    // Venue dashboard metrics
    const venueDashParams = [];
    const venueDashWhere = [];
    if (selectedCity) {
      venueDashWhere.push("city = ?");
      venueDashParams.push(selectedCity);
    }
    if (isOrganizerUser && organizerVenueOwnerClause) {
      venueDashWhere.push(organizerVenueOwnerClause.sql);
      venueDashParams.push(...organizerVenueOwnerClause.params);
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
    function buildVenueChartSvg(metric = "views") {
      const labels = venueMonthlyHistory.map((row) => String(row.label || ""));
      const primaryValues = venueMonthlyHistory.map((row) =>
        Number(metric === "clicks" ? row.totalClicks || 0 : row.views || 0)
      );
      const secondaryValues = venueMonthlyHistory.map((row) =>
        Number(metric === "clicks" ? row.views || 0 : row.totalClicks || 0)
      );
      const allValues = primaryValues.concat(secondaryValues).filter((v) => Number.isFinite(v));
      const width = 1200;
      const height = 260;
      const padL = 56;
      const padR = 18;
      const padT = 18;
      const padB = 42;
      const plotW = width - padL - padR;
      const plotH = height - padT - padB;
      const textColor = "#475569";
      const viewsColor = "rgba(16,185,129,.82)";
      const clicksColor = "rgba(37,99,235,.72)";
      const primaryColor = metric === "views" ? viewsColor : clicksColor;
      const secondaryColor = metric === "views" ? clicksColor : viewsColor;

      if (!labels.length || !allValues.some((v) => v > 0)) {
        return `
          <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display:block; width:100%; height:100%;" preserveAspectRatio="none" role="img" aria-label="Venue chart">
            <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
            <text x="18" y="90" fill="rgba(15,23,42,.75)" font-size="14" font-weight="600" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">No monthly venue history yet</text>
          </svg>
        `;
      }

      const maxValue = Math.max(1, ...allValues);
      const tickCount = Math.min(6, maxValue);
      const tickStep = Math.max(1, Math.ceil(maxValue / tickCount));
      const yMax = tickStep * tickCount;
      const stepX = labels.length <= 1 ? 0 : plotW / (labels.length - 1);
      const primaryPoints = labels.map((label, index) => {
        const value = Number(primaryValues[index] || 0);
        const x = padL + stepX * index;
        const y = padT + plotH - ((value / yMax) * plotH);
        return { x, y, value };
      });
      const secondaryPoints = labels.map((label, index) => {
        const value = Number(secondaryValues[index] || 0);
        const x = padL + stepX * index;
        const y = padT + plotH - ((value / yMax) * plotH);
        return { x, y, value };
      });
      function buildSmoothSvgPath(points) {
        if (!points.length) return "";
        if (points.length === 1) {
          return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        }
        let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[i - 1] || points[i];
          const p1 = points[i];
          const p2 = points[i + 1];
          const p3 = points[i + 2] || p2;
          const cp1x = p1.x + (p2.x - p0.x) / 6;
          const cp1y = Math.max(padT, Math.min(padT + plotH, p1.y + (p2.y - p0.y) / 6));
          const cp2x = p2.x - (p3.x - p1.x) / 6;
          const cp2y = Math.max(padT, Math.min(padT + plotH, p2.y - (p3.y - p1.y) / 6));
          path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
        }
        return path;
      }
      const primaryPath = buildSmoothSvgPath(primaryPoints);
      const secondaryPath = buildSmoothSvgPath(secondaryPoints);
      const fillPath = primaryPoints.length
        ? `M ${primaryPoints[0].x.toFixed(2)} ${(padT + plotH).toFixed(2)} L ${primaryPoints[0].x.toFixed(2)} ${primaryPoints[0].y.toFixed(2)} ` +
          primaryPath.replace(/^M [^ ]+ [^ ]+ ?/, "") +
          ` L ${primaryPoints[primaryPoints.length - 1].x.toFixed(2)} ${(padT + plotH).toFixed(2)} Z`
        : "";
      const labelStep = labels.length <= 4 ? 1 : Math.ceil(labels.length / 4);

      return `
        <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display:block; width:100%; height:100%;" preserveAspectRatio="none" role="img" aria-label="Venue chart">
          <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
          ${Array.from({ length: tickCount + 1 }).map((_, i) => {
            const value = i * tickStep;
            const y = padT + plotH - ((value / yMax) * plotH);
            return `
              <line x1="${padL}" y1="${y.toFixed(2)}" x2="${(padL + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(15,23,42,.08)" stroke-width="1"></line>
              <text x="18" y="${(y + 4).toFixed(2)}" fill="${textColor}" font-size="12" font-weight="500" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">${value}</text>
            `;
          }).join("")}
          ${fillPath ? `<path d="${fillPath}" fill="${metric === "views" ? "rgba(16,185,129,.10)" : "rgba(37,99,235,.08)"}"></path>` : ""}
          ${secondaryPath ? `<path d="${secondaryPath}" fill="none" stroke="${secondaryColor}" stroke-width="2" stroke-dasharray="6 6" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
          ${primaryPath ? `<path d="${primaryPath}" fill="none" stroke="${primaryColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
          ${labels.map((label, index) => {
            if (index !== labels.length - 1 && index % labelStep !== 0) return "";
            const anchor = index === labels.length - 1 ? "end" : (index === 0 ? "start" : "middle");
            return `<text x="${primaryPoints[index].x.toFixed(2)}" y="${(padT + plotH + 30).toFixed(2)}" text-anchor="${anchor}" fill="${textColor}" font-size="12" font-weight="500" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">${esc(String(label || ""))}</text>`;
          }).join("")}
        </svg>
      `;
    }
    const venueChartSvgViews = buildVenueChartSvg("views");
    const venueChartSvgClicks = buildVenueChartSvg("clicks");

    const selectedEventIdRaw = parseInt(String(req.query.event || ""), 10);
    const requestedEventId = Number.isInteger(selectedEventIdRaw) && selectedEventIdRaw > 0
      ? selectedEventIdRaw
      : null;
    const requestedChartView = String(req.query.chartView || "").trim().toLowerCase();
    const chartViewMode = ["daily", "weekly", "monthly", "yearly"].includes(requestedChartView)
      ? requestedChartView
      : "daily";
    const buildEventAnalyticsHref = (id) =>
      `/admin/events-analytics?event=${encodeURIComponent(String(id || ""))}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}`;
    const buildAnalyticsChartHref = (mode) =>
      `/admin/events-analytics?chartView=${encodeURIComponent(String(mode || "daily"))}` +
      `${requestedEventId ? `&event=${encodeURIComponent(String(requestedEventId))}` : ""}` +
      `${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}`;
    const chartRangeLabelByMode = {
      daily: "Last 14 days (by start date)",
      weekly: "Last 12 weeks (by start date)",
      monthly: "Last 12 months (by start date)",
      yearly: "Last 5 years (by start date)",
    };

    // Top events by views (today / week / month / year)
    const hasViews = cols.has("viewCount");
    const topEventsFallback = `<div class="muted">Views not tracked.</div>`;
    function renderTopEventsByViewRows(rows, emptyMessage) {
      if (!rows || rows.length === 0) return `<div class="muted">${emptyMessage}</div>`;
      return rows
        .map((r) => {
          const label = `<a href="${esc(buildEventAnalyticsHref(r.id))}">${esc(String(r.title || ""))}</a>`;
          const count = Number(r.periodViews || r.todayViews || 0);
          return `<div class="kv"><div class="k">${label}</div><div class="v">${count}</div></div>`;
        })
        .join("");
    }

    async function topEventsByViewWindowHtml(windowStartIso, windowEndIso, emptyMessage) {
      if (!hasSourceTrackingTable) return topEventsFallback;
      const periodWhere = [];
      const periodParams = [];
      if (selectedCity) {
        periodWhere.push("LOWER(e.city) = LOWER(?)");
        periodParams.push(selectedCity);
      }
      if (organizerOwnerClause) {
        periodWhere.push(organizerOwnerClause.sql.replace(/organizer/g, "e.organizer"));
        periodParams.push(...organizerOwnerClause.params);
      }
      const periodWhereSql = periodWhere.length ? ` AND ${periodWhere.join(" AND ")}` : "";
      const rows = await all(
        `SELECT e.id, e.title, COUNT(*) AS periodViews
         FROM event_views ev
         JOIN events e ON e.id = ev.eventId
         WHERE datetime(ev.viewedAt) >= datetime(?)
           AND datetime(ev.viewedAt) < datetime(?)${periodWhereSql}
         GROUP BY e.id, e.title
         ORDER BY periodViews DESC, e.id DESC
         LIMIT 5`,
        [windowStartIso, windowEndIso, ...periodParams]
      );
      return renderTopEventsByViewRows(rows, emptyMessage);
    }

    const pacificToday = getZonedDateParts(new Date(), DEFAULT_TZ);
    const pacificTomorrowYmd = addDaysToYmd(pacificToday?.ymd || "", 1);
    const pacificWeekStartYmd = addDaysToYmd(pacificToday?.ymd || "", -6);
    const pacificMonthStartYmd = pacificToday ? `${pacificToday.year}-${pad2(pacificToday.month)}-01` : "";
    const pacificYearStartYmd = pacificToday ? `${pacificToday.year}-01-01` : "";
    const topTodayHtml = await topEventsByViewWindowHtml(
      zonedYmdBoundaryToUtcIso(pacificToday?.ymd || "", "start"),
      zonedYmdBoundaryToUtcIso(pacificTomorrowYmd, "start"),
      "No views today."
    );
    const topWeekHtml = await topEventsByViewWindowHtml(
      zonedYmdBoundaryToUtcIso(pacificWeekStartYmd, "start"),
      zonedYmdBoundaryToUtcIso(pacificTomorrowYmd, "start"),
      "No views this week."
    );
    const topMonthHtml = await topEventsByViewWindowHtml(
      zonedYmdBoundaryToUtcIso(pacificMonthStartYmd, "start"),
      zonedYmdBoundaryToUtcIso(pacificTomorrowYmd, "start"),
      "No views this month."
    );
    const topYearHtml = await topEventsByViewWindowHtml(
      zonedYmdBoundaryToUtcIso(pacificYearStartYmd, "start"),
      zonedYmdBoundaryToUtcIso(pacificTomorrowYmd, "start"),
      "No views this year."
    );

    // Top organizers by total event views
    const orgRows = await all(`
      SELECT 
        COALESCE(NULLIF(TRIM(organizer), ''), '(unknown)') AS organizer,
        COALESCE(SUM(COALESCE(viewCount, 0)), 0) AS totalViews
      FROM events
      ${dashWhereSql}
      GROUP BY organizer
      ORDER BY totalViews DESC, organizer ASC
      LIMIT 5
    `, dashParams);

    const topOrganizersHtml = orgRows
      .map((r) => {
        const organizerHref = `/admin/events-organizers?organizer=${encodeURIComponent(String(r.organizer || ""))}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}`;
        const label = `<a href="${esc(organizerHref)}">${esc(r.organizer)}</a>`;
        const count = Number(r.totalViews || 0);
        return `<div class="kv"><div class="k">${label}</div><div class="v">${count}</div></div>`;
      })
      .join("");

    // ------------------------------
    // Chart: Daily / Weekly / Monthly / Yearly
    // ------------------------------
    const hasViewsCol = cols.has("viewCount");
    const viewsExpr = hasViewsCol ? "SUM(COALESCE(viewCount,0))" : "0";

    function makeDailyBuckets() {
      const labels = [];
      const keys = [];
      for (let i = 13; i >= 0; i--) {
        const dt = new Date();
        dt.setHours(12, 0, 0, 0);
        dt.setDate(dt.getDate() - i);
        const key = dt.toISOString().slice(0, 10);
        labels.push(key.slice(5));
        keys.push(key);
      }
      return { labels, keys };
    }

    function makeWeeklyBuckets() {
      const labels = [];
      const keys = [];
      const now = new Date();
      now.setHours(12, 0, 0, 0);
      const monday = new Date(now);
      monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
      for (let i = 11; i >= 0; i--) {
        const dt = new Date(monday);
        dt.setDate(dt.getDate() - i * 7);
        const key = dt.toISOString().slice(0, 10);
        labels.push(key.slice(5));
        keys.push(key);
      }
      return { labels, keys };
    }

    function makeMonthlyBuckets() {
      const labels = [];
      const keys = [];
      const d = new Date();
      d.setDate(1);
      d.setHours(12, 0, 0, 0);
      const curYr = new Date().getFullYear();
      for (let i = 11; i >= 0; i--) {
        const dt = new Date(d);
        dt.setMonth(dt.getMonth() - i);
        const ym = dt.toISOString().slice(0, 7);
        const mon = dt.toLocaleString("en-US", { month: "short" });
        const yr = dt.getFullYear();
        labels.push(yr === curYr ? mon : `${mon} ${String(yr).slice(-2)}`);
        keys.push(ym);
      }
      return { labels, keys };
    }

    function makeYearlyBuckets() {
      const labels = [];
      const keys = [];
      const curY = new Date().getFullYear();
      for (let y = curY - 4; y <= curY; y++) {
        labels.push(String(y));
        keys.push(String(y));
      }
      return { labels, keys };
    }

    function keyForOccurrence(occ, mode) {
      const parts = occ.parts || parseIsoParts(occ.startDateTime || "");
      if (!parts) return "";
      if (mode === "daily") return toYmd(parts);
      if (mode === "weekly") {
        const wk = startOfWeekLocalDate(parts);
        return toYmd({ ...wk, hour: 0, minute: 0, second: 0, offset: parts.offset });
      }
      if (mode === "monthly") return `${parts.year}-${pad2(parts.month)}`;
      if (mode === "yearly") return String(parts.year);
      return "";
    }

    function endOfCurrentDayUtcMs() {
      const now = new Date();
      now.setHours(23, 59, 59, 999);
      return now.getTime();
    }

    function endOfCurrentWeekUtcMs() {
      const now = new Date();
      now.setHours(23, 59, 59, 999);
      const weekEnd = new Date(now);
      weekEnd.setDate(weekEnd.getDate() + (7 - ((weekEnd.getDay() + 6) % 7) - 1));
      return weekEnd.getTime();
    }

    function endOfCurrentMonthUtcMs() {
      const now = new Date();
      return new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999).getTime();
    }

    function endOfCurrentYearUtcMs() {
      const now = new Date();
      return new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999).getTime();
    }

    const eventChartRows = await all(
      `SELECT id, startDateTime, endDateTime, hasRecurrence, recurrenceRule, recurrenceDates, recurrenceStartDate, recurrenceUntilDate
       FROM events
       ${dashWhereSql}`,
      dashParams
    );

    const cityEventChartRows = isOrganizerUser
      ? await all(
          `SELECT id, startDateTime, endDateTime, hasRecurrence, recurrenceRule, recurrenceDates, recurrenceStartDate, recurrenceUntilDate
           FROM events
           ${cityDashWhereSql}`,
          cityDashParams
        )
      : [];

    function buildOccurrenceCountsFromRows(mode, rows) {
      const bucketFactory =
        mode === "daily" ? makeDailyBuckets :
        mode === "weekly" ? makeWeeklyBuckets :
        mode === "monthly" ? makeMonthlyBuckets :
        makeYearlyBuckets;
      const { labels, keys } = bucketFactory();
      const counts = new Map(keys.map((key) => [key, 0]));

      let windowStartUtcMs = 0;
      let windowEndUtcMs = 0;
      if (mode === "daily") {
        const d = new Date();
        d.setHours(0, 0, 0, 0);
        d.setDate(d.getDate() - 13);
        windowStartUtcMs = d.getTime();
        windowEndUtcMs = endOfCurrentDayUtcMs();
      } else if (mode === "weekly") {
        const now = new Date();
        now.setHours(0, 0, 0, 0);
        now.setDate(now.getDate() - ((now.getDay() + 6) % 7));
        now.setDate(now.getDate() - 11 * 7);
        windowStartUtcMs = now.getTime();
        windowEndUtcMs = endOfCurrentWeekUtcMs();
      } else if (mode === "monthly") {
        const now = new Date();
        windowStartUtcMs = new Date(now.getFullYear(), now.getMonth() - 11, 1, 0, 0, 0, 0).getTime();
        windowEndUtcMs = endOfCurrentMonthUtcMs();
      } else {
        const now = new Date();
        windowStartUtcMs = new Date(now.getFullYear() - 4, 0, 1, 0, 0, 0, 0).getTime();
        windowEndUtcMs = endOfCurrentYearUtcMs();
      }

      for (const row of (rows || []).map((item) => normalizeRowTimes(item))) {
        const isRecurring = hasRecurringData(row);
        const occurrences = isRecurring
          ? generateAdminOccurrences(row, windowStartUtcMs, windowEndUtcMs)
          : (() => {
              const parts = parseIsoParts(row?.startDateTime || "");
              const startUtc = Date.parse(row?.startDateTime || "");
              if (!parts || !Number.isFinite(startUtc) || startUtc < windowStartUtcMs || startUtc > windowEndUtcMs) return [];
              return [{
                occurrenceDate: row.startDateTime.slice(0, 10),
                startDateTime: row.startDateTime,
                parts,
              }];
            })();

        for (const occ of occurrences) {
          const key = keyForOccurrence(occ, mode);
          if (!counts.has(key)) continue;
          counts.set(key, Number(counts.get(key) || 0) + 1);
        }
      }

      return { labels, values: keys.map((key) => Number(counts.get(key) || 0)) };
    }

    function buildOccurrenceCounts(mode) {
      return buildOccurrenceCountsFromRows(mode, eventChartRows);
    }

    const buildDaily = async (metric) => {
      if (metric === "events") return buildOccurrenceCounts("daily");
      let rows = [];
      if (hasSourceTrackingTable) {
        rows = await all(
          `SELECT date(ev.viewedAt) AS d, COUNT(*) AS n
           FROM event_views ev
           WHERE ev.eventId IN (SELECT id FROM events ${trackedEventWhereSql})
             AND date(ev.viewedAt) >= date('now','-13 day')
           GROUP BY d
           ORDER BY d`,
          trackedEventWhereParams
        );
      } else {
        rows = await all(
          `SELECT date(startDateTime) AS d, ${viewsExpr} AS n
           FROM events
           ${dashAnd}date(startDateTime) >= date('now','-13 day')
           GROUP BY d
           ORDER BY d`,
          dashParams
        );
      }
      const byDay = new Map((rows || []).map((r) => [String(r.d), Number(r.n || 0)]));
      const { labels, keys } = makeDailyBuckets();
      return { labels, values: keys.map((key) => byDay.get(key) || 0) };
    };

    const buildWeekly = async (metric) => {
      if (metric === "events") return buildOccurrenceCounts("weekly");
      let rows = [];
      if (hasSourceTrackingTable) {
        rows = await all(
          `SELECT date(ev.viewedAt, 'weekday 1', '-7 day') AS wk, COUNT(*) AS n
           FROM event_views ev
           WHERE ev.eventId IN (SELECT id FROM events ${trackedEventWhereSql})
             AND date(ev.viewedAt) >= date('now','-83 day')
           GROUP BY wk
           ORDER BY wk`,
          trackedEventWhereParams
        );
      } else {
        rows = await all(
          `SELECT date(startDateTime, 'weekday 1', '-7 day') AS wk, ${viewsExpr} AS n
           FROM events
           ${dashAnd}date(startDateTime) >= date('now','-83 day')
           GROUP BY wk
           ORDER BY wk`,
          dashParams
        );
      }
      const byWk = new Map((rows || []).map((r) => [String(r.wk), Number(r.n || 0)]));
      const { labels, keys } = makeWeeklyBuckets();
      return { labels, values: keys.map((key) => byWk.get(key) || 0) };
    };

    const buildMonthly = async (metric) => {
      if (metric === "events") return buildOccurrenceCounts("monthly");
      let rows = [];
      if (hasSourceTrackingTable) {
        rows = await all(
          `SELECT strftime('%Y-%m', ev.viewedAt) AS ym, COUNT(*) AS n
           FROM event_views ev
           WHERE ev.eventId IN (SELECT id FROM events ${trackedEventWhereSql})
             AND date(ev.viewedAt) >= date('now','start of month','-11 month')
           GROUP BY ym
           ORDER BY ym`,
          trackedEventWhereParams
        );
      } else {
        rows = await all(
          `SELECT strftime('%Y-%m', startDateTime) AS ym, ${viewsExpr} AS n
           FROM events
           ${dashAnd}date(startDateTime) >= date('now','start of month','-11 month')
           GROUP BY ym
           ORDER BY ym`,
          dashParams
        );
      }
      const byYm = new Map((rows || []).map((r) => [String(r.ym), Number(r.n || 0)]));
      const { labels, keys } = makeMonthlyBuckets();
      return { labels, values: keys.map((key) => byYm.get(key) || 0) };
    };

    const buildYearly = async (metric) => {
      if (metric === "events") return buildOccurrenceCounts("yearly");
      let rows = [];
      if (hasSourceTrackingTable) {
        rows = await all(
          `SELECT strftime('%Y', ev.viewedAt) AS y, COUNT(*) AS n
           FROM event_views ev
           WHERE ev.eventId IN (SELECT id FROM events ${trackedEventWhereSql})
             AND date(ev.viewedAt) >= date('now','start of year','-4 year')
           GROUP BY y
           ORDER BY y`,
          trackedEventWhereParams
        );
      } else {
        rows = await all(
          `SELECT strftime('%Y', startDateTime) AS y, ${viewsExpr} AS n
           FROM events
           ${dashAnd}date(startDateTime) >= date('now','start of year','-4 year')
           GROUP BY y
           ORDER BY y`,
          dashParams
        );
      }
      const byY = new Map((rows || []).map((r) => [String(r.y), Number(r.n || 0)]));
      const { labels, keys } = makeYearlyBuckets();
      return { labels, values: keys.map((key) => byY.get(key) || 0) };
    };

    let chartSets = {
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
    if (isOrganizerUser) {
      chartSets.cityEvents = {
        daily: buildOccurrenceCountsFromRows("daily", cityEventChartRows),
        weekly: buildOccurrenceCountsFromRows("weekly", cityEventChartRows),
        monthly: buildOccurrenceCountsFromRows("monthly", cityEventChartRows),
        yearly: buildOccurrenceCountsFromRows("yearly", cityEventChartRows),
      };
    }
    function buildEventsChartSvgForMode(mode) {
      const eventSet = (chartSets.events && chartSets.events[mode]) ? chartSets.events[mode] : { labels: [], values: [] };
      const viewSet = (chartSets.views && chartSets.views[mode]) ? chartSets.views[mode] : { labels: [], values: [] };
      const cityEventSet = (chartSets.cityEvents && chartSets.cityEvents[mode]) ? chartSets.cityEvents[mode] : { labels: [], values: [] };
      const labels = Array.isArray(eventSet.labels) ? eventSet.labels : [];
      const eventValues = Array.isArray(eventSet.values) ? eventSet.values.map((v) => Number(v || 0)) : [];
      const viewValues = Array.isArray(viewSet.values) ? viewSet.values.map((v) => Number(v || 0)) : [];
      const cityEventValues = Array.isArray(cityEventSet.values) ? cityEventSet.values.map((v) => Number(v || 0)) : [];
      const allValues = eventValues.concat(viewValues).filter((v) => Number.isFinite(v));
      const width = 1200;
      const height = 260;
      const padL = 56;
      const padR = 18;
      const padT = 18;
      const padB = 42;
      const plotW = width - padL - padR;
      const plotH = height - padT - padB;
      const textColor = "#475569";
      const lineColor = "rgba(16,185,129,.82)";
      const dashedColor = "rgba(37,99,235,.72)";

      if (!labels.length || !allValues.some((v) => v > 0)) {
        return `
          <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display:block; width:100%; height:100%;" preserveAspectRatio="none" role="img" aria-label="Events chart">
            <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
            <text x="18" y="90" fill="rgba(15,23,42,.75)" font-size="14" font-weight="600" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">No recent activity</text>
          </svg>
        `;
      }

      const maxValue = Math.max(1, ...allValues);
      const tickCount = Math.min(6, maxValue);
      const tickStep = Math.max(1, Math.ceil(maxValue / tickCount));
      const yMax = tickStep * tickCount;
      const stepX = labels.length <= 1 ? 0 : plotW / (labels.length - 1);
      const eventPoints = labels.map((label, index) => {
        const value = Number(eventValues[index] || 0);
        const x = padL + stepX * index;
        const y = padT + plotH - ((value / yMax) * plotH);
        return { x, y, value };
      });
      const viewPoints = labels.map((label, index) => {
        const value = Number(viewValues[index] || 0);
        const x = padL + stepX * index;
        const y = padT + plotH - ((value / yMax) * plotH);
        return { x, y, value };
      });
      function buildSmoothSvgPath(points) {
        if (!points.length) return "";
        if (points.length === 1) {
          return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        }
        let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[i - 1] || points[i];
          const p1 = points[i];
          const p2 = points[i + 1];
          const p3 = points[i + 2] || p2;
          const cp1x = p1.x + (p2.x - p0.x) / 6;
          const cp1y = Math.max(padT, Math.min(padT + plotH, p1.y + (p2.y - p0.y) / 6));
          const cp2x = p2.x - (p3.x - p1.x) / 6;
          const cp2y = Math.max(padT, Math.min(padT + plotH, p2.y - (p3.y - p1.y) / 6));
          path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
        }
        return path;
      }
      const eventPath = buildSmoothSvgPath(eventPoints);
      const viewPath = buildSmoothSvgPath(viewPoints);
      const fillPath = eventPoints.length
        ? `M ${eventPoints[0].x.toFixed(2)} ${(padT + plotH).toFixed(2)} L ${eventPoints[0].x.toFixed(2)} ${eventPoints[0].y.toFixed(2)} ` +
          eventPath.replace(/^M [^ ]+ [^ ]+ ?/, "") +
          ` L ${eventPoints[eventPoints.length - 1].x.toFixed(2)} ${(padT + plotH).toFixed(2)} Z`
        : "";
      const labelStep = labels.length <= 4 ? 1 : Math.ceil(labels.length / 4);
      const hoverRects = labels.map((label, index) => {
        const centerX = eventPoints[index].x;
        const prevX = index > 0 ? eventPoints[index - 1].x : centerX - (stepX || plotW / Math.max(1, labels.length));
        const nextX = index < labels.length - 1 ? eventPoints[index + 1].x : centerX + (stepX || plotW / Math.max(1, labels.length));
        const left = index === 0 ? padL : (prevX + centerX) / 2;
        const right = index === labels.length - 1 ? (padL + plotW) : (centerX + nextX) / 2;
        const widthPx = Math.max(12, right - left);
        return `
          <rect
            x="${left.toFixed(2)}"
            y="${padT.toFixed(2)}"
            width="${widthPx.toFixed(2)}"
            height="${plotH.toFixed(2)}"
            fill="transparent"
            data-chart-hit="${index}"
            onmousemove="window.ocShowEventsChartTipIndex && window.ocShowEventsChartTipIndex(${index}, event)"
            onmouseenter="window.ocShowEventsChartTipIndex && window.ocShowEventsChartTipIndex(${index}, event)"
            onmouseleave="window.ocHideEventsChartTip && window.ocHideEventsChartTip()"
          ></rect>
        `;
      }).join("");

      return `
        <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display:block; width:100%; height:100%;" preserveAspectRatio="none" role="img" aria-label="Events chart">
          <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
          ${Array.from({ length: tickCount + 1 }).map((_, i) => {
            const value = i * tickStep;
            const y = padT + plotH - ((value / yMax) * plotH);
            return `
              <line x1="${padL}" y1="${y.toFixed(2)}" x2="${(padL + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(15,23,42,.08)" stroke-width="1"></line>
              <text x="18" y="${(y + 4).toFixed(2)}" fill="${textColor}" font-size="12" font-weight="500" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">${value}</text>
            `;
          }).join("")}
          ${fillPath ? `<path d="${fillPath}" fill="rgba(16,185,129,.10)"></path>` : ""}
          ${viewPath ? `<path d="${viewPath}" fill="none" stroke="${dashedColor}" stroke-width="2" stroke-dasharray="6 6" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
          ${eventPath ? `<path d="${eventPath}" fill="none" stroke="${lineColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
          ${hoverRects}
          ${labels.map((label, index) => {
            if (index !== labels.length - 1 && index % labelStep !== 0) return "";
            const anchor = index === labels.length - 1 ? "end" : (index === 0 ? "start" : "middle");
            return `<text x="${eventPoints[index].x.toFixed(2)}" y="${(padT + plotH + 30).toFixed(2)}" text-anchor="${anchor}" fill="${textColor}" font-size="12" font-weight="500" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">${esc(String(label || ""))}</text>`;
          }).join("")}
        </svg>
      `;
    }
    function buildEventsChartInfoHtml(mode, index = null) {
      const eventSet = (chartSets.events && chartSets.events[mode]) ? chartSets.events[mode] : { labels: [], values: [] };
      const viewSet = (chartSets.views && chartSets.views[mode]) ? chartSets.views[mode] : { labels: [], values: [] };
      const cityEventSet = (chartSets.cityEvents && chartSets.cityEvents[mode]) ? chartSets.cityEvents[mode] : { labels: [], values: [] };
      const labels = Array.isArray(eventSet.labels) ? eventSet.labels : [];
      const eventValues = Array.isArray(eventSet.values) ? eventSet.values : [];
      const viewValues = Array.isArray(viewSet.values) ? viewSet.values : [];
      const cityEventValues = Array.isArray(cityEventSet.values) ? cityEventSet.values : [];
      if (!labels.length) return "No stats for this period.";
      const safeIndex = index === null ? (labels.length - 1) : Math.max(0, Math.min(Number(index || 0), labels.length - 1));
      const label = String(labels[safeIndex] || "");
      const events = Number(eventValues[safeIndex] || 0).toLocaleString("en-US");
      const views = Number(viewValues[safeIndex] || 0).toLocaleString("en-US");
      const cityEvents = Number(cityEventValues[safeIndex] || 0).toLocaleString("en-US");
      const safeLabel = esc(label);
      return 'Period: <strong>' + safeLabel + '</strong>' +
        ' <span style="margin-left:14px;">Events: <strong>' + events + '</strong></span>' +
        (Number(cityEventValues[safeIndex] || 0) > 0 ? ' <span style="margin-left:14px;">City events: <strong>' + cityEvents + '</strong></span>' : '') +
        ' <span style="margin-left:14px;">Views: <strong>' + views + '</strong></span>';
    }
    let selectedEventAnalytics = null;
    let analyticsSideTitle = "Top organizers";
    let analyticsSideSub = "Highest total event views";
    let analyticsSideBodyHtml = `<div class="mini mini-list">${topOrganizersHtml}</div>`;
    if (requestedEventId) {
      const selectedEventRow = await get(
        `SELECT id, title, slug, location, organizer, startDateTime, endDateTime, hasRecurrence, recurrenceRule,
                recurrenceDates, recurrenceStartDate, recurrenceUntilDate, featured, viewCount, uniqueViewCount, ticketClickCount,
                goingCount, interestedCount
         FROM events
         WHERE id = ?
         ${selectedCity ? "AND city = ?" : ""}
         ${organizerOwnerClause ? `AND ${organizerOwnerClause.sql}` : ""}
         ${hasArchiveCols2 ? "AND (isArchived IS NULL OR isArchived = 0)" : ""}`,
        [requestedEventId, ...(selectedCity ? [selectedCity] : []), ...(organizerOwnerClause ? organizerOwnerClause.params : [])]
      );
      if (selectedEventRow) {
        const eventRow = normalizeRowTimes(selectedEventRow);
        const nowMs = Date.now();
        const monthlyWindowStartMs = new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1, 0, 0, 0, 0).getTime();
        const monthlyWindowEndMs = endOfCurrentMonthUtcMs();
        const isRecurring = hasRecurringData(eventRow);
        const selectedEventViewRows = hasSourceTrackingTable
          ? await all(
              `SELECT viewedAt
               FROM event_views
               WHERE eventId = ?
                 AND date(viewedAt) >= date('now','start of year','-4 year')`,
              [requestedEventId]
            )
          : [];

        function selectedEventOccurrencesForMode(mode) {
          const bucketFactory =
            mode === "daily" ? makeDailyBuckets :
            mode === "weekly" ? makeWeeklyBuckets :
            mode === "monthly" ? makeMonthlyBuckets :
            makeYearlyBuckets;
          const { labels, keys } = bucketFactory();
          const counts = new Map(keys.map((key) => [key, 0]));
          let windowStartUtcMs = 0;
          let windowEndUtcMs = 0;
          if (mode === "daily") {
            const d = new Date();
            d.setHours(0, 0, 0, 0);
            d.setDate(d.getDate() - 13);
            windowStartUtcMs = d.getTime();
            windowEndUtcMs = endOfCurrentDayUtcMs();
          } else if (mode === "weekly") {
            const now = new Date();
            now.setHours(0, 0, 0, 0);
            now.setDate(now.getDate() - ((now.getDay() + 6) % 7));
            now.setDate(now.getDate() - 11 * 7);
            windowStartUtcMs = now.getTime();
            windowEndUtcMs = endOfCurrentWeekUtcMs();
          } else if (mode === "monthly") {
            const now = new Date();
            windowStartUtcMs = new Date(now.getFullYear(), now.getMonth() - 11, 1, 0, 0, 0, 0).getTime();
            windowEndUtcMs = endOfCurrentMonthUtcMs();
          } else {
            const now = new Date();
            windowStartUtcMs = new Date(now.getFullYear() - 4, 0, 1, 0, 0, 0, 0).getTime();
            windowEndUtcMs = endOfCurrentYearUtcMs();
          }
          const occurrences = isRecurring
            ? generateAdminOccurrences(eventRow, windowStartUtcMs, windowEndUtcMs)
            : (() => {
                const parts = parseIsoParts(eventRow?.startDateTime || "");
                const startUtc = Date.parse(eventRow?.startDateTime || "");
                if (!parts || !Number.isFinite(startUtc) || startUtc < windowStartUtcMs || startUtc > windowEndUtcMs) return [];
                return [{
                  occurrenceDate: eventRow.startDateTime.slice(0, 10),
                  startDateTime: eventRow.startDateTime,
                  parts,
                }];
              })();
          for (const occ of occurrences) {
            const key = keyForOccurrence(occ, mode);
            if (!counts.has(key)) continue;
            counts.set(key, Number(counts.get(key) || 0) + 1);
          }
          return { labels, values: keys.map((key) => Number(counts.get(key) || 0)) };
        }

        function selectedEventViewsForMode(mode) {
          const bucketFactory =
            mode === "daily" ? makeDailyBuckets :
            mode === "weekly" ? makeWeeklyBuckets :
            mode === "monthly" ? makeMonthlyBuckets :
            makeYearlyBuckets;
          const { labels, keys } = bucketFactory();
          const counts = new Map(keys.map((key) => [key, 0]));
          for (const row of selectedEventViewRows || []) {
            const viewedAt = String(row?.viewedAt || "");
            const dt = new Date(viewedAt);
            if (Number.isNaN(dt.getTime())) continue;
            let key = "";
            if (mode === "daily") {
              key = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
            } else if (mode === "weekly") {
              const wk = new Date(dt);
              wk.setHours(0, 0, 0, 0);
              wk.setDate(wk.getDate() - ((wk.getDay() + 6) % 7));
              key = `${wk.getFullYear()}-${pad2(wk.getMonth() + 1)}-${pad2(wk.getDate())}`;
            } else if (mode === "monthly") {
              key = `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`;
            } else {
              key = String(dt.getFullYear());
            }
            if (!counts.has(key)) continue;
            counts.set(key, Number(counts.get(key) || 0) + 1);
          }
          return { labels, values: keys.map((key) => Number(counts.get(key) || 0)) };
        }

        chartSets = {
          events: {
            daily: selectedEventOccurrencesForMode("daily"),
            weekly: selectedEventOccurrencesForMode("weekly"),
            monthly: selectedEventOccurrencesForMode("monthly"),
            yearly: selectedEventOccurrencesForMode("yearly"),
          },
          views: {
            daily: selectedEventViewsForMode("daily"),
            weekly: selectedEventViewsForMode("weekly"),
            monthly: selectedEventViewsForMode("monthly"),
            yearly: selectedEventViewsForMode("yearly"),
          },
        };

        let sourceSummary = {
          allViews: 0,
          directViews: 0,
          referralViews: 0,
          internalViews: 0,
        };
        if (hasSourceTrackingTable) {
          try {
            const sourceRow = await get(
              `SELECT
                 COUNT(*) AS tracked,
                 COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:direct%' OR COALESCE(ref,'') = '__direct__' OR trim(COALESCE(ref,'')) = '' THEN 1 ELSE 0 END), 0) AS directCount,
                 COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:referral%' THEN 1 ELSE 0 END), 0) AS referralCount,
                 COALESCE(SUM(CASE WHEN COALESCE(ref,'') LIKE '[src:internal%' THEN 1 ELSE 0 END), 0) AS internalCount
               FROM event_views
               WHERE eventId = ?`,
              [requestedEventId]
            );
            sourceSummary = {
              allViews: Number(sourceRow?.tracked || 0),
              directViews: Number(sourceRow?.directCount || 0),
              referralViews: Number(sourceRow?.referralCount || 0),
              internalViews: Number(sourceRow?.internalCount || 0),
            };
          } catch (_) {}
        }

        const totalOccurrencesAllTime = isRecurring
          ? generateAdminOccurrences(
              eventRow,
              Number.isFinite(Date.parse(String(eventRow?.startDateTime || "")))
                ? Date.parse(String(eventRow?.startDateTime || ""))
                : monthlyWindowStartMs,
              getRecurringSeriesEndUtcMs(eventRow, monthlyWindowEndMs)
            ).length || 1
          : 1;
        const upcomingOccurrences = isRecurring
          ? generateAdminOccurrences(eventRow, nowMs - 5 * 60 * 1000, nowMs + 90 * 86400 * 1000).length
          : (() => {
              const startUtc = Date.parse(String(eventRow?.startDateTime || ""));
              return Number.isFinite(startUtc) && startUtc >= nowMs ? 1 : 0;
            })();
        selectedEventAnalytics = {
          id: Number(eventRow.id || 0),
          title: String(eventRow.title || "Untitled event"),
          location: String(eventRow.location || ""),
          organizer: String(eventRow.organizer || ""),
          totalOccurrences: Number(totalOccurrencesAllTime || 0),
          upcomingOccurrences: Number(upcomingOccurrences || 0),
          featured: Number(eventRow.featured || 0) === 1 ? 1 : 0,
          lifetimeViews: Number(eventRow.viewCount || 0),
          uniqueViews: Number(eventRow.uniqueViewCount || 0),
          ticketClicks: Number(eventRow.ticketClickCount || 0),
          going: Number(eventRow.goingCount || 0),
          interested: Number(eventRow.interestedCount || 0),
          ...sourceSummary,
        };

        analyticsSideTitle = selectedEventAnalytics.title;
        analyticsSideSub = "Individual event insights";
        analyticsSideBodyHtml = `
          <div class="mini event-insights-mini">
            <div style="margin-bottom:12px;">
              <a class="btn" href="/admin/events-analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Back to all events analytics</a>
            </div>
            ${selectedEventAnalytics.location ? `<div class="muted" style="margin-bottom:6px;">${esc(selectedEventAnalytics.location)}</div>` : ``}
            ${selectedEventAnalytics.organizer ? `<div class="muted" style="margin-bottom:12px;">Organizer: ${esc(selectedEventAnalytics.organizer)}</div>` : ``}
            <div class="kv"><div class="k">Tickets</div><div class="v">${selectedEventAnalytics.ticketClicks.toLocaleString("en-US")}</div></div>
            <div class="kv"><div class="k">Going</div><div class="v">${selectedEventAnalytics.going.toLocaleString("en-US")}</div></div>
            <div class="kv"><div class="k">Interested</div><div class="v">${selectedEventAnalytics.interested.toLocaleString("en-US")}</div></div>
          </div>
        `;
      }
    }
    const chartDataJson = JSON.stringify(chartSets);
    const chartDataJsonForScript = chartDataJson
      .replace(/</g, "\\u003c")
      .replace(/>/g, "\\u003e")
      .replace(/&/g, "\\u0026");
    const eventsChartSvgByMode = {
      daily: buildEventsChartSvgForMode("daily"),
      weekly: buildEventsChartSvgForMode("weekly"),
      monthly: buildEventsChartSvgForMode("monthly"),
      yearly: buildEventsChartSvgForMode("yearly"),
    };
    const adPlacementOptions = [
      "homepage-top",
      "homepage-bottom",
      "events-top",
      "events-bottom",
      "venues-top",
      "single-event-main",
      "single-event-side",
    ];

    const showDashboard = view === "dashboard";
    const showAnalytics = view === "events-analytics" || view === "analytics";
    const showOrganizers = view === "events-organizers";
    const showCreate = view === "create";
    const showApprove = view === "approve";
    const showUpload = view === "upload-events";
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
    const showMessages = view === "messages";
    const showPreferences = view === "preferences";
    const showUpdatesLog = view === "updates-log";
    const showUsers = view === "users";
    const showInvites = view === "invites";

    if (showExisting && !canManageEvents) return res.status(403).send("Forbidden");
    if (showAnalytics && !canSeeEventsAnalytics) return res.status(403).send("Forbidden");
    if (showUsers && !hasDeveloperAccess) return res.status(403).send("Forbidden");
    if (showInvites && !hasDeveloperAccess) return res.status(403).send("Forbidden");
    if (showMessages && !canUseMessages) return res.status(403).send("Forbidden");
    if (showMessages && !selectedMessageContact && messageContacts.length) {
      selectedMessageContactId = Number(messageContacts[0].id);
      selectedMessageContact = messageContacts[0];
      try {
        messageConversationRows = await all(
          `SELECT
             m.id,
             m.body,
             m.readAt,
             m.createdAt,
             m.senderUserId,
             m.recipientUserId,
             s.displayName AS senderDisplayName,
             s.username AS senderUsername,
             s.email AS senderEmail,
             s.photoUrl AS senderPhotoUrl
           FROM messages m
           LEFT JOIN users s ON s.id = m.senderUserId
           WHERE m.city = ?
             AND (
               (m.senderUserId = ? AND m.recipientUserId = ?)
               OR
               (m.senderUserId = ? AND m.recipientUserId = ?)
             )
           ORDER BY datetime(m.createdAt) ASC`,
          [selectedCity, currentUser.id, selectedMessageContactId, selectedMessageContactId, currentUser.id]
        );
        await run(
          `UPDATE messages
              SET readAt = datetime('now')
            WHERE recipientUserId = ?
              AND senderUserId = ?
              AND city = ?
              AND readAt IS NULL`,
          [currentUser.id, selectedMessageContactId, selectedCity]
        );
        unreadMessagesCount = Math.max(0, unreadMessagesCount - Number(selectedMessageContact.unreadCount || 0));
        selectedMessageContact.unreadCount = 0;
      } catch (_) {}
    }
    if (showUpdatesLog && !(hasDeveloperAccess || isOrganizerUser)) return res.status(403).send("Forbidden");
    if (showApprove && !canApproveEvents) return res.status(403).send("Forbidden");
    if (showCreate && !canManageEvents) return res.status(403).send("Forbidden");
    if (showUpload && !canManageEvents) return res.status(403).send("Forbidden");
    if (showOrganizers && !canSeeOrganizerAnalytics) return res.status(403).send("Forbidden");
    if (showVenueCreate && !canManageVenues) return res.status(403).send("Forbidden");
    if (showVenueExisting && !canManageVenues) return res.status(403).send("Forbidden");
    if (showVenueAnalytics && !canSeeVenueAnalytics) return res.status(403).send("Forbidden");
    if (showJobsCreate && !canManageJobs) return res.status(403).send("Forbidden");
    if (showJobsExisting && !canManageJobs) return res.status(403).send("Forbidden");
    if (showJobsApplicants && !canManageJobs) return res.status(403).send("Forbidden");
    if (showJobsAnalytics && !canSeeJobAnalytics) return res.status(403).send("Forbidden");
    if (showAdsCreate && !canManageAds) return res.status(403).send("Forbidden");
    if (showAdsExisting && !canManageAds) return res.status(403).send("Forbidden");
    if (showAdsAnalytics && !canSeeAdsAnalytics) return res.status(403).send("Forbidden");
    const showSearch = !showMessages;
    const searchAction = showVenueCreate || showVenueExisting || showVenueAnalytics
      ? "/admin/venues"
      : showJobsApplicants
      ? "/admin/jobs/applicants"
      : showJobsCreate || showJobsExisting || showJobsAnalytics
      ? "/admin/jobs"
      : showAdsCreate || showAdsExisting || showAdsAnalytics
      ? "/admin/ads"
      : showAnalytics
      ? "/admin/events-analytics"
      : "/admin/existing-events";
    const searchPlaceholder = showVenueCreate || showVenueExisting || showVenueAnalytics
      ? "Search venues (name, slug, address, ID)..."
      : showJobsApplicants
      ? "Search applicants (name, email, phone, job)..."
      : showJobsCreate || showJobsExisting || showJobsAnalytics
      ? "Search jobs (title, company, location, ID)..."
      : showAdsCreate || showAdsExisting || showAdsAnalytics
      ? "Search ads (name, placement, slug, URL, ID)..."
      : showMessages
      ? ""
      : "Search events (title, slug, location, ID)...";
    const searchResetHref = showVenueCreate || showVenueExisting || showVenueAnalytics
      ? `/admin/venues?pg=1&limit=${esc(String(limit))}`
      : showJobsApplicants
      ? `/admin/jobs/applicants?pg=1&limit=${esc(String(limit))}`
      : showJobsCreate || showJobsExisting || showJobsAnalytics
      ? `/admin/jobs?pg=1&limit=${esc(String(limit))}`
      : showAdsCreate || showAdsExisting || showAdsAnalytics
      ? `/admin/ads?pg=1&limit=${esc(String(limit))}`
      : showAnalytics
      ? `/admin/events-analytics?pg=1&limit=${esc(String(limit))}&status=${esc(String(statusMode))}${recurringOnly ? `&recurring=1` : ``}`
      : `/admin/existing-events?pg=1&limit=${esc(String(limit))}&status=${esc(String(statusMode))}${recurringOnly ? `&recurring=1` : ``}`;
    const isSingleManage = (showCreate ^ showUpload ^ showExisting ^ showVenueCreate ^ showVenueExisting ^ showJobsCreate ^ showJobsExisting ^ showJobsApplicants ^ showJobsAnalytics ^ showAdsCreate ^ showAdsExisting ^ showAdsAnalytics ^ showPreferences);

    const prefNotice = String(req.query.notice || "").trim().toLowerCase();
    const prefNoticeHtml = prefNotice
      ? (prefNotice === "profile_saved"
          ? `<div class="mini" style="border-color:rgba(0,192,139,.35); background:rgba(0,192,139,.08); color:#065f46; margin-bottom:12px;">Profile updated.</div>`
          : prefNotice === "status_saved"
          ? `<div class="mini" style="border-color:rgba(0,192,139,.35); background:rgba(0,192,139,.08); color:#065f46; margin-bottom:12px;">Status updated.</div>`
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
    let inviteLimitNoticeHtml = "";
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
                      <div>Role: ${esc(formatRoleLabel(inv.role))}</div>
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
        "SELECT id, email, username, role, city, permissionsJson, createdAt, lastSeenAt FROM users ORDER BY datetime(createdAt) DESC"
      );
      const notice = String(req.query.notice || "");
      const noticeHtml =
        notice === "sent"
          ? `<div class="mini" style="margin-bottom:10px; border-color:rgba(16,185,129,.35); color:#065f46;">Invite email sent.</div>`
          : notice === "saved"
          ? `<div class="mini" style="margin-bottom:10px; border-color:rgba(16,185,129,.35); color:#065f46;">User permissions updated.</div>`
          : notice === "no_email"
          ? `<div class="mini" style="margin-bottom:10px; border-color:rgba(239,68,68,.35); color:#991b1b;">User has no email on file.</div>`
          : notice === "email_taken"
          ? `<div class="mini" style="margin-bottom:10px; border-color:rgba(239,68,68,.35); color:#991b1b;">That email is already assigned to another user.</div>`
          : notice === "city_required"
          ? `<div class="mini" style="margin-bottom:10px; border-color:rgba(239,68,68,.35); color:#991b1b;">Select at least one area for the user.</div>`
          : notice === "send_failed"
          ? `<div class="mini" style="margin-bottom:10px; border-color:rgba(239,68,68,.35); color:#991b1b;">Failed to send email. Check SMTP logs.</div>`
          : "";
      usersHtml = rows.length
        ? noticeHtml +
          `<div class="users-shell">
            <style>
              .users-shell{ display:grid; gap:14px; }
              .users-panel{
                border:1px solid var(--line);
                border-radius:var(--radius);
                background:#fff;
                overflow:hidden;
              }
              .users-list{
                display:grid;
                gap:0;
              }
              .users-row{
                display:grid;
                gap:12px;
                padding:18px 20px;
                background:#fff;
              }
              .users-row + .users-row{
                border-top:1px solid var(--line);
              }
              .users-topline{
                display:flex;
                justify-content:space-between;
                gap:16px;
                align-items:flex-start;
              }
              .users-name{ display:flex; gap:14px; align-items:flex-start; min-width:0; }
              .users-avatar{
                width:44px; height:44px; border-radius:999px; flex:0 0 44px;
                background:#e7eef8;
                color:#52627a; display:grid; place-items:center; font-weight:800;
                overflow:hidden;
              }
              .users-avatar img{ width:100%; height:100%; object-fit:cover; display:block; }
              .users-copy{ min-width:0; }
              .users-primary{ font-weight:800; color:var(--text); line-height:1.2; display:flex; align-items:center; gap:8px; font-size:18px; }
              .users-secondary{ color:#6b7280; margin-top:4px; word-break:break-word; font-size:14px; }
              .users-meta{
                display:flex;
                flex-wrap:wrap;
                gap:14px;
                padding-left:58px;
              }
              .users-meta-item{
                display:inline-flex;
                align-items:center;
                gap:8px;
                color:#50627b;
                font-weight:700;
                font-size:14px;
              }
              .users-meta-item strong{
                color:var(--text);
                font-weight:800;
              }
              .users-status{ display:inline-flex; align-items:center; gap:10px; font-weight:700; color:var(--text); }
              .users-status-dot{
                width:12px; height:12px; border-radius:999px; flex:0 0 12px;
                background:#22c55e;
              }
              .users-pill{
                display:inline-flex; align-items:center; min-height:32px; padding:0 14px;
                border-radius:999px; font-weight:700; border:1px solid transparent;
              }
              .users-pill.role-dev{ background:#eef2ff; color:#42526b; }
              .users-pill.role-org{ background:#e7f7ef; color:#166534; }
              .users-actions{
                display:flex;
                align-items:center;
                justify-content:flex-end;
                flex:0 0 auto;
              }
              .users-actions-trigger{
                display:inline-flex; align-items:center; justify-content:center;
                min-height:38px; border:1px solid var(--line); border-radius:10px; background:#fff;
                color:#29557a; font-weight:800; text-decoration:none; cursor:pointer; padding:0 14px;
              }
              .users-actions-trigger:hover{ background:#f3f7fb; border-color:rgba(41,85,122,.18); }
              .users-modal{
                position:fixed; inset:0; z-index:80; display:none; align-items:center; justify-content:center;
                padding:24px;
              }
              .users-modal.open{ display:flex; }
              .users-modal-backdrop{
                position:absolute; inset:0; background:rgba(15,23,42,.42); backdrop-filter:blur(3px);
              }
              .users-modal-panel{
                position:relative; z-index:1; width:min(760px, calc(100vw - 32px));
                border:1px solid var(--line); border-radius:14px; background:#fff;
                box-shadow:0 24px 60px rgba(15,23,42,.18); padding:18px;
                display:grid; gap:18px;
              }
              .users-modal-top{
                display:flex; justify-content:space-between; gap:16px; align-items:flex-start;
              }
              .users-modal-title{ font-size:30px; line-height:1.1; margin:0; }
              .users-modal-sub{ color:var(--muted); margin-top:6px; }
              .users-modal-close{
                width:42px; height:42px; border-radius:999px; border:1px solid var(--line);
                background:#fff; cursor:pointer; font-size:24px; line-height:1; color:var(--muted);
              }
              .users-modal-grid{
                display:grid; grid-template-columns:minmax(0,1fr) minmax(210px, 240px); gap:18px;
                align-items:stretch;
              }
              .users-modal-main{ display:grid; gap:18px; align-self:stretch; }
              .users-modal-card{
                border:1px solid var(--line); border-radius:14px; background:#fff; padding:16px;
              }
              .users-modal-label{ color:var(--muted); font-weight:700; margin-bottom:8px; }
              .users-field-row{ display:grid; grid-template-columns:minmax(0,1fr) 140px; gap:14px; align-items:end; }
              .users-access-grid{
                display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:12px 16px;
              }
              .users-access-item{
                display:flex; align-items:center; gap:10px; min-height:40px; font-weight:700; color:var(--text);
              }
              .users-access-item input{ width:18px; height:18px; margin:0; }
              .users-side-actions{
                display:grid;
                gap:14px;
                align-self:stretch;
                grid-template-rows:repeat(3, minmax(0, 1fr));
              }
              .users-side-actions form,
              .users-modal-main form{ margin:0; }
              .users-side-actions form{ display:flex; }
              .users-side-actions .btn,
              .users-modal-main .btn{ width:100%; }
              .users-side-actions .btn{
                min-height:72px;
                height:100%;
                border-radius:12px;
              }
              .users-empty{
                border:1px solid var(--line);
                border-radius:var(--radius);
                background:#fff;
                padding:24px;
                color:#6b7280;
              }
              @media (max-width: 980px){
                .users-topline{
                  display:grid;
                  gap:12px;
                }
                .users-primary{ font-size:17px; }
                .users-actions{ justify-content:flex-start; }
                .users-meta{ padding-left:0; }
                .users-modal-grid,
                .users-field-row,
                .users-access-grid{ grid-template-columns:1fr; }
              }
            </style>
            <div class="users-panel">
              <div class="users-list">` +
          rows
            .map((u) => {
              const normalizedUserRole = normalizeRoleValue(u.role);
              const labelRole = formatRoleLabel(normalizedUserRole);
              const userPerms = getUserSectionPermissions(u);
              const userCities = getUserAllowedCities(u, u.city || "Enumclaw");
              const userFormId = `user-role-${encodeURIComponent(u.id)}`;
              const modalId = `user-modal-${encodeURIComponent(u.id)}`;
              const displayName = esc(u.username || u.email || "User");
              const emailLabel = esc(u.email || "—");
              const cityLabel = esc(userCities.join(", "));
              const initials = esc(String(u.username || u.email || "U").trim().slice(0, 2).toUpperCase());
              const statusTone = u.lastSeenAt ? "Active" : "Inactive";
              const statusColor = u.lastSeenAt ? "#22c55e" : "#ef4444";
              const accessSummary = normalizedUserRole === "organizer"
                ? [userPerms.events ? "Events" : "", userPerms.venues ? "Venues" : "", userPerms.jobs ? "Jobs" : "", userPerms.ads ? "Ads" : "", userPerms.featureEvents ? "Feature Events" : ""].filter(Boolean).join(", ")
                : "Full";
              return `
                <div class="users-row">
                  <div class="users-topline">
                    <div class="users-name">
                      <div class="users-avatar">
                        ${u.photoUrl ? `<img src="${esc(u.photoUrl)}" alt="${displayName}" />` : `<span>${initials}</span>`}
                      </div>
                      <div class="users-copy">
                        <div class="users-primary">${onlineStatusMarkup(u.lastSeenAt, `${u.username || u.email || "User"} status`)}<span>${displayName}</span></div>
                        <div class="users-secondary">${emailLabel}</div>
                      </div>
                    </div>
                    <div class="users-actions"><button class="users-actions-trigger" type="button" data-open-user-modal="${modalId}">Actions</button></div>
                  </div>
                  <div class="users-meta">
                    <div class="users-meta-item"><span class="users-status"><span class="users-status-dot" style="background:${statusColor};"></span><span>${statusTone}</span></span></div>
                    <div class="users-meta-item"><span>Role:</span><strong>${esc(labelRole)}</strong></div>
                    <div class="users-meta-item"><span>City:</span><strong>${cityLabel}</strong></div>
                    <div class="users-meta-item"><span>Access:</span><strong>${esc(accessSummary)}</strong></div>
                  </div>

                  <div class="users-modal" id="${modalId}" aria-hidden="true">
                    <div class="users-modal-backdrop" data-close-user-modal="${modalId}"></div>
                    <div class="users-modal-panel" role="dialog" aria-modal="true" aria-labelledby="${modalId}-title">
                      <div class="users-modal-top">
                        <div>
                          <h3 class="users-modal-title" id="${modalId}-title">${displayName}</h3>
                          <div class="users-modal-sub">${emailLabel}</div>
                        </div>
                        <button class="users-modal-close" type="button" aria-label="Close" data-close-user-modal="${modalId}">&times;</button>
                      </div>
                      <div class="users-modal-grid">
                        <div class="users-modal-main">
                          <div class="users-modal-card">
                            <div class="users-modal-label">Permission level</div>
                            <form id="${userFormId}" method="POST" action="/admin/users/${encodeURIComponent(u.id)}/role" style="display:grid; gap:14px;">
                              <select name="role" class="ctrl" style="width:100%;" data-organizer-role-select>
                                ${liveRoleOptionsMarkup(normalizedUserRole, { includeLegacySelected: true })}
                              </select>
                              <div>
                                <div class="users-modal-label" style="margin-bottom:6px;">Email</div>
                                <input type="email" name="email" class="ctrl" style="width:100%;" value="${esc(u.email || "")}" placeholder="name@example.com" />
                              </div>
                              <div>
                                <div class="users-modal-label">Area access</div>
                                <div class="users-modal-card" style="padding:14px 16px;">
                                  <div class="users-access-grid">
                                    ${ADMIN_AREAS.map((cityName) => `
                                      <label class="users-access-item">
                                        <input type="checkbox" name="cities" value="${esc(cityName)}" ${userCities.includes(cityName) ? "checked" : ""} form="${userFormId}" />
                                        <span>${esc(cityName)}</span>
                                      </label>
                                    `).join("")}
                                  </div>
                                </div>
                                <div class="note" style="margin-top:8px;">Users can work in every checked area. The first checked area remains their primary legacy area.</div>
                              </div>
                              <div data-organizer-permissions style="${normalizedUserRole === "organizer" ? "" : "display:none;"}">
                                <div class="users-modal-label">Section access</div>
                                <div class="users-modal-card" style="padding:14px 16px;">
                                  <div class="users-access-grid">
                                    ${ORGANIZER_SECTION_KEYS.map((section) => `
                                      <label class="users-access-item">
                                        <input type="checkbox" name="perm_${section}" value="1" ${userPerms[section] ? "checked" : ""} form="${userFormId}" />
                                        <span>${esc(formatOrganizerPermissionLabel(section))}</span>
                                      </label>
                                    `).join("")}
                                  </div>
                                </div>
                              </div>
                              <div style="display:flex; justify-content:flex-end;">
                                <button class="btn" type="submit" style="min-width:140px;">Update</button>
                              </div>
                            </form>
                          </div>
                        </div>
                        <div class="users-side-actions">
                          <form method="POST" action="/admin/users/${encodeURIComponent(u.id)}/resend-invite" onsubmit="return confirm('Resend invite email to this user?');">
                            <button class="btn" type="submit">Resend invite</button>
                          </form>
                          <form method="POST" action="/admin/users/${encodeURIComponent(u.id)}/reset" onsubmit="return confirm('Send a password reset email to this user?');">
                            <button class="btn" type="submit">Reset Password</button>
                          </form>
                          <form method="POST" action="/admin/users/${encodeURIComponent(u.id)}/delete" onsubmit="return confirm('Delete this user?');">
                            <button class="btn danger" type="submit">Delete</button>
                          </form>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              `;
            })
            .join("") +
          `</div></div>`
        : `<div class="users-empty">No users yet.</div>`;
      usersHtml += `<script>
        document.querySelectorAll('[data-open-user-modal]').forEach(function(button){
          button.addEventListener('click', function(){
            var modal = document.getElementById(button.getAttribute('data-open-user-modal'));
            if (!modal) return;
            modal.classList.add('open');
            modal.setAttribute('aria-hidden', 'false');
            document.body.style.overflow = 'hidden';
          });
        });
        document.querySelectorAll('[data-close-user-modal]').forEach(function(button){
          button.addEventListener('click', function(){
            var modal = document.getElementById(button.getAttribute('data-close-user-modal'));
            if (!modal) return;
            modal.classList.remove('open');
            modal.setAttribute('aria-hidden', 'true');
            document.body.style.overflow = '';
          });
        });
        document.addEventListener('keydown', function(event){
          if (event.key !== 'Escape') return;
          var openModal = document.querySelector('.users-modal.open');
          if (!openModal) return;
          openModal.classList.remove('open');
          openModal.setAttribute('aria-hidden', 'true');
          document.body.style.overflow = '';
        });
        document.querySelectorAll('[data-organizer-role-select]').forEach(function(select){
          function sync(){
            var modal = select.closest('.users-modal-panel');
            var permissions = modal && modal.querySelector('[data-organizer-permissions]');
            if (!permissions) return;
            permissions.style.display = String(select.value || '').toLowerCase() === 'organizer' ? '' : 'none';
          }
          select.addEventListener('change', sync);
          sync();
        });
      </script>`;
    }

    const messagesNotice = String(req.query.notice || "").trim().toLowerCase();
    const messagesNoticeHtml = messagesNotice === "sent"
      ? `<div class="mini" style="margin-bottom:12px; border-color:rgba(16,185,129,.35); color:#065f46;">Message sent.</div>`
      : messagesNotice === "empty"
      ? `<div class="mini" style="margin-bottom:12px; border-color:rgba(239,68,68,.35); color:#991b1b;">Message cannot be empty.</div>`
      : messagesNotice === "recipient"
      ? `<div class="mini" style="margin-bottom:12px; border-color:rgba(239,68,68,.35); color:#991b1b;">Choose a valid user in your city.</div>`
      : "";

    const messageContactsHtml = messageContacts.length
      ? messageContacts.map((user) => {
          const name = user.supportAlias ? "Support Circle" : (user.displayName || user.username || user.email || "User");
          const href = `/admin/messages?user=${encodeURIComponent(String(user.id))}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}`;
          const latestLabel = user.latestAt
            ? fmtPendingDate(user.latestAt)
            : (user.supportAlias ? "Troubleshooting chat" : `${user.city || selectedCity} user`);
          return `
            <a class="message-user-link ${Number(user.id) === Number(selectedMessageContactId) ? "active" : ""}" href="${href}">
              ${user.photoUrl
                ? `<img class="message-user-avatar" src="${esc(user.photoUrl)}" alt="${esc(name)}" />`
                : `<div class="message-user-avatar" aria-hidden="true"></div>`}
              <div class="message-user-copy">
                <div class="message-user-name">${onlineStatusMarkup(user.lastSeenAt, `${name} status`)}<span>${esc(name)}</span></div>
                <div class="message-user-meta">${esc(latestLabel)}</div>
              </div>
              ${Number(user.unreadCount || 0) > 0 ? `<span class="message-unread">${Number(user.unreadCount) > 99 ? "99+" : Number(user.unreadCount)}</span>` : ``}
            </a>
          `;
        }).join("")
      : `<div class="messages-empty">No other users are available in ${esc(selectedCity)} yet.</div>`;

    const messageConversationHtml = selectedMessageContact
      ? (messageConversationRows.length
        ? messageConversationRows.map((row) => {
            const mine = Number(row.senderUserId) === Number(currentUser?.id || 0);
            const senderName = selectedMessageContact?.supportAlias && Number(row.senderUserId) === Number(selectedMessageContact.id)
              ? "Support Circle"
              : (row.senderDisplayName || row.senderUsername || row.senderEmail || "User");
            const readMarkup = mine && row.readAt
              ? `<span class="message-read-indicator">&#10003; Read</span>`
              : ``;
            return `
              <div class="message-bubble ${mine ? "mine" : ""}">
                <div>${esc(row.body || "")}</div>
                <div class="meta">
                  <span>${esc(mine ? "You" : senderName)} · ${esc(fmtPendingDate(row.createdAt))}</span>
                  ${readMarkup}
                </div>
              </div>
            `;
          }).join("")
        : `<div class="messages-empty">No messages yet. Start the conversation below.</div>`)
      : `<div class="messages-empty">Choose a user in ${esc(selectedCity)} to start messaging.</div>`;

    const messagesDashboardHtml = recentMessageThreads.length
      ? recentMessageThreads.map((user) => {
          const name = user.supportAlias ? "Support Circle" : (user.displayName || user.username || user.email || "User");
          return `
            <div class="insight-row">
              <div class="label">
                <a href="/admin/messages?user=${encodeURIComponent(String(user.id))}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}" style="display:inline-flex; align-items:center; gap:8px; color:inherit; text-decoration:none;">
                  ${onlineStatusMarkup(user.lastSeenAt, `${name} status`)}
                  <span>${esc(name)}</span>
                </a>
              </div>
              <div class="value">${Number(user.unreadCount || 0) > 0 ? `${Number(user.unreadCount)} unread` : esc(user.latestAt ? fmtPendingDate(user.latestAt) : "No messages")}</div>
            </div>
          `;
        }).join("")
      : `<div class="muted">No recent messages in ${esc(selectedCity)} yet.</div>`;

    function buildActivityHref(basePath, term) {
      const sp = new URLSearchParams();
      if (selectedCity) sp.set("city", selectedCity);
      if (term) sp.set("q", String(term));
      return `${basePath}?${sp.toString()}`;
    }

    function getActivityAuthorLabel(row) {
      const name = row?.displayName || row?.username || row?.email || "";
      return name ? `Posted by ${name}` : "Posted by Legacy post";
    }

    let activityDashboardHtml = `<div class="muted">No recent activity in ${esc(selectedCity)} yet.</div>`;
    try {
      const activityItems = [];
      const eventActivityWhere = [];
      const eventActivityParams = [];
      if (selectedCity) {
        eventActivityWhere.push("e.city = ?");
        eventActivityParams.push(selectedCity);
      }
      if (organizerOwnerClause) {
        eventActivityWhere.push(
          organizerOwnerClause.sql.replace(/\borganizer\b/g, "e.organizer")
        );
        eventActivityParams.push(...organizerOwnerClause.params);
      }
      const eventActivityWhereSql = eventActivityWhere.length ? `WHERE ${eventActivityWhere.join(" AND ")}` : "";

      if (canManageEvents) {
        try {
          const eventActivityCols = await getEventsColumns();
          const eventCreatedExpr = eventActivityCols.has("createdAt")
            ? "e.createdAt"
            : (eventActivityCols.has("updatedAt")
              ? "e.updatedAt"
              : "e.startDateTime");
          const eventCreatorJoin = eventActivityCols.has("createdByUserId")
            ? "LEFT JOIN users u ON u.id = e.createdByUserId"
            : "";
          const eventCreatorSelect = eventActivityCols.has("createdByUserId")
            ? "u.displayName, u.username, u.email"
            : "NULL AS displayName, NULL AS username, NULL AS email";
          const rows = await all(
            `SELECT e.id, e.slug, e.title, e.location, ${eventCreatedExpr} AS createdAt, e.createdByUserId,
                    ${eventCreatorSelect}
               FROM events e
               ${eventCreatorJoin}
               ${eventActivityWhereSql}
               ORDER BY datetime(COALESCE(${eventCreatedExpr}, '1970-01-01')) DESC, e.id DESC
               LIMIT 8`,
            eventActivityParams
          );
          rows.forEach((row) => {
            activityItems.push({
              type: "Event",
              title: row.title || "Untitled event",
              meta: `${row.location || selectedCity} · ${getActivityAuthorLabel(row)}`,
              createdAt: row.createdAt,
              href: buildActivityHref("/admin/existing-events", row.slug || row.title || row.id),
              isOwnEvent: Number(row.createdByUserId || 0) === Number(currentUser?.id || 0),
            });
          });
        } catch (err) {
          console.error("[admin activity events]", err);
        }
      }

      if (isOrganizerUser) {
        try {
          const organizerSubmissionWhere = [];
          const organizerSubmissionParams = [];
          if (selectedCity) {
            organizerSubmissionWhere.push("city = ?");
            organizerSubmissionParams.push(selectedCity);
          }
          const organizerSubmissionParts = [];
          if (currentUser?.email) {
            organizerSubmissionParts.push("lower(COALESCE(submitterEmail,'')) = lower(?)");
            organizerSubmissionParams.push(String(currentUser.email));
          }
          if (organizerOwnerClause) {
            organizerSubmissionParts.push(organizerOwnerClause.sql);
            organizerSubmissionParams.push(...organizerOwnerClause.params);
          }
          if (organizerSubmissionParts.length) {
            organizerSubmissionWhere.push(`(${organizerSubmissionParts.join(" OR ")})`);
          }
          const organizerSubmissionWhereSql = organizerSubmissionWhere.length
            ? `WHERE ${organizerSubmissionWhere.join(" AND ")}`
            : "";
          const rows = await all(
            `SELECT id, title, location, organizer, submitterEmail, createdAt
               FROM pending_events
               ${organizerSubmissionWhereSql}
              ORDER BY datetime(COALESCE(createdAt, '1970-01-01')) DESC, id DESC
              LIMIT 6`,
            organizerSubmissionParams
          );
          rows.forEach((row) => {
            const submitter = row.submitterEmail
              ? `Submitted by ${row.submitterEmail}`
              : (row.organizer ? `Submitted for ${row.organizer}` : "Submitted for review");
            activityItems.push({
              type: "Submission",
              title: row.title || "Untitled event submission",
              meta: `${row.location || selectedCity} · ${submitter}`,
              createdAt: row.createdAt,
              href: buildActivityHref("/admin/existing-events", row.title || row.id),
            });
          });
        } catch (err) {
          console.error("[admin activity organizer submissions]", err);
        }
      } else if (canApproveEvents) {
        try {
          const rows = await all(
            `SELECT id, title, location, organizer, submitterEmail, createdAt
               FROM pending_events
              WHERE city = ?
              ORDER BY datetime(COALESCE(createdAt, '1970-01-01')) DESC, id DESC
              LIMIT 6`,
            [selectedCity]
          );
          rows.forEach((row) => {
            const submitter = row.submitterEmail ? `Submitted by ${row.submitterEmail}` : (row.organizer ? `Submitted for ${row.organizer}` : "Submitted for review");
            activityItems.push({
              type: "Submission",
              title: row.title || "Untitled event submission",
              meta: `${row.location || selectedCity} · ${submitter}`,
              createdAt: row.createdAt,
              href: buildActivityHref("/admin/approve-events", row.title || row.id),
            });
          });
        } catch (err) {
          console.error("[admin activity submissions]", err);
        }
      }

      if (canManageVenues) {
        try {
          const venueActivityCols = await getVenueColumns();
          const venueCreatorJoin = venueActivityCols.has("createdByUserId")
            ? "LEFT JOIN users u ON u.id = v.createdByUserId"
            : "";
          const venueCreatorSelect = venueActivityCols.has("createdByUserId")
            ? "u.displayName, u.username, u.email"
            : "NULL AS displayName, NULL AS username, NULL AS email";
          const venueActivityWhere = ["v.city = ?"];
          const venueActivityParams = [selectedCity];
          if (isOrganizerUser && organizerVenueOwnerClause) {
            venueActivityWhere.push(`v.${organizerVenueOwnerClause.sql}`);
            venueActivityParams.push(...organizerVenueOwnerClause.params);
          }
          const rows = await all(
            `SELECT v.id, v.slug, v.name, v.address, v.createdAt,
                    ${venueCreatorSelect}
               FROM venues v
               ${venueCreatorJoin}
              WHERE ${venueActivityWhere.join(" AND ")}
              ORDER BY datetime(COALESCE(v.createdAt, '1970-01-01')) DESC, v.id DESC
              LIMIT 6`,
            venueActivityParams
          );
          rows.forEach((row) => {
            activityItems.push({
              type: "Venue",
              title: row.name || "Untitled venue",
              meta: `${row.address || selectedCity} · ${getActivityAuthorLabel(row)}`,
              createdAt: row.createdAt,
              href: buildActivityHref("/admin/venues", row.slug || row.name || row.id),
            });
          });
        } catch (err) {
          console.error("[admin activity venues]", err);
        }
      }

      if (canManageJobs) {
        try {
          const jobActivityCols = await getJobColumns();
          const jobCreatorJoin = jobActivityCols.has("createdByUserId")
            ? "LEFT JOIN users u ON u.id = j.createdByUserId"
            : "";
          const jobCreatorSelect = jobActivityCols.has("createdByUserId")
            ? "u.displayName, u.username, u.email"
            : "NULL AS displayName, NULL AS username, NULL AS email";
          const jobActivityWhere = ["j.city = ?"];
          const jobActivityParams = [selectedCity];
          if (isOrganizerUser && organizerVenueOwnerClause) {
            jobActivityWhere.push(`j.${organizerVenueOwnerClause.sql}`);
            jobActivityParams.push(...organizerVenueOwnerClause.params);
          }
          const rows = await all(
            `SELECT j.id, j.slug, j.title, j.company, j.createdAt,
                    ${jobCreatorSelect}
               FROM jobs j
               ${jobCreatorJoin}
              WHERE ${jobActivityWhere.join(" AND ")}
              ORDER BY datetime(COALESCE(j.createdAt, '1970-01-01')) DESC, j.id DESC
              LIMIT 6`,
            jobActivityParams
          );
          rows.forEach((row) => {
            activityItems.push({
              type: "Job",
              title: row.title || "Untitled job",
              meta: `${row.company || selectedCity} · ${getActivityAuthorLabel(row)}`,
              createdAt: row.createdAt,
              href: buildActivityHref("/admin/jobs", row.slug || row.title || row.id),
            });
          });
        } catch (err) {
          console.error("[admin activity jobs]", err);
        }
      }

      if (canManageAds) {
        try {
          const adActivityCols = await getAdColumns();
          const adCreatorJoin = adActivityCols.has("createdByUserId")
            ? "LEFT JOIN users u ON u.id = a.createdByUserId"
            : "";
          const adCreatorSelect = adActivityCols.has("createdByUserId")
            ? "u.displayName, u.username, u.email"
            : "NULL AS displayName, NULL AS username, NULL AS email";
          const rows = await all(
            `SELECT a.id, a.slug, a.name, a.placement, a.createdAt,
                    ${adCreatorSelect}
               FROM ads a
               ${adCreatorJoin}
              WHERE a.city = ?
              ORDER BY datetime(COALESCE(a.createdAt, '1970-01-01')) DESC, a.id DESC
              LIMIT 6`,
            [selectedCity]
          );
          rows.forEach((row) => {
            activityItems.push({
              type: "Ad",
              title: row.name || "Untitled ad",
              meta: `${row.placement || selectedCity} · ${getActivityAuthorLabel(row)}`,
              createdAt: row.createdAt,
              href: buildActivityHref("/admin/ads", row.slug || row.name || row.id),
            });
          });
        } catch (err) {
          console.error("[admin activity ads]", err);
        }
      }

      const sortedActivityItems = activityItems.slice().sort((a, b) => {
        const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bTime - aTime;
      });
      let activityCardItems = sortedActivityItems.slice(0, 5);
      const mostRecentEvent = sortedActivityItems.find((item) => item.type === "Event");
      const mostRecentOwnEvent = sortedActivityItems.find((item) => item.type === "Event" && item.isOwnEvent);
      const guaranteedItems = [mostRecentOwnEvent, mostRecentEvent].filter(Boolean);
      if (
        guaranteedItems.length &&
        guaranteedItems.some((candidate) => !activityCardItems.includes(candidate))
      ) {
        const seen = new Set();
        activityCardItems = [...guaranteedItems, ...activityCardItems]
          .filter((item) => {
            if (!item) return false;
            const key = `${item.type}|${item.href}|${item.createdAt || ""}|${item.title || ""}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          })
          .slice(0, 5);
      }

      activityDashboardHtml = activityCardItems.length
        ? activityCardItems
            .map((item) => `
              <a class="activity-item" href="${esc(item.href)}">
                <div class="activity-item-top">
                  <span class="activity-pill">${esc(item.type)}</span>
                  <span class="activity-time">${esc(fmtPendingDate(item.createdAt))}</span>
                </div>
                <div class="activity-title">${esc(item.title)}</div>
                <div class="activity-meta">${esc(item.meta || selectedCity)}</div>
              </a>
            `)
            .join("")
        : `<div class="muted">No recent activity in ${esc(selectedCity)} yet.</div>`;
    } catch (activityErr) {
      console.error("[admin activity]", activityErr);
    }

    let editJob = null;
    if (showJobsCreate && req.query.edit) {
      const jobId = parseInt(String(req.query.edit), 10);
      if (!Number.isNaN(jobId)) {
        const editJobWhereParts = ["id = ?"];
        const editJobParams = [jobId];
        if (isOrganizerUser && organizerVenueOwnerClause) {
          editJobWhereParts.push(organizerVenueOwnerClause.sql);
          editJobParams.push(...organizerVenueOwnerClause.params);
        }
        editJob = await get(`SELECT * FROM jobs WHERE ${editJobWhereParts.join(" AND ")}`, editJobParams);
      }
    }
    const editJobEmploymentTypes = getJobEmploymentTypesForEdit(editJob);
    const editJobApplicationMode = normalizeJobApplicationMode(editJob?.applicationMode || "external");
    const editJobApplicationFields = normalizeJobApplicationFields(safeParseJson(editJob?.applicationFieldsJson, null));

    let editVenue = null;
    if (showVenueCreate && req.query.edit) {
      const venueId = parseInt(String(req.query.edit), 10);
      if (!Number.isNaN(venueId)) {
        const editVenueWhereParts = ["id = ?"];
        const editVenueParams = [venueId];
        if (isOrganizerUser && organizerVenueOwnerClause) {
          editVenueWhereParts.push(organizerVenueOwnerClause.sql);
          editVenueParams.push(...organizerVenueOwnerClause.params);
        }
        editVenue = await get(`SELECT * FROM venues WHERE ${editVenueWhereParts.join(" AND ")}`, editVenueParams);
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
        if (editAd) {
          editAd.placements = normalizeAdPlacements(editAd.placementsJson, editAd.placement || "");
        }
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
    let bulkImportedRows = [];
    let bulkSkippedItems = [];
    let bulkErrorItems = [];

    if (showJobsExisting) {
      const jobWhere = [];
      const jobParams = [];
      if (selectedCity) {
        jobWhere.push("city = ?");
        jobParams.push(selectedCity);
      }
      if (isOrganizerUser && organizerVenueOwnerClause) {
        jobWhere.push(organizerVenueOwnerClause.sql);
        jobParams.push(...organizerVenueOwnerClause.params);
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
        "SELECT id, city, slug, title, company, location, employmentType, employmentTypesJson, salaryRange, applyUrl, imageUrl, description, status, applicationMode, applicationFieldsJson, viewCount, createdAt " +
        "FROM jobs " + jobWhereSql + " ORDER BY datetime(createdAt) DESC, id DESC LIMIT ? OFFSET ?",
        [...jobParams, limit, offset]
      );
    }

    if (showUpload) {
      const importedIds = String(req.query.importedIds || "")
        .split(",")
        .map((id) => parseInt(String(id || "").trim(), 10))
        .filter((id) => Number.isInteger(id) && id > 0)
        .slice(0, 20);
      if (importedIds.length) {
        const placeholders = importedIds.map(() => "?").join(",");
        const rows = await all(
          `SELECT id, title, startDateTime, endDateTime, location, organizer, slug
             FROM events
            WHERE id IN (${placeholders})
            ORDER BY id DESC`,
          importedIds
        );
        const rowMap = new Map((rows || []).map((row) => [Number(row.id || 0), row]));
        bulkImportedRows = importedIds.map((id) => rowMap.get(id)).filter(Boolean);
      }
      bulkSkippedItems = safeParseJson(req.query.bulkSkippedItems || "[]", []);
      if (!Array.isArray(bulkSkippedItems)) bulkSkippedItems = [];
      bulkSkippedItems = bulkSkippedItems.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 10);
      bulkErrorItems = safeParseJson(req.query.bulkErrorItems || "[]", []);
      if (!Array.isArray(bulkErrorItems)) bulkErrorItems = [];
      bulkErrorItems = bulkErrorItems.map((item) => String(item || "").trim()).filter(Boolean).slice(0, 10);
    }

    if (showJobsApplicants) {
      const applicantWhere = [];
      const applicantParams = [];
      if (selectedCity) {
        applicantWhere.push("j.city = ?");
        applicantParams.push(selectedCity);
      }
      if (isOrganizerUser && organizerVenueOwnerClause) {
        applicantWhere.push(`j.${organizerVenueOwnerClause.sql}`);
        applicantParams.push(...organizerVenueOwnerClause.params);
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
        "SELECT a.id, a.jobId, a.firstName, a.lastName, a.email, a.phone, a.resumeUrl, a.coverLetter, a.fieldsJson, a.status, a.source, a.createdAt, " +
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
      if (isOrganizerUser && organizerVenueOwnerClause) {
        jobCityWhere.push(organizerVenueOwnerClause.sql);
        jobCityParams.push(...organizerVenueOwnerClause.params);
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
        const jobApplicantWhere = [];
        const jobApplicantParams = [];
        if (selectedCity) {
          jobApplicantWhere.push("j.city = ?");
          jobApplicantParams.push(selectedCity);
        }
        if (isOrganizerUser && organizerVenueOwnerClause) {
          jobApplicantWhere.push(`j.${organizerVenueOwnerClause.sql}`);
          jobApplicantParams.push(...organizerVenueOwnerClause.params);
        }
        const applicantStatsRow = await get(
          "SELECT " +
          "COUNT(*) AS total, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'new' THEN 1 ELSE 0 END),0) AS newCount, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'reviewed' THEN 1 ELSE 0 END),0) AS reviewedCount, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'interview' THEN 1 ELSE 0 END),0) AS interviewCount, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'hired' THEN 1 ELSE 0 END),0) AS hiredCount, " +
          "COALESCE(SUM(CASE WHEN lower(COALESCE(a.status,'')) = 'rejected' THEN 1 ELSE 0 END),0) AS rejectedCount " +
          "FROM job_applicants a LEFT JOIN jobs j ON j.id = a.jobId " +
          (jobApplicantWhere.length ? "WHERE " + jobApplicantWhere.join(" AND ") : ""),
          jobApplicantParams
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

    if (showAdsExisting || showAdsAnalytics || showDashboard) {
      await ensureAdSchema();
      const adWhere = [];
      const adParams = [];
      if (selectedCity) {
        adWhere.push("city = ?");
        adParams.push(selectedCity);
      }
      if (q) {
        const like = "%" + q + "%";
        adWhere.push("(name LIKE ? OR slug LIKE ? OR placement LIKE ? OR COALESCE(placementsJson, '') LIKE ? OR targetUrl LIKE ? OR CAST(id AS TEXT) LIKE ?)");
        adParams.push(like, like, like, like, like, like);
      }
      const adWhereSql = adWhere.length ? ("WHERE " + adWhere.join(" AND ")) : "";
      const adTotalRow = await get("SELECT COUNT(*) AS n FROM ads " + adWhereSql, adParams);
      adTotal = Number(adTotalRow?.n || 0);
      adPages = Math.max(1, Math.ceil(adTotal / limit));
      adShowingFrom = adTotal ? offset + 1 : 0;
      adShowingTo = Math.min(offset + limit, adTotal);

      if (showAdsExisting) {
        adRows = await all(
          "SELECT id, city, slug, name, placement, placementsJson, imageUrl, targetUrl, altText, visibilityPercent, status, startsAt, endsAt, notes, viewCount, clickCount, createdAt " +
          "FROM ads " + adWhereSql + " ORDER BY datetime(createdAt) DESC, id DESC LIMIT ? OFFSET ?",
          [...adParams, limit, offset]
        );
        adRows = adRows.map((ad) => ({ ...ad, placements: normalizeAdPlacements(ad.placementsJson, ad.placement || "") }));
      }

      if (showAdsAnalytics || showDashboard) {
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
          "SELECT id, name, slug, placement, placementsJson, COALESCE(viewCount, 0) AS viewCount FROM ads " +
          adDashWhereSql + " ORDER BY COALESCE(viewCount,0) DESC, id DESC LIMIT 8",
          adDashParams
        );
        adTopClicksRows = await all(
          "SELECT id, name, slug, placement, placementsJson, COALESCE(clickCount, 0) AS clickCount FROM ads " +
          adDashWhereSql + " ORDER BY COALESCE(clickCount,0) DESC, id DESC LIMIT 8",
          adDashParams
        );
        adAnalyticsOptions = await all(
          "SELECT id, name, slug, placement, placementsJson, COALESCE(viewCount,0) AS viewCount, COALESCE(clickCount,0) AS clickCount FROM ads " +
          adDashWhereSql + " ORDER BY name COLLATE NOCASE ASC, id ASC",
          adDashParams
        );
        adTopViewsRows = adTopViewsRows.map((ad) => ({ ...ad, placements: normalizeAdPlacements(ad.placementsJson, ad.placement || "") }));
        adTopClicksRows = adTopClicksRows.map((ad) => ({ ...ad, placements: normalizeAdPlacements(ad.placementsJson, ad.placement || "") }));
        adAnalyticsOptions = adAnalyticsOptions.map((ad) => ({ ...ad, placements: normalizeAdPlacements(ad.placementsJson, ad.placement || "") }));
        {
          const placementCounts = new Map();
          for (const ad of adAnalyticsOptions) {
            for (const placement of ad.placements || []) {
              placementCounts.set(placement, Number(placementCounts.get(placement) || 0) + 1);
            }
          }
          adPlacementRows = [...placementCounts.entries()]
            .map(([placement, n]) => ({ placement, n }))
            .sort((a, b) => Number(b.n || 0) - Number(a.n || 0) || String(a.placement).localeCompare(String(b.placement)));
        }

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
      if (isOrganizerUser && organizerVenueOwnerClause) {
        venueWhere.push(organizerVenueOwnerClause.sql);
        venueParams.push(...organizerVenueOwnerClause.params);
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
    function buildAdChartSvg(metric = "views") {
      const labels = adMonthlyHistory.map((row) => String(row.label || ""));
      const primaryValues = adMonthlyHistory.map((row) =>
        Number(metric === "clicks" ? row.clicks || 0 : row.views || 0)
      );
      const secondaryValues = adMonthlyHistory.map((row) =>
        Number(metric === "clicks" ? row.views || 0 : row.clicks || 0)
      );
      const allValues = primaryValues.concat(secondaryValues).filter((v) => Number.isFinite(v));
      const width = 1200;
      const height = 260;
      const padL = 56;
      const padR = 18;
      const padT = 18;
      const padB = 42;
      const plotW = width - padL - padR;
      const plotH = height - padT - padB;
      const textColor = "#475569";
      const viewsColor = "rgba(16,185,129,.82)";
      const clicksColor = "rgba(37,99,235,.72)";
      const primaryColor = metric === "views" ? viewsColor : clicksColor;
      const secondaryColor = metric === "views" ? clicksColor : viewsColor;

      if (!labels.length || !allValues.some((v) => v > 0)) {
        return `
          <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display:block; width:100%; height:100%;" preserveAspectRatio="none" role="img" aria-label="Ad chart">
            <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
            <text x="18" y="90" fill="rgba(15,23,42,.75)" font-size="14" font-weight="600" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">No monthly ad history yet</text>
          </svg>
        `;
      }

      const maxValue = Math.max(1, ...allValues);
      const tickCount = Math.min(6, maxValue);
      const tickStep = Math.max(1, Math.ceil(maxValue / tickCount));
      const yMax = tickStep * tickCount;
      const stepX = labels.length <= 1 ? 0 : plotW / (labels.length - 1);
      const primaryPoints = labels.map((label, index) => {
        const value = Number(primaryValues[index] || 0);
        const x = padL + stepX * index;
        const y = padT + plotH - ((value / yMax) * plotH);
        return { x, y, value };
      });
      const secondaryPoints = labels.map((label, index) => {
        const value = Number(secondaryValues[index] || 0);
        const x = padL + stepX * index;
        const y = padT + plotH - ((value / yMax) * plotH);
        return { x, y, value };
      });
      function buildSmoothSvgPath(points) {
        if (!points.length) return "";
        if (points.length === 1) {
          return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        }
        let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[i - 1] || points[i];
          const p1 = points[i];
          const p2 = points[i + 1];
          const p3 = points[i + 2] || p2;
          const cp1x = p1.x + (p2.x - p0.x) / 6;
          const cp1y = Math.max(padT, Math.min(padT + plotH, p1.y + (p2.y - p0.y) / 6));
          const cp2x = p2.x - (p3.x - p1.x) / 6;
          const cp2y = Math.max(padT, Math.min(padT + plotH, p2.y - (p3.y - p1.y) / 6));
          path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
        }
        return path;
      }
      const primaryPath = buildSmoothSvgPath(primaryPoints);
      const secondaryPath = buildSmoothSvgPath(secondaryPoints);
      const fillPath = primaryPoints.length
        ? `M ${primaryPoints[0].x.toFixed(2)} ${(padT + plotH).toFixed(2)} L ${primaryPoints[0].x.toFixed(2)} ${primaryPoints[0].y.toFixed(2)} ` +
          primaryPath.replace(/^M [^ ]+ [^ ]+ ?/, "") +
          ` L ${primaryPoints[primaryPoints.length - 1].x.toFixed(2)} ${(padT + plotH).toFixed(2)} Z`
        : "";
      const labelStep = labels.length <= 4 ? 1 : Math.ceil(labels.length / 4);

      return `
        <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display:block; width:100%; height:100%;" preserveAspectRatio="none" role="img" aria-label="Ad chart">
          <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
          ${Array.from({ length: tickCount + 1 }).map((_, i) => {
            const value = i * tickStep;
            const y = padT + plotH - ((value / yMax) * plotH);
            return `
              <line x1="${padL}" y1="${y.toFixed(2)}" x2="${(padL + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(15,23,42,.08)" stroke-width="1"></line>
              <text x="18" y="${(y + 4).toFixed(2)}" fill="${textColor}" font-size="12" font-weight="500" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">${value}</text>
            `;
          }).join("")}
          ${fillPath ? `<path d="${fillPath}" fill="${metric === "views" ? "rgba(16,185,129,.10)" : "rgba(37,99,235,.08)"}"></path>` : ""}
          ${secondaryPath ? `<path d="${secondaryPath}" fill="none" stroke="${secondaryColor}" stroke-width="2" stroke-dasharray="6 6" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
          ${primaryPath ? `<path d="${primaryPath}" fill="none" stroke="${primaryColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
          ${labels.map((label, index) => {
            if (index !== labels.length - 1 && index % labelStep !== 0) return "";
            const anchor = index === labels.length - 1 ? "end" : (index === 0 ? "start" : "middle");
            return `<text x="${primaryPoints[index].x.toFixed(2)}" y="${(padT + plotH + 30).toFixed(2)}" text-anchor="${anchor}" fill="${textColor}" font-size="12" font-weight="500" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">${esc(String(label || ""))}</text>`;
          }).join("")}
        </svg>
      `;
    }
    const adChartSvgViews = buildAdChartSvg("views");
    const adChartSvgClicks = buildAdChartSvg("clicks");

    // Organizer analytics
    let organizerLeaderboard = [];
    let organizerAnalyticsOptions = [];
    let selectedOrganizer = "";
    let organizerPageSummary = {
      uniqueEvents: 0,
      totalOccurrences: 0,
      upcomingOccurrences: 0,
      views: 0,
      featured: 0,
      allViews: 0,
      directViews: 0,
      referralViews: 0,
      internalViews: 0,
    };
    let organizerSummary = {
      uniqueEvents: 0,
      totalOccurrences: 0,
      upcomingOccurrences: 0,
      views: 0,
      featured: 0,
      allViews: 0,
      directViews: 0,
      referralViews: 0,
      internalViews: 0,
    };
    let organizerChartDataJson = JSON.stringify({
      events: { labels: [], values: [] },
      views: { labels: [], values: [] },
    });
    let organizerChartLabels = [];
    let organizerChartEventValues = [];
    let organizerChartViewValues = [];
    function buildOrganizerChartSvg(labelsInput = [], eventValuesInput = [], viewValuesInput = []) {
      const labels = Array.isArray(labelsInput) ? labelsInput.map((row) => String(row || "")) : [];
      const eventValues = Array.isArray(eventValuesInput) ? eventValuesInput.map((row) => Number(row || 0)) : [];
      const viewValues = Array.isArray(viewValuesInput) ? viewValuesInput.map((row) => Number(row || 0)) : [];
      const allValues = eventValues.concat(viewValues).filter((v) => Number.isFinite(v));
      const width = 1200;
      const height = 260;
      const padL = 56;
      const padR = 18;
      const padT = 18;
      const padB = 42;
      const plotW = width - padL - padR;
      const plotH = height - padT - padB;
      const textColor = "#475569";
      const eventsColor = "rgba(16,185,129,.82)";
      const viewsColor = "rgba(37,99,235,.72)";

      if (!labels.length || !allValues.some((v) => v > 0)) {
        return `
          <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display:block; width:100%; height:100%;" preserveAspectRatio="none" role="img" aria-label="Organizer chart">
            <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
            <text x="18" y="90" fill="rgba(15,23,42,.75)" font-size="14" font-weight="600" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">No organizer history yet</text>
          </svg>
        `;
      }

      const maxValue = Math.max(1, ...allValues);
      const tickCount = Math.min(6, maxValue);
      const tickStep = Math.max(1, Math.ceil(maxValue / tickCount));
      const yMax = tickStep * tickCount;
      const stepX = labels.length <= 1 ? 0 : plotW / (labels.length - 1);
      const eventPoints = labels.map((label, index) => {
        const value = Number(eventValues[index] || 0);
        return {
          x: padL + stepX * index,
          y: padT + plotH - ((value / yMax) * plotH),
          value,
        };
      });
      const viewPoints = labels.map((label, index) => {
        const value = Number(viewValues[index] || 0);
        return {
          x: padL + stepX * index,
          y: padT + plotH - ((value / yMax) * plotH),
          value,
        };
      });
      function buildSmoothSvgPath(points) {
        if (!points.length) return "";
        if (points.length === 1) return `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        let path = `M ${points[0].x.toFixed(2)} ${points[0].y.toFixed(2)}`;
        for (let i = 0; i < points.length - 1; i++) {
          const p0 = points[i - 1] || points[i];
          const p1 = points[i];
          const p2 = points[i + 1];
          const p3 = points[i + 2] || p2;
          const cp1x = p1.x + (p2.x - p0.x) / 6;
          const cp1y = Math.max(padT, Math.min(padT + plotH, p1.y + (p2.y - p0.y) / 6));
          const cp2x = p2.x - (p3.x - p1.x) / 6;
          const cp2y = Math.max(padT, Math.min(padT + plotH, p2.y - (p3.y - p1.y) / 6));
          path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
        }
        return path;
      }
      const eventPath = buildSmoothSvgPath(eventPoints);
      const viewPath = buildSmoothSvgPath(viewPoints);
      const fillPath = eventPoints.length
        ? `M ${eventPoints[0].x.toFixed(2)} ${(padT + plotH).toFixed(2)} L ${eventPoints[0].x.toFixed(2)} ${eventPoints[0].y.toFixed(2)} ` +
          eventPath.replace(/^M [^ ]+ [^ ]+ ?/, "") +
          ` L ${eventPoints[eventPoints.length - 1].x.toFixed(2)} ${(padT + plotH).toFixed(2)} Z`
        : "";
      const labelStep = labels.length <= 4 ? 1 : Math.ceil(labels.length / 4);

      return `
        <svg viewBox="0 0 ${width} ${height}" width="100%" height="100%" style="display:block; width:100%; height:100%;" preserveAspectRatio="none" role="img" aria-label="Organizer chart">
          <rect x="0" y="0" width="${width}" height="${height}" fill="transparent"></rect>
          ${Array.from({ length: tickCount + 1 }).map((_, i) => {
            const value = i * tickStep;
            const y = padT + plotH - ((value / yMax) * plotH);
            return `
              <line x1="${padL}" y1="${y.toFixed(2)}" x2="${(padL + plotW).toFixed(2)}" y2="${y.toFixed(2)}" stroke="rgba(15,23,42,.08)" stroke-width="1"></line>
              <text x="18" y="${(y + 4).toFixed(2)}" fill="${textColor}" font-size="12" font-weight="500" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">${value}</text>
            `;
          }).join("")}
          ${fillPath ? `<path d="${fillPath}" fill="rgba(16,185,129,.10)"></path>` : ""}
          ${viewPath ? `<path d="${viewPath}" fill="none" stroke="${viewsColor}" stroke-width="2" stroke-dasharray="6 6" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
          ${eventPath ? `<path d="${eventPath}" fill="none" stroke="${eventsColor}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"></path>` : ""}
          ${labels.map((label, index) => {
            if (index !== labels.length - 1 && index % labelStep !== 0) return "";
            const anchor = index === labels.length - 1 ? "end" : (index === 0 ? "start" : "middle");
            return `<text x="${eventPoints[index].x.toFixed(2)}" y="${(padT + plotH + 30).toFixed(2)}" text-anchor="${anchor}" fill="${textColor}" font-size="12" font-weight="500" font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif">${esc(String(label || ""))}</text>`;
          }).join("")}
        </svg>
      `;
    }
    let organizerChartTitle = "All organizers performance";
    let organizerInsightsHeading = "Organizer overview";
    let organizerInsightsSub = "Click an organizer name to drill into one organizer";
    let organizerTopEventsTitle = "Top events across organizers";
    let organizerSelectionHtml = `<div class="mini">Click any organizer name below to view detailed insights.</div>`;
    let organizerLeaderboardHtml = `<tr><td colspan="6" class="muted">No organizers found.</td></tr>`;
    let organizerTopEventsHtml = `<div class="muted">No organizer events yet.</div>`;

    if (showOrganizers) {
      const organizerWhereParts = [];
      const organizerWhereParams = [];
      if (selectedCity) {
        organizerWhereParts.push("city = ?");
        organizerWhereParams.push(selectedCity);
      }
      if (hasArchiveCols2) {
        organizerWhereParts.push("(isArchived IS NULL OR isArchived = 0)");
      }
      const organizerWhereSql = organizerWhereParts.length ? `WHERE ${organizerWhereParts.join(" AND ")}` : "";
      let organizerEventRows = await all(
        `SELECT id, title, organizer, startDateTime, endDateTime, hasRecurrence, recurrenceRule, recurrenceDates,
                recurrenceStartDate, recurrenceUntilDate, featured, viewCount
         FROM events
         ${organizerWhereSql}
         ORDER BY datetime(startDateTime) ASC`,
        organizerWhereParams
      );
      organizerEventRows = (organizerEventRows || []).map((row) => normalizeRowTimes(row));
      const buildOrganizerInsightsHref = (name) =>
        `/admin/events-organizers?organizer=${encodeURIComponent(String(name || ""))}${selectedCity ? `&city=${encodeURIComponent(selectedCity)}` : ""}`;

      const organizerMap = new Map();
      const nowMs = Date.now();
      const upcomingEndMs = nowMs + 90 * 86400 * 1000;
      const monthStartMs = new Date(new Date().getFullYear(), new Date().getMonth() - 11, 1, 0, 0, 0, 0).getTime();
      const monthEndMs = endOfCurrentMonthUtcMs();

      for (const row of organizerEventRows) {
        const organizerName = String(row?.organizer || "").trim() || "(unknown)";
        let entry = organizerMap.get(organizerName);
        if (!entry) {
          entry = {
            organizer: organizerName,
            uniqueEvents: 0,
            totalOccurrences: 0,
            upcomingOccurrences: 0,
            views: 0,
            featured: 0,
            monthlyEvents: new Map(),
            rows: [],
          };
          organizerMap.set(organizerName, entry);
        }

        entry.uniqueEvents += 1;
        entry.views += Number(row?.viewCount || 0);
        entry.featured += Number(row?.featured || 0) === 1 ? 1 : 0;
        entry.rows.push(row);

        const isRecurring = hasRecurringData(row);
        if (!isRecurring) {
          const startUtc = Date.parse(String(row?.startDateTime || ""));
          if (Number.isFinite(startUtc)) {
            entry.totalOccurrences += 1;
            if (startUtc >= nowMs) entry.upcomingOccurrences += 1;
            if (startUtc >= monthStartMs && startUtc <= monthEndMs) {
              const parts = parseIsoParts(row?.startDateTime || "");
              if (parts) {
                const ym = `${parts.year}-${pad2(parts.month)}`;
                entry.monthlyEvents.set(ym, Number(entry.monthlyEvents.get(ym) || 0) + 1);
              }
            }
          }
          continue;
        }

        const startUtc = Date.parse(String(row?.startDateTime || ""));
        const totalWindowEndMs = getRecurringSeriesEndUtcMs(row, monthEndMs);
        const totalOccurrences = generateAdminOccurrences(
          row,
          Number.isFinite(startUtc) ? startUtc : monthStartMs,
          totalWindowEndMs
        );
        entry.totalOccurrences += totalOccurrences.length || 1;

        const upcomingOccurrences = generateAdminOccurrences(row, nowMs - 5 * 60 * 1000, upcomingEndMs);
        entry.upcomingOccurrences += upcomingOccurrences.length;

        const monthlyOccurrences = generateAdminOccurrences(row, monthStartMs, monthEndMs);
        for (const occ of monthlyOccurrences) {
          const parts = occ.parts || parseIsoParts(occ.startDateTime || "");
          if (!parts) continue;
          const ym = `${parts.year}-${pad2(parts.month)}`;
          entry.monthlyEvents.set(ym, Number(entry.monthlyEvents.get(ym) || 0) + 1);
        }
      }

      organizerLeaderboard = [...organizerMap.values()].sort((a, b) =>
        Number(b.views || 0) - Number(a.views || 0) ||
        Number(b.totalOccurrences || 0) - Number(a.totalOccurrences || 0) ||
        String(a.organizer || "").localeCompare(String(b.organizer || ""))
      );
      organizerAnalyticsOptions = organizerLeaderboard.map((row) => row.organizer);
      const requestedOrganizer = String(req.query.organizer || "").trim();
      selectedOrganizer = organizerAnalyticsOptions.find((name) => name === requestedOrganizer) || "";

      organizerPageSummary = organizerLeaderboard.reduce((acc, row) => {
        acc.uniqueEvents += Number(row.uniqueEvents || 0);
        acc.totalOccurrences += Number(row.totalOccurrences || 0);
        acc.upcomingOccurrences += Number(row.upcomingOccurrences || 0);
        acc.views += Number(row.views || 0);
        acc.featured += Number(row.featured || 0);
        return acc;
      }, {
        uniqueEvents: 0,
        totalOccurrences: 0,
        upcomingOccurrences: 0,
        views: 0,
        featured: 0,
        allViews: 0,
        directViews: 0,
        referralViews: 0,
        internalViews: 0,
      });

      if (hasSourceTrackingTable) {
        try {
          const overallSourceRow = await get(
            `SELECT
               COUNT(*) AS tracked,
               COALESCE(SUM(CASE WHEN COALESCE(ev.ref,'') LIKE '[src:direct%' OR COALESCE(ev.ref,'') = '__direct__' OR trim(COALESCE(ev.ref,'')) = '' THEN 1 ELSE 0 END), 0) AS directCount,
               COALESCE(SUM(CASE WHEN COALESCE(ev.ref,'') LIKE '[src:referral%' THEN 1 ELSE 0 END), 0) AS referralCount,
               COALESCE(SUM(CASE WHEN COALESCE(ev.ref,'') LIKE '[src:internal%' THEN 1 ELSE 0 END), 0) AS internalCount
             FROM event_views ev
             JOIN events e ON e.id = ev.eventId
             WHERE 1=1
             ${selectedCity ? "AND e.city = ?" : ""}
             ${hasArchiveCols2 ? "AND (e.isArchived IS NULL OR e.isArchived = 0)" : ""}`,
            selectedCity ? [selectedCity] : []
          );
          organizerPageSummary.allViews = Number(overallSourceRow?.tracked || 0);
          organizerPageSummary.directViews = Number(overallSourceRow?.directCount || 0);
          organizerPageSummary.referralViews = Number(overallSourceRow?.referralCount || 0);
          organizerPageSummary.internalViews = Number(overallSourceRow?.internalCount || 0);
        } catch (_) {}
      }

      organizerLeaderboardHtml = organizerLeaderboard.slice(0, 10).map((row, index) => `
        <tr>
          <td>${index + 1}</td>
          <td><a href="${esc(buildOrganizerInsightsHref(row.organizer))}">${esc(row.organizer)}</a></td>
          <td>${Number(row.uniqueEvents || 0).toLocaleString("en-US")}</td>
          <td>${Number(row.totalOccurrences || 0).toLocaleString("en-US")}</td>
          <td>${Number(row.upcomingOccurrences || 0).toLocaleString("en-US")}</td>
          <td>${Number(row.views || 0).toLocaleString("en-US")}</td>
        </tr>
      `).join("") || organizerLeaderboardHtml;

      organizerTopEventsHtml = [...organizerEventRows]
        .sort((a, b) => Number(b.viewCount || 0) - Number(a.viewCount || 0) || Number(b.id || 0) - Number(a.id || 0))
        .slice(0, 5)
        .map((row) => `
          <div class="kv">
            <div class="k"><a href="${esc(buildEventAnalyticsHref(row.id))}">${esc(String(row.title || "Untitled event"))}</a></div>
            <div class="v">${Number(row.viewCount || 0).toLocaleString("en-US")}</div>
          </div>
        `)
        .join("") || `<div class="muted">No organizer events yet.</div>`;

      const overallMonthlyViewRows = hasSourceTrackingTable
        ? await all(
            `SELECT strftime('%Y-%m', ev.viewedAt) AS ym, COUNT(*) AS n
             FROM event_views ev
             JOIN events e ON e.id = ev.eventId
             WHERE 1=1
             ${selectedCity ? "AND e.city = ?" : ""}
             ${hasArchiveCols2 ? "AND (e.isArchived IS NULL OR e.isArchived = 0)" : ""}
             AND date(ev.viewedAt) >= date('now', 'start of month', '-11 month')
             GROUP BY ym
             ORDER BY ym ASC`,
            selectedCity ? [selectedCity] : []
          )
        : [];
      const overallMonthlyViewMap = new Map((overallMonthlyViewRows || []).map((row) => [String(row.ym || ""), Number(row.n || 0)]));
      const overallMonthlyEventMap = new Map();
      for (const row of organizerLeaderboard) {
        for (const [ym, count] of row.monthlyEvents.entries()) {
          overallMonthlyEventMap.set(ym, Number(overallMonthlyEventMap.get(ym) || 0) + Number(count || 0));
        }
      }
      {
        const monthCursor = new Date();
        monthCursor.setDate(1);
        const labels = [];
        const eventValues = [];
        const viewValues = [];
        for (let i = 11; i >= 0; i--) {
          const dt = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - i, 1);
          const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
          labels.push(dt.toLocaleString("en-US", { month: "short", year: "numeric" }));
          eventValues.push(Number(overallMonthlyEventMap.get(ym) || 0));
          viewValues.push(Number(overallMonthlyViewMap.get(ym) || 0));
        }
        organizerChartLabels = labels.slice();
        organizerChartEventValues = eventValues.slice();
        organizerChartViewValues = viewValues.slice();
        organizerChartDataJson = JSON.stringify({
          events: { labels, values: eventValues },
          views: { labels, values: viewValues },
        });
      }

      organizerSummary = { ...organizerPageSummary };

      const selectedOrganizerEntry = organizerLeaderboard.find((row) => row.organizer === selectedOrganizer) || null;
      if (selectedOrganizerEntry) {
        organizerChartTitle = `${selectedOrganizer} performance`;
        organizerInsightsHeading = selectedOrganizer;
        organizerInsightsSub = `Detailed organizer insights`;
        organizerTopEventsTitle = `Top events for ${selectedOrganizer}`;
        organizerSummary = {
          uniqueEvents: Number(selectedOrganizerEntry.uniqueEvents || 0),
          totalOccurrences: Number(selectedOrganizerEntry.totalOccurrences || 0),
          upcomingOccurrences: Number(selectedOrganizerEntry.upcomingOccurrences || 0),
          views: Number(selectedOrganizerEntry.views || 0),
          featured: Number(selectedOrganizerEntry.featured || 0),
          allViews: 0,
          directViews: 0,
          referralViews: 0,
          internalViews: 0,
        };

        if (hasSourceTrackingTable) {
          try {
            const sourceRow = await get(
              `SELECT
                 COUNT(*) AS tracked,
                 COALESCE(SUM(CASE WHEN COALESCE(ev.ref,'') LIKE '[src:direct%' OR COALESCE(ev.ref,'') = '__direct__' OR trim(COALESCE(ev.ref,'')) = '' THEN 1 ELSE 0 END), 0) AS directCount,
                 COALESCE(SUM(CASE WHEN COALESCE(ev.ref,'') LIKE '[src:referral%' THEN 1 ELSE 0 END), 0) AS referralCount,
                 COALESCE(SUM(CASE WHEN COALESCE(ev.ref,'') LIKE '[src:internal%' THEN 1 ELSE 0 END), 0) AS internalCount
               FROM event_views ev
               JOIN events e ON e.id = ev.eventId
               WHERE COALESCE(NULLIF(TRIM(e.organizer), ''), '(unknown)') = ?
               ${selectedCity ? "AND e.city = ?" : ""}
               ${hasArchiveCols2 ? "AND (e.isArchived IS NULL OR e.isArchived = 0)" : ""}`,
              selectedCity ? [selectedOrganizer, selectedCity] : [selectedOrganizer]
            );
            organizerSummary.allViews = Number(sourceRow?.tracked || 0);
            organizerSummary.directViews = Number(sourceRow?.directCount || 0);
            organizerSummary.referralViews = Number(sourceRow?.referralCount || 0);
            organizerSummary.internalViews = Number(sourceRow?.internalCount || 0);
          } catch (_) {}
        }

        organizerPageSummary = { ...organizerSummary };
        organizerSelectionHtml = `
          <div class="mini" style="margin-bottom:12px;">
            <a class="btn" href="/admin/events-organizers${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Back to all organizers</a>
          </div>
          <form method="GET" action="/admin/events-organizers" style="display:grid; gap:12px;">
            ${selectedCity ? `<input type="hidden" name="city" value="${esc(selectedCity)}" />` : ``}
            <div class="field">
              <label>Organizer</label>
              <select name="organizer" class="ctrl" onchange="this.form.submit()">
                ${organizerAnalyticsOptions.map((name) => `<option value="${esc(name)}" ${name === selectedOrganizer ? "selected" : ""}>${esc(name)}</option>`).join("")}
              </select>
            </div>
          </form>
        `;

        organizerTopEventsHtml = [...selectedOrganizerEntry.rows]
          .sort((a, b) => Number(b.viewCount || 0) - Number(a.viewCount || 0) || Number(b.id || 0) - Number(a.id || 0))
          .slice(0, 5)
          .map((row) => `
            <div class="kv">
              <div class="k"><a href="${esc(buildEventAnalyticsHref(row.id))}">${esc(String(row.title || "Untitled event"))}</a></div>
              <div class="v">${Number(row.viewCount || 0).toLocaleString("en-US")}</div>
            </div>
          `)
          .join("") || organizerTopEventsHtml;

        const monthlyViewRows = hasSourceTrackingTable
          ? await all(
              `SELECT strftime('%Y-%m', ev.viewedAt) AS ym, COUNT(*) AS n
               FROM event_views ev
               JOIN events e ON e.id = ev.eventId
               WHERE COALESCE(NULLIF(TRIM(e.organizer), ''), '(unknown)') = ?
               ${selectedCity ? "AND e.city = ?" : ""}
               ${hasArchiveCols2 ? "AND (e.isArchived IS NULL OR e.isArchived = 0)" : ""}
               AND date(ev.viewedAt) >= date('now', 'start of month', '-11 month')
               GROUP BY ym
               ORDER BY ym ASC`,
              selectedCity ? [selectedOrganizer, selectedCity] : [selectedOrganizer]
            )
          : [];
        const monthlyViewMap = new Map((monthlyViewRows || []).map((row) => [String(row.ym || ""), Number(row.n || 0)]));
        const monthCursor = new Date();
        monthCursor.setDate(1);
        const labels = [];
        const eventValues = [];
        const viewValues = [];
        for (let i = 11; i >= 0; i--) {
          const dt = new Date(monthCursor.getFullYear(), monthCursor.getMonth() - i, 1);
          const ym = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
          labels.push(dt.toLocaleString("en-US", { month: "short", year: "numeric" }));
          eventValues.push(Number(selectedOrganizerEntry.monthlyEvents.get(ym) || 0));
          viewValues.push(Number(monthlyViewMap.get(ym) || 0));
        }
        organizerChartLabels = labels.slice();
        organizerChartEventValues = eventValues.slice();
        organizerChartViewValues = viewValues.slice();
        organizerChartDataJson = JSON.stringify({
          events: { labels, values: eventValues },
          views: { labels, values: viewValues },
        });
      } else if (organizerAnalyticsOptions.length) {
        organizerSelectionHtml = `
          <div class="mini">
            Click any organizer name in the table below to open detailed insights for that organizer.
          </div>
        `;
      }
    }
    const organizerChartSvg = buildOrganizerChartSvg(
      organizerChartLabels,
      organizerChartEventValues,
      organizerChartViewValues
    );

    const pageTitleBase = showCreate
      ? "Create Events"
      : showUpload
      ? "Upload Events"
      : showApprove
      ? "Approve Events"
      : showExisting
      ? (isOrganizerUser ? "My Events" : "All Events")
      : showOrganizers
      ? "Organizer Analytics"
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
      : showUpdatesLog
      ? "Release Notes"
      : showInvites
      ? "Invites"
      : "Dashboard";
    const eventsMenuOpen = showExisting || showCreate || showApprove || showUpload;
    const venuesMenuOpen = showVenueExisting || showVenueCreate;
    const jobsMenuOpen = showJobsExisting || showJobsCreate || showJobsApplicants;
    const adsMenuOpen = showAdsExisting || showAdsCreate;
    const analyticsMenuOpen = showAnalytics || showVenueAnalytics || showJobsAnalytics || showAdsAnalytics || showOrganizers;
    const adminMenuOpen = showUsers || showInvites || showPreferences || showUpdatesLog;
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
        --radius:10px;
        --radius-mid:8px;
        --radius-inner:6px;
        --radius2:10px;
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
        display:block;
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
        text-decoration:none;
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
        overflow:visible;
      }
      .h-left{
        display:flex;
        align-items:center;
        gap:12px;
        min-width:0;
        flex:1 1 0;
        width:100%;
      }
      .h-left-search{
        min-width:0;
        flex:1 1 auto;
        width:100%;
        max-width:none;
      }
      .mobile-sidebar-toggle{
        display:none;
        width:40px;
        height:40px;
        border-radius:999px;
        border:1px solid var(--line);
        background:#fff;
        color:var(--text);
        align-items:center;
        justify-content:center;
        flex:0 0 40px;
      }
      .mobile-sidebar-toggle i{ font-size:15px; }
      .sidebar-backdrop{
        display:none;
        position:fixed;
        inset:0;
        background:rgba(15,23,42,.42);
        z-index:70;
      }
      .h-right{
        display:flex;
        align-items:center;
        gap:10px;
        flex-wrap:wrap;
        flex:0 0 auto;
        justify-content:flex-end;
        position:relative;
      }
      .header-tools{
        display:flex;
        align-items:center;
        gap:12px;
        overflow:visible;
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
        padding:0;
        overflow:visible;
        appearance:none;
        -webkit-appearance:none;
        box-shadow: none;
        transition: color .14s ease, border-color .14s ease, background-color .14s ease;
      }
      .header-icon-btn:focus{
        outline:none;
      }
      .header-icon-btn:focus-visible{
        outline:none;
        box-shadow:none;
        border-color:var(--line);
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
      .header-icon-btn .header-avatar{
        width:100%;
        height:100%;
        border-radius:999px;
        object-fit:cover;
        display:block;
      }
      .header-icon-btn .icon-badge{
        position:absolute;
        top:2px;
        right:1px;
        min-width:20px;
        height:20px;
        padding:0 4px;
        border-radius:999px;
        background:#ef4444;
        color:#fff;
        font-size:11px;
        font-weight:700;
        line-height:1;
        text-align:center;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        border:2px solid #fff;
      }
      .header-icon-btn .header-status-badge{
        position:absolute;
        left:-3px;
        bottom:-3px;
        width:15px;
        height:15px;
        border-radius:999px;
        border:2px solid #fff;
        box-shadow:0 0 0 1px rgba(148,163,184,.25);
        pointer-events:none;
        z-index:2;
      }
      .header-icon-btn .header-status-badge.is-available,
      .header-icon-btn .header-status-badge.is-online{ background:#22c55e; }
      .header-icon-btn .header-status-badge.is-away{ background:#facc15; }
      .header-icon-btn .header-status-badge.is-dnd{ background:#ef4444; }
      .header-icon-btn .header-status-badge.is-offline{ background:#cbd5e1; }
      .header-icon-btn.header-message-icon{
        color:#0ea5e9;
      }
      .header-account-menu{
        position:static;
        z-index:150;
        width:40px;
        height:40px;
        flex:0 0 40px;
      }
      .header-account-trigger{
        cursor:pointer;
        flex:0 0 40px;
        width:40px;
        height:40px;
        min-width:40px;
        min-height:40px;
        margin:0;
        padding:0;
        border-radius:999px;
        background:#fff;
        appearance:none;
        -webkit-appearance:none;
        -webkit-tap-highlight-color: transparent;
        overflow:visible;
      }
      .header-account-trigger,
      .header-account-trigger:hover,
      .header-account-trigger:active,
      .header-account-trigger:focus,
      .header-account-trigger:focus-visible{
        outline:none !important;
        box-shadow:none !important;
      }
      .header-account-dropdown{
        position:absolute;
        top:calc(100% + 10px);
        right:0;
        width:280px;
        padding:10px;
        border:1px solid var(--line);
        border-radius:16px;
        background:#fff;
        box-shadow:0 18px 42px rgba(15,23,42,.14);
        display:none;
        z-index:120;
      }
      .header-account-menu.is-open .header-account-dropdown{
        display:block;
      }
      .account-menu-link{
        width:100%;
        min-height:44px;
        border:1px solid var(--line);
        border-radius:12px;
        background:#fff;
        color:var(--text) !important;
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        padding:0 14px;
        text-decoration:none !important;
        font-weight:700;
      }
      .account-menu-icon{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        flex:0 0 auto;
        color:var(--muted);
      }
      .account-menu-icon svg{
        display:block;
      }
      .account-menu-link:hover{
        border-color:rgba(15,23,42,.18);
        background:#f8fafc;
      }
      .account-menu-group{
        display:grid;
        gap:8px;
      }
      .account-menu-divider{
        height:1px;
        background:var(--line);
        margin:10px 2px;
      }
      .account-menu-section-label{
        color:var(--muted);
        font-size:12px;
        font-weight:800;
        letter-spacing:.08em;
        text-transform:uppercase;
        padding:0 4px;
      }
      .account-status-grid{
        display:grid;
        gap:8px;
      }
      .account-status-form{
        margin:0;
      }
      .account-status-btn{
        width:100%;
        min-height:42px;
        border:1px solid var(--line);
        border-radius:12px;
        background:#fff;
        color:var(--text);
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:10px;
        padding:0 14px;
        font-weight:700;
        cursor:pointer;
      }
      .account-status-btn:hover{
        border-color:rgba(15,23,42,.18);
        background:#f8fafc;
      }
      .account-status-btn.active{
        border-color:rgba(16,185,129,.35);
        background:#ecfdf5;
      }
      .account-status-meta{
        display:flex;
        align-items:center;
        gap:10px;
        min-width:0;
      }
      .account-status-dot{
        width:12px;
        height:12px;
        border-radius:999px;
        flex:0 0 auto;
        box-shadow:0 0 0 2px #fff, 0 0 0 3px rgba(148,163,184,.25);
      }
      .account-status-dot.is-available{ background:#22c55e; }
      .account-status-dot.is-away{ background:#facc15; }
      .account-status-dot.is-dnd{ background:#ef4444; }
      .account-status-help{
        color:var(--muted);
        font-size:12px;
        font-weight:600;
      }
      .online-dot{
        width:10px;
        height:10px;
        border-radius:999px;
        display:inline-block;
        flex:0 0 auto;
        border:2px solid #fff;
        box-shadow:0 0 0 1px rgba(148,163,184,.25);
      }
      .online-dot.is-available,
      .online-dot.is-online{ background:#22c55e; }
      .online-dot.is-away{ background:#facc15; }
      .online-dot.is-dnd{ background:#ef4444; }
      .online-dot.is-offline{ background:#cbd5e1; }
      .user-line{
        display:flex;
        align-items:center;
        gap:8px;
      }
      .messages-layout{
        display:grid;
        grid-template-columns: 320px minmax(0, 1fr);
        gap:var(--gap);
        align-items:stretch;
        min-height:calc(100vh - 180px);
      }
      .messages-card{
        min-height:0;
        height:calc(100vh - 180px);
        display:flex;
        flex-direction:column;
        overflow:hidden;
      }
      .message-list{
        display:grid;
        gap:10px;
        flex:1 1 auto;
        min-height:0;
        overflow:auto;
        padding-right:4px;
        align-content:start;
      }
      .message-user-link{
        display:flex;
        align-items:center;
        gap:10px;
        padding:12px;
        border:1px solid var(--line);
        border-radius:var(--radius-inner);
        background:#fff;
        color:var(--text);
        text-decoration:none;
      }
      .message-user-link.active{
        border-color:rgba(0,192,139,.35);
        background:rgba(0,192,139,.06);
      }
      .message-user-avatar{
        width:40px;
        height:40px;
        border-radius:999px;
        background:#e2e8f0;
        object-fit:cover;
        flex:0 0 auto;
      }
      .message-user-copy{
        min-width:0;
        flex:1 1 auto;
      }
      .message-user-name{
        display:flex;
        align-items:center;
        gap:8px;
        font-weight:650;
        color:var(--text);
      }
      .message-user-meta{
        color:var(--muted);
        font-size:12px;
        margin-top:4px;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      .message-unread{
        min-width:20px;
        height:20px;
        padding:0 6px;
        border-radius:999px;
        background:#0f172a;
        color:#fff;
        font-size:11px;
        font-weight:700;
        line-height:20px;
        text-align:center;
      }
      .messages-thread{
        display:grid;
        gap:12px;
        flex:1 1 auto;
        min-height:0;
        overflow:auto;
        padding-right:4px;
        align-content:start;
      }
      .message-bubble{
        max-width:min(540px, 82%);
        padding:12px 14px;
        border-radius:var(--radius-inner);
        border:1px solid var(--line);
        background:#fff;
      }
      .message-bubble.mine{
        margin-left:auto;
        background:rgba(0,192,139,.08);
        border-color:rgba(0,192,139,.22);
      }
      .message-bubble .meta{
        color:var(--muted);
        font-size:11px;
        margin-top:6px;
        display:flex;
        align-items:center;
        gap:8px;
        flex-wrap:wrap;
      }
      .message-read-indicator{
        display:inline-flex;
        align-items:center;
        gap:4px;
        color:#0f766e;
        font-weight:700;
      }
      .messages-compose{
        display:grid;
        gap:10px;
        margin-top:14px;
        flex:0 0 auto;
      }
      .messages-compose textarea{
        min-height:96px;
        max-height:160px;
        resize:vertical;
      }
      .messages-panel{
        display:flex;
        flex-direction:column;
        flex:1 1 auto;
        min-height:0;
      }
      .messages-contact-card{
        flex:1 1 auto;
        min-height:0;
      }
      .messages-profile{
        flex:0 0 auto;
        margin-bottom:14px;
      }
      .messages-empty{
        display:flex;
        align-items:center;
        justify-content:center;
        min-height:100%;
        color:var(--muted);
        text-align:center;
      }
      .message-typing-status{
        min-height:20px;
        margin-top:8px;
        color:var(--muted);
        font-size:13px;
        font-weight:600;
      }
      .message-typing-status.is-active{
        color:#0f766e;
      }

      .search{
        display:flex; align-items:center; gap:10px;
        background:transparent;
        border:0;
        border-radius:0;
        padding: 0;
        width:100%;
        min-width:0;
        max-width:none;
        position:relative;
        margin-right:0;
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
        border-radius:var(--radius-inner);
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
        border-radius:var(--radius-inner);
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
      .metric .k{
        color:var(--muted);
        font-size:12px;
        font-weight:600;
        display:inline-flex;
        align-items:center;
        gap:6px;
        flex-wrap:wrap;
      }
      .metric .v{ font-size:22px; font-weight:650; letter-spacing:.2px; margin-top:6px; color: var(--text); }
      .metricInfo{
        position:relative;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        width:16px;
        height:16px;
        border-radius:999px;
        border:1px solid rgba(148,163,184,.45);
        background:#f8fafc;
        color:#64748b;
        font-size:10px;
        font-weight:800;
        line-height:1;
        cursor:help;
        flex:0 0 16px;
      }
      .metricInfo::before{
        content:"";
        position:absolute;
        left:50%;
        bottom:calc(100% + 2px);
        transform:translate(-50%, 8px);
        border:6px solid transparent;
        border-top-color:rgba(15,23,42,.92);
        opacity:0;
        visibility:hidden;
        transition:opacity .16s ease, transform .16s ease, visibility .16s ease;
        pointer-events:none;
      }
      .metricInfo::after{
        content:attr(data-tip);
        position:absolute;
        left:50%;
        bottom:calc(100% + 12px);
        transform:translate(-50%, 8px);
        min-width:190px;
        max-width:240px;
        padding:10px 12px;
        border-radius:12px;
        background:rgba(15,23,42,.92);
        color:#fff;
        font-size:12px;
        font-weight:600;
        line-height:1.45;
        text-align:left;
        box-shadow:0 18px 36px rgba(15,23,42,.18);
        opacity:0;
        visibility:hidden;
        transition:opacity .16s ease, transform .16s ease, visibility .16s ease;
        pointer-events:none;
        z-index:20;
        white-space:normal;
      }
      .metricInfo:hover::before,
      .metricInfo:hover::after,
      .metricInfo:focus-visible::before,
      .metricInfo:focus-visible::after{
        opacity:1;
        visibility:visible;
        transform:translate(-50%, 0);
      }
      .metric .tag{
        font-size:12px; font-weight:650;
        padding:6px 10px; border-radius: var(--radius-inner);
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
      .analytics-main-grid{
        align-items:start;
      }
      .analytics-main-grid > .card{
        height:auto;
        min-height:366px;
      }
      .analytics-main-grid > .card:first-child{
        min-height:366px;
      }
      .analytics-main-grid > .card:last-child{
        min-height:366px;
      }
      .organizer-analytics-single > .card,
      .organizer-analytics-single > .card:first-child{
        min-height:0;
      }
      .organizer-analytics-single{
        margin-bottom:var(--gap);
      }
      .organizer-leaderboard-card{
        margin-top: 0;
      }
      .organizer-chart-grid > .card{
        height: auto;
        align-self: start;
      }
      .organizer-chart-grid{
        align-items:stretch;
      }
      .organizer-chart-grid > .card{
        height:100%;
        align-self:stretch;
      }
      .organizer-chart-grid > .card:first-child{
        display:flex;
        flex-direction:column;
      }
      .organizer-chart-grid > .card:first-child .chart-wrap{
        flex: 1 1 auto;
        min-height: 360px;
      }
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
      .venue-analytics-grid2 > .card{
        height:100%;
        min-width:0;
        display:flex;
        flex-direction:column;
      }

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
        .messages-layout{ grid-template-columns: 1fr; }
        .rail{ display:none; }
        .mobile-sidebar-toggle{ display:inline-flex; }
        .sidebar{
          display:flex;
          position:fixed;
          top:0;
          left:0;
          bottom:0;
          height:100vh;
          width:min(280px, 82vw);
          max-width:280px;
          transform:translateX(-100%);
          transition:transform .2s ease;
          box-shadow:0 20px 50px rgba(15,23,42,.22);
        }
        body.sidebar-open .sidebar{ transform:translateX(0); }
        body.sidebar-open .sidebar-backdrop{ display:block; }
        body.sidebar-open{ overflow:hidden; }
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
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
        font-weight: 500;
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
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
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
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
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
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
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
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
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
        border-radius: var(--radius-mid);
        padding: 14px;
      }
      .event-insights-mini{
        height: 100%;
        display: flex;
        flex-direction: column;
        justify-content: flex-start;
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
      .mini-list .kv{
        margin: 14px 0;
        padding: 4px 0;
      }
      .analytics-table{
        width:100%;
        border-collapse:collapse;
      }
      .analytics-table th,
      .analytics-table td{
        padding:10px 8px;
        border-bottom:1px solid var(--line);
        text-align:left;
        font-size:13px;
      }
      .analytics-table th{
        color:var(--muted);
        font-weight:700;
      }
      .analytics-table td:last-child,
      .analytics-table th:last-child{
        text-align:right;
      }
      .analytics-table td:nth-child(n+3),
      .analytics-table th:nth-child(n+3){
        text-align:right;
      }
      .analytics-table tbody tr:last-child td{
        border-bottom:0;
      }
      .grid4 > .card .mini-spaced{
        height: 100%;
        display:flex;
        flex-direction:column;
        justify-content:space-between;
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
      .seg a{
        display:inline-flex;
        align-items:center;
        justify-content:center;
        text-decoration:none;
        border: 1px solid transparent;
        background: transparent;
        color: var(--muted);
        padding: 7px 10px;
        border-radius: 999px;
        font-weight: 650;
        font-size:14px;
        line-height: 1;
      }
      .seg button:hover{ color: var(--text); }
      .seg a:hover{ color: var(--text); }
      .seg button.on{
        background: rgba(0,192,139,.14);
        border-color: rgba(0,192,139,.28);
        color: #065f46;
      }
      .seg a.on{
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
        border-radius: var(--radius-mid);
        border: 1px solid var(--line);
        display:block;
      }
      .thumb-empty,
      .thumb-fallback{
        width: 120px; height: var(--event-side-h);
        border-radius: var(--radius-mid);
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
        border-radius: var(--radius-mid);
        padding: 10px;
        background: var(--panel2);
        display:flex;
        flex-direction:column;
        justify-content:space-between;
      }
      .event-card:not(.venue-card) .event-stats{
        width: 230px;
        flex: 0 0 230px;
        height: auto;
        min-height: var(--event-side-h);
        display:grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 6px 12px;
        align-content: start;
      }
      .event-card:not(.venue-card) .event-stats .event-stats-action{
        grid-column: 1 / -1;
        margin-top: 2px;
      }
      .event-card:not(.venue-card) .event-stats .event-stats-action .btn{
        width: 100%;
        height: 30px;
        min-height: 30px;
        padding: 0 8px;
        border-radius: 10px;
        font-size: 13px;
        line-height: 1;
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
        .venue-monthly-grid > .mini{
          width:100%;
          min-width:0;
        }
        .venue-monthly-grid .chart-wrap{
          min-height:360px;
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
        .pager{
          grid-template-columns: 1fr;
        }
        .pager-left,
        .pager-right{
          justify-self: stretch;
          justify-content: flex-start;
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
        .event-card{
          align-items:flex-start;
        }
        .event-left{
          height:auto;
          min-height: var(--event-side-h);
        }
      }
      @media (max-width: 860px){
        .event-card{
          display:grid;
          grid-template-columns: 96px minmax(0, 1fr);
          gap:12px;
        }
        .event-thumb,
        .event-thumb-img,
        .thumb-empty,
        .thumb-fallback{
          width:96px;
          height:96px;
        }
        .event-stats{
          grid-column: 1 / -1;
          width:100%;
          flex: 0 0 auto;
          height:auto;
          min-height:0;
          display:grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap:8px 12px;
        }
        .event-card:not(.venue-card) .event-stats{
          width:100%;
          flex: 0 0 auto;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .event-card.venue-card .event-stats{
          width:100%;
          flex: 0 0 auto;
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
        .event-card .event-stats .stat{
          margin:0;
        }
      }
      @media (max-width: 700px){
        .eventsFilters{
          padding: 12px;
        }
        .eventsFilterTabs{
          display:grid;
          grid-template-columns: 1fr 1fr;
          gap:8px;
        }
        .eventsFilterTabs .btn,
        .eventsFilterTabs .btn-wide{
          width:100%;
          min-width:0;
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
          display:grid;
          grid-template-columns: 1fr 1fr;
          width:100%;
        }
        .filterActions .btn{
          width:100%;
          min-width: 0;
        }
        .event-card{
          grid-template-columns: 1fr;
          padding:12px;
        }
        .event-thumb,
        .event-thumb-img,
        .thumb-empty,
        .thumb-fallback{
          width:100%;
          max-width:none;
          height:180px;
        }
        .event-left{
          min-height:0;
        }
        .event-title{
          font-size:16px;
        }
        .event-meta{
          font-size:13px;
          gap:6px;
        }
        .event-actions{
          display:grid;
          grid-template-columns: 1fr 1fr;
          gap:8px;
          width:100%;
        }
        .event-actions .inline{
          display:block;
        }
        .event-actions .btn{
          width:100%;
          min-width:0;
        }
        .event-actions a:not(.btn){
          grid-column: 1 / -1;
          padding-top:2px;
        }
        .event-stats,
        .event-card:not(.venue-card) .event-stats,
        .event-card.venue-card .event-stats{
          grid-template-columns: 1fr 1fr;
          padding:12px;
        }
        .stat{
          font-size:12px;
        }
        .stat strong{
          font-size:15px;
        }
      }
      @media (max-width: 520px){
        .sectionTitle .right{
          width:100%;
          justify-content:flex-start;
        }
        .eventsFilterTabs{
          grid-template-columns: 1fr;
        }
        .filterActions{
          grid-template-columns: 1fr;
        }
        .event-actions{
          grid-template-columns: 1fr;
        }
        .event-stats,
        .event-card:not(.venue-card) .event-stats,
        .event-card.venue-card .event-stats{
          grid-template-columns: 1fr;
        }
        .pager-right{
          display:grid;
          grid-template-columns: 1fr 1fr;
          gap:8px;
          width:100%;
        }
        .pager-right .btn{
          width:100%;
          min-width:0;
        }
        .pager-right .muted{
          grid-column: 1 / -1;
          padding: 4px 0;
        }
      }

      /* Category selection */
      .cat-grid{ display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; }
      @media (max-width: 900px){ .cat-grid{ grid-template-columns: 1fr; } }

      /* Recurrence UI polish (keep your functionality, just match the new look) */
      .recurrence{ background: var(--panel2); border:1px solid var(--line); border-radius: var(--radius-mid); padding: 14px; }
      .rec-grid{ display:grid; grid-template-columns: 1fr 1fr; gap: 16px; align-items: start; }
      @media (max-width: 900px){ .rec-grid{ grid-template-columns: 1fr; } }
      .event-type-picker{
        display:grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap:12px;
        margin-top:10px;
      }
      @media (max-width: 900px){ .event-type-picker{ grid-template-columns: 1fr; } }
      .event-type-card{
        appearance:none;
        border:1px solid var(--line);
        border-radius: var(--radius-mid);
        background:#fff;
        padding:16px;
        text-align:left;
        cursor:pointer;
        display:flex;
        flex-direction:column;
        gap:8px;
        transition:border-color .14s ease, box-shadow .14s ease, background-color .14s ease;
      }
      .event-type-card:hover{
        border-color: rgba(0,192,139,.28);
        box-shadow: 0 0 0 4px rgba(0,192,139,.08);
      }
      .event-type-card.is-active{
        background: rgba(0,192,139,.08);
        border-color: rgba(0,192,139,.28);
        box-shadow: 0 0 0 4px rgba(0,192,139,.10);
      }
      .event-type-card-title{
        font-size:18px;
        font-weight:700;
        color:var(--text);
        line-height:1.2;
      }
      .event-type-card-copy{
        font-size:13px;
        line-height:1.5;
        color:var(--muted);
      }
      .event-type-managed-rec-toggle{ display:none; }
      .event-type-shell{ display:none; }
      .event-type-shell.is-visible{ display:block; }
      .event-type-note{
        margin-top:14px;
        color:var(--muted);
        font-size:14px;
        line-height:1.5;
      }
      .multi-day-shell{ display:none; }
      .multi-day-shell.is-visible{ display:block; }
      .multi-day-list{
        display:grid;
        gap:12px;
      }
      .multi-day-row{
        display:grid;
        grid-template-columns: minmax(180px, 1.3fr) minmax(140px, 1fr) minmax(140px, 1fr);
        gap:10px;
        align-items:center;
        padding:12px;
        border:1px solid var(--line);
        border-radius: var(--radius-inner);
        background: var(--panel);
      }
      .multi-day-date-label{
        font-size:12px;
        font-weight:650;
        color:var(--muted);
        margin-bottom:6px;
      }
      .multi-day-date-input{
        background:#fff;
      }
      .multi-day-empty{
        color:var(--muted);
        font-size:14px;
        line-height:1.5;
      }
      @media (max-width: 900px){
        .multi-day-row{
          grid-template-columns: 1fr;
        }
      }
      .rec-label{ font-weight:650; font-size: 12px; margin-bottom: 8px; color: var(--text); letter-spacing: .2px; }
      .rec-help{ margin-top: 10px; font-size: 12px; color: var(--muted); line-height: 1.4; }

      .rec-box{ border:1px solid var(--line); border-radius: var(--radius-mid); padding: 14px; background: var(--panel2); margin-top: 10px; }
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
        border-radius: var(--radius-inner);
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
        min-width:0;
      }
      .chartTopRow{
        display:flex;
        align-items:center;
        gap:18px;
        flex-wrap:wrap;
        min-width:0;
      }
      .chartTopRow .sub{
        margin:0;
        white-space:nowrap;
      }
      .sectionTitle--chart h2,
      .sectionTitle--chart .chartTitle,
      #chartRangeLabel,
      #venueChartRangeLabel,
      #adChartRangeLabel{
        white-space:nowrap;
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
      .chartLegend{
        display:flex;
        gap:22px;
        flex-wrap:wrap;
        align-items:center;
        margin-top:0;
      }
      .chartLegendItem{
        display:inline-flex;
        align-items:center;
        gap:10px;
        color:var(--text);
        font-size:13px;
        font-weight:600;
      }
      .chartLegendLine{
        width:40px;
        height:0;
        border-top:3px solid currentColor;
        border-radius:999px;
        flex:0 0 auto;
      }
      .chartLegendLine.is-dashed{
        border-top-style:dashed;
        border-top-width:2px;
      }
      .chartLegendItem.is-events{
        color:rgba(16,185,129,.9);
      }
      .chartLegendItem.is-views{
        color:rgba(37,99,235,.82);
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
        display:grid;
        gap:var(--gap);
        align-content:start;
        min-width:0;
        width:100%;
      }
      .dashboard-card{
        position:relative;
      }
      .dashboard-card .sectionTitle{
        margin-bottom: 14px;
        list-style: none;
      }
      .dashboard-card .sectionTitle::-webkit-details-marker{
        display:none;
      }
      .dashboard-card:not([open]) .sectionTitle{ margin-bottom: 0; }
      .dashboard-card .sectionTitle h2{ margin:0; }
      .dashboard-card .card-toggle{
        width:100%;
        border:0;
        background:transparent;
        padding:6px 0;
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
      .dashboard-card:not([open]) .card-toggle .card-caret{
        transform: rotate(-90deg);
      }
      .dashboard-card .card-body{
        display:block;
      }
      .dashboard-card:not([open]) .card-body{
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
      .insights-switcher{
        display:inline-flex;
        align-items:center;
        gap:0;
        padding:4px;
        border:1px solid var(--line);
        border-radius:999px;
        background:#fff;
        flex-wrap:wrap;
        margin-bottom:12px;
      }
      .insights-switcher button{
        min-height:30px;
        padding:0 14px;
        border-radius:999px;
        border:0;
        background:transparent;
        color:var(--muted);
        text-decoration:none;
        font-weight:650;
        cursor:pointer;
        display:inline-flex;
        align-items:center;
        justify-content:center;
      }
      .insights-switcher button.is-active{
        color:#111827;
        background:rgba(0,192,139,.10);
        font-weight:700;
      }
      .insights-switcher button:hover{
        color:var(--text);
      }
      .insights-switcher button:visited{
        color:var(--muted);
      }
      .insight-panel{
        display:none;
      }
      .insight-panel.is-active{
        display:block;
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
      .activity-list{
        display:grid;
        gap:10px;
      }
      .dashboard-calendar{
        display:grid;
        grid-template-columns:1fr;
        gap:12px;
      }
      .dashboard-calendar-main,
      .dashboard-calendar-panel{
        border:1px solid var(--line);
        border-radius:var(--radius-inner);
        background:var(--panel2);
      }
      .dashboard-calendar-main{
        padding:12px;
      }
      .dashboard-calendar-head{
        display:grid;
        gap:10px;
        margin-bottom:12px;
      }
      .dashboard-calendar-head-top{
        display:flex;
        justify-content:space-between;
        align-items:center;
        gap:16px;
      }
      .dashboard-calendar-head-left{
        min-width:0;
      }
      .dashboard-calendar-month-row{
        display:flex;
        align-items:center;
        gap:10px;
      }
      .dashboard-calendar a.dashboard-calendar-nav:not(.btn){
        width:32px;
        height:32px;
        border-radius:999px;
        display:inline-flex;
        align-items:center;
        justify-content:center;
        padding:0;
        background:#fff;
        color:var(--muted);
        font-size:20px;
        font-weight:700;
        line-height:1;
        cursor:pointer;
        text-decoration:none;
        border:1px solid var(--line);
      }
      .dashboard-calendar a.dashboard-calendar-nav:not(.btn):visited{
        color:var(--muted);
      }
      .dashboard-calendar a.dashboard-calendar-nav:not(.btn):hover{
        color:var(--text);
        text-decoration:none;
      }
      .dashboard-calendar a.dashboard-calendar-nav.is-disabled:not(.btn),
      .dashboard-calendar a.dashboard-calendar-nav[aria-disabled="true"]:not(.btn){
        opacity:.45;
        cursor:not-allowed;
        pointer-events:none;
      }
      .dashboard-calendar-month{
        font-size:18px;
        font-weight:800;
        color:var(--text);
      }
      .dashboard-calendar-total{
        display:flex;
        flex-direction:column;
        align-items:flex-end;
        gap:4px;
        text-align:right;
        flex:0 0 auto;
      }
      .dashboard-calendar-total-label{
        font-size:12px;
        font-weight:700;
        letter-spacing:.04em;
        text-transform:uppercase;
        color:var(--muted);
      }
      .dashboard-calendar-total-value{
        font-size:22px;
        font-weight:800;
        line-height:1;
        color:var(--text);
      }
      .dashboard-calendar-toolbar{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:16px;
        flex-wrap:wrap;
      }
      .dashboard-calendar-scope-toggle{
        display:inline-flex;
        align-items:center;
        gap:0;
        padding:4px;
        border:1px solid var(--line);
        border-radius:999px;
        background:#fff;
      }
      .dashboard-calendar a.dashboard-calendar-scope-btn:not(.btn){
        display:inline-flex;
        align-items:center;
        justify-content:center;
        min-height:30px;
        padding:0 14px;
        border-radius:999px;
        border:0;
        background:transparent;
        color:var(--muted);
        text-decoration:none;
        font-size:13px;
        font-weight:700;
      }
      .dashboard-calendar a.dashboard-calendar-scope-btn:not(.btn):visited{
        color:var(--muted);
      }
      .dashboard-calendar a.dashboard-calendar-scope-btn:not(.btn):hover{
        color:var(--text);
        text-decoration:none;
      }
      .dashboard-calendar a.dashboard-calendar-scope-btn.active:not(.btn){
        color:var(--text);
        background:rgba(0,192,139,.1);
      }
      .dashboard-calendar a.dashboard-calendar-scope-btn.active:not(.btn):visited,
      .dashboard-calendar a.dashboard-calendar-scope-btn.active:not(.btn):hover{
        color:var(--text);
        text-decoration:none;
      }
      .dashboard-calendar-legend{
        display:flex;
        align-items:center;
        flex-wrap:wrap;
        gap:8px;
        font-size:12px;
        color:var(--muted);
        justify-content:flex-end;
      }
      .dashboard-calendar-legend-label,
      .dashboard-calendar-legend-range{
        font-weight:600;
      }
      .dashboard-calendar-legend-scale{
        display:inline-flex;
        align-items:center;
        gap:4px;
      }
      .dashboard-calendar-legend-swatch{
        width:16px;
        height:10px;
        border-radius:999px;
        border:1px solid rgba(0,192,139,.18);
        background:#f8fbfa;
      }
      .dashboard-calendar-legend-swatch.level-1{
        background:rgba(0,192,139,.06);
      }
      .dashboard-calendar-legend-swatch.level-2{
        background:rgba(0,192,139,.16);
      }
      .dashboard-calendar-legend-swatch.level-3{
        background:rgba(0,192,139,.3);
      }
      .dashboard-calendar-legend-swatch.level-4{
        background:rgba(0,192,139,.48);
      }
      .dashboard-calendar-weekdays{
        display:grid;
        grid-template-columns:repeat(7,minmax(0,1fr));
        gap:8px;
        margin-bottom:8px;
      }
      .dashboard-calendar-weekdays div{
        text-align:center;
        font-size:12px;
        font-weight:700;
        color:var(--muted);
      }
      .dashboard-calendar-grid{
        display:grid;
        grid-template-columns:repeat(7,minmax(0,1fr));
        gap:8px;
      }
      .dashboard-calendar-day{
        min-height:72px;
        padding:10px 8px;
        border:1px solid var(--line);
        border-radius:var(--radius-inner);
        background:#fff;
        text-align:left;
        display:grid;
        align-content:start;
        gap:8px;
        cursor:pointer;
        text-decoration:none;
      }
      .dashboard-calendar-day:hover{
        border-color:rgba(15,23,42,.18);
        background:#fbfdff;
      }
      .dashboard-calendar-day.heat-1{
        background:rgba(0,192,139,.04);
      }
      .dashboard-calendar-day.heat-2{
        background:rgba(0,192,139,.14);
      }
      .dashboard-calendar-day.heat-3{
        background:rgba(0,192,139,.26);
      }
      .dashboard-calendar-day.heat-4{
        background:rgba(0,192,139,.42);
      }
      .dashboard-calendar-day.is-selected{
        border-color:rgba(0,192,139,.35);
        background:rgba(0,192,139,.08);
      }
      .dashboard-calendar-day.is-past:not(.is-selected){
        background:#f3f6fa;
        border-color:rgba(148,163,184,.22);
      }
      .dashboard-calendar-day.is-past:not(.is-selected) .dashboard-calendar-daynum,
      .dashboard-calendar-day.is-past:not(.is-selected) .dashboard-calendar-daycount{
        color:#7b8799;
      }
      .dashboard-calendar-day.is-today .dashboard-calendar-daynum{
        color:#065f46;
      }
      .dashboard-calendar-day.is-outside{
        opacity:.58;
      }
      .dashboard-calendar-daynum{
        font-size:14px;
        font-weight:800;
        color:var(--text);
      }
      .dashboard-calendar-daycount{
        font-size:11px;
        line-height:1.3;
        color:var(--muted);
      }
      .dashboard-calendar-panel{
        padding:12px;
        display:grid;
        gap:10px;
      }
      .dashboard-calendar-detail-head{
        display:flex;
        justify-content:space-between;
        align-items:flex-start;
        gap:12px;
        flex-wrap:wrap;
      }
      .dashboard-calendar-pager{
        display:flex;
        align-items:center;
        gap:8px;
      }
      .dashboard-calendar-panel-title{
        font-size:14px;
        font-weight:800;
        color:var(--text);
      }
      .dashboard-calendar-panel-sub{
        font-size:13px;
        color:var(--muted);
      }
      .dashboard-calendar-list{
        display:grid;
        gap:8px;
      }
      .dashboard-calendar-item{
        display:grid;
        gap:2px;
        padding:10px 12px;
        border:1px solid var(--line);
        border-radius:var(--radius-inner);
        background:#fff;
        text-decoration:none;
        color:inherit;
      }
      .dashboard-calendar-item:hover{
        border-color:rgba(15,23,42,.18);
        background:#fbfdff;
      }
      .dashboard-calendar-item-title{
        font-size:13px;
        font-weight:700;
        color:var(--text);
        line-height:1.35;
      }
      .dashboard-calendar-item-meta{
        font-size:12px;
        color:var(--muted);
        line-height:1.35;
      }
      .activity-item{
        display:grid;
        gap:6px;
        padding:12px 14px;
        border:1px solid var(--line);
        border-radius:var(--radius-inner);
        background:var(--panel2);
        text-decoration:none;
        color:inherit;
      }
      .activity-item:hover{
        border-color:rgba(15,23,42,.18);
        background:#fbfdff;
      }
      .activity-item-top{
        display:flex;
        justify-content:space-between;
        align-items:center;
        gap:10px;
      }
      .activity-pill{
        display:inline-flex;
        align-items:center;
        height:24px;
        padding:0 8px;
        border-radius:999px;
        background:rgba(15,23,42,.06);
        color:var(--muted);
        font-size:11px;
        font-weight:700;
        letter-spacing:.02em;
        text-transform:uppercase;
      }
      .activity-time{
        color:var(--muted);
        font-size:12px;
        white-space:nowrap;
      }
      .activity-title{
        color:var(--text);
        font-size:14px;
        font-weight:700;
        line-height:1.35;
      }
      .activity-meta{
        color:var(--muted);
        font-size:12px;
        line-height:1.35;
      }
      .release-meta{
        display:grid;
        gap:10px;
      }
      .release-latest{
        display:grid;
        gap:0;
        text-align:left;
      }
      .release-latest .value{
        color: var(--text);
        font-weight:700;
        text-align:left;
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
      .quick-links-grid.is-organizer{
        grid-template-columns: 1fr;
      }
      #dashboard-quick-links{
        --quick-links-outer-radius: var(--radius);
        --quick-links-group-radius: var(--radius-mid);
        --quick-links-button-radius: var(--radius-inner);
        border-radius: var(--quick-links-outer-radius);
      }
      .quick-links-group{
        border:1px solid var(--line);
        border-radius: var(--quick-links-group-radius, var(--radius-inner));
        background: var(--panel2);
        padding:10px;
        display:grid;
        align-content:start;
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
        border-radius: var(--quick-links-button-radius, var(--radius-inner));
      }
      @media (max-width: 1100px){
        .dashboard-shell{
          grid-template-columns: 1fr;
        }
        .quick-links-grid{
          grid-template-columns: 1fr;
        }
        .messages-layout{
          grid-template-columns:1fr;
          min-height:auto;
        }
        .messages-card{
          height:auto;
          min-height:420px;
        }
      }
      @media (max-width: 900px){
        .sectionTitle--chart{
          flex-direction: column;
          align-items: flex-start;
        }
        .sectionTitle--chart .right{ width:100%; }
        .chartTopRow{
          width:100%;
          align-items:flex-start;
          gap:10px;
        }
        .chartTopRow .sub{
          white-space:normal;
        }
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
      <button type="button" class="sidebar-backdrop" id="sidebarBackdrop" aria-label="Close sidebar"></button>

      <!-- Sidebar -->
      <aside class="sidebar" id="adminSidebar">
        <div class="sb-brand">
          <div class="sb-top">
          <div class="sb-icon">
            <img src="/assets/brand/sidebar-icon.png" alt="OpenCircle" onerror="this.style.display='none';" />
          </div>
            <div class="sb-city-wrap">
              <div class="sb-city-dd" id="sbCityDD">
                <button type="button" class="sb-city-btn" id="sbCityBtn" aria-haspopup="listbox" aria-expanded="false" onclick="var dd=document.getElementById('sbCityDD'); if(!dd) return false; var next=!dd.classList.contains('is-open'); dd.classList.toggle('is-open', next); this.setAttribute('aria-expanded', next ? 'true' : 'false'); return false;">
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
          ${(hasDeveloperAccess || isOrganizerUser) ? `
          <div class="nav-group nav-collapsible ${showDashboard ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${showDashboard ? "page" : "false"}"><i class="fa-regular fa-chart-bar nav-title-icon" aria-hidden="true"></i><span>Dashboard</span></a>
            <div class="nav-sub" data-nav-sub>
              <a class="subnav-link ${showDashboard ? "active" : ""}" href="/admin${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Overview</a>
            </div>
          </div>
          <div class="sb-divider"></div>
          ` : ``}

          ${canManageEvents ? `<div class="nav-group nav-collapsible ${eventsMenuOpen ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin/existing-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${eventsMenuOpen ? "page" : "false"}"><i class="fa-regular fa-calendar nav-title-icon" aria-hidden="true"></i><span>Events</span></a>
            <div class="nav-sub" data-nav-sub>
              <a class="subnav-link ${showExisting ? "active" : ""}" href="/admin/existing-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">${isOrganizerUser ? "My Events" : "All Events"}</a>
              <a class="subnav-link ${showCreate ? "active" : ""}" href="/admin/create-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Events</a>
              ${canApproveEvents ? `
              <a class="subnav-link ${showApprove ? "active" : ""}" href="/admin/approve-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" style="display:flex; align-items:center; gap:8px;">
                <span>Approve Events</span>
                ${pendingCount > 0 ? `<span class="badge badge--nav">${pendingCount}</span>` : ``}
              </a>` : ``}
              <a class="subnav-link ${showUpload ? "active" : ""}" href="/admin/upload-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Upload Events</a>
            </div>
          </div>
          <div class="sb-divider"></div>` : ``}

          ${canManageVenues ? `<div class="nav-group nav-collapsible ${venuesMenuOpen ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin/venues${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${venuesMenuOpen ? "page" : "false"}"><i class="fa-regular fa-building nav-title-icon" aria-hidden="true"></i><span>Venues</span></a>
            <div class="nav-sub" data-nav-sub>
              <a class="subnav-link ${showVenueExisting ? "active" : ""}" href="/admin/venues${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Venues</a>
              <a class="subnav-link ${showVenueCreate ? "active" : ""}" href="/admin/venues/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Venues</a>
            </div>
          </div>
          <div class="sb-divider"></div>` : ``}

          ${canManageJobs ? `<div class="nav-group nav-collapsible ${jobsMenuOpen ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin/jobs${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${jobsMenuOpen ? "page" : "false"}"><i class="fa-regular fa-clipboard nav-title-icon" aria-hidden="true"></i><span>Jobs</span></a>
            <div class="nav-sub" data-nav-sub>
              <a class="subnav-link ${showJobsExisting ? "active" : ""}" href="/admin/jobs${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Jobs</a>
              <a class="subnav-link ${showJobsCreate ? "active" : ""}" href="/admin/jobs/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Jobs</a>
              <a class="subnav-link ${showJobsApplicants ? "active" : ""}" href="/admin/jobs/applicants${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Applicants</a>
            </div>
          </div>
          <div class="sb-divider"></div>` : ``}

          ${canManageAds ? `<div class="nav-group nav-collapsible ${adsMenuOpen ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin/ads${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${adsMenuOpen ? "page" : "false"}"><i class="fa-regular fa-image nav-title-icon" aria-hidden="true"></i><span>Ads</span></a>
            <div class="nav-sub" data-nav-sub>
              <a class="subnav-link ${showAdsExisting ? "active" : ""}" href="/admin/ads${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Ads</a>
              <a class="subnav-link ${showAdsCreate ? "active" : ""}" href="/admin/ads/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Ads</a>
            </div>
          </div>
          ` : ``}

          ${(canSeeAnyAnalytics ? `<div class="sb-divider"></div>
          <div class="nav-group nav-collapsible ${analyticsMenuOpen ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="/admin/events-analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" aria-current="${analyticsMenuOpen ? "page" : "false"}"><i class="fa-solid fa-chart-column nav-title-icon" aria-hidden="true"></i><span>Analytics</span></a>
            <div class="nav-sub" data-nav-sub>
              ${canSeeEventsAnalytics ? `<a class="subnav-link ${showAnalytics ? "active" : ""}" href="/admin/events-analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Events</a>` : ``}
              ${canSeeOrganizerAnalytics ? `<a class="subnav-link ${showOrganizers ? "active" : ""}" href="/admin/events-organizers${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Organizers</a>` : ``}
              ${canSeeVenueAnalytics ? `<a class="subnav-link ${showVenueAnalytics ? "active" : ""}" href="/admin/venues/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Venues</a>` : ``}
              ${canSeeJobAnalytics ? `<a class="subnav-link ${showJobsAnalytics ? "active" : ""}" href="/admin/jobs/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Jobs</a>` : ``}
              ${canSeeAdsAnalytics ? `<a class="subnav-link ${showAdsAnalytics ? "active" : ""}" href="/admin/ads/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Ads</a>` : ``}
            </div>
          </div>` : ``)}

          ${(hasDeveloperAccess || isOrganizerUser) ? `<div class="sb-divider"></div>
          <div class="nav-group nav-collapsible ${adminMenuOpen ? "is-open" : ""}" data-nav-group>
            <a class="nav-title-btn" href="${hasDeveloperAccess ? `/admin/users${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}` : "/admin/preferences"}" aria-current="${adminMenuOpen ? "page" : "false"}"><i class="fa-regular fa-user nav-title-icon" aria-hidden="true"></i><span>Admin</span></a>
            <div class="nav-sub" data-nav-sub>
              <a class="subnav-link ${showPreferences ? "active" : ""}" href="/admin/preferences">Preferences</a>
              <a class="subnav-link ${showUpdatesLog ? "active" : ""}" href="/admin/updates-log">Release Notes</a>
              ${hasDeveloperAccess ? `<a class="subnav-link ${showUsers ? "active" : ""}" href="/admin/users">Users</a>` : ``}
              ${hasDeveloperAccess ? `<a class="subnav-link ${showInvites ? "active" : ""}" href="/admin/invites">Invites</a>` : ``}
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
            <button type="button" class="mobile-sidebar-toggle" id="mobileSidebarToggle" aria-label="Open sidebar" aria-expanded="false" aria-controls="adminSidebar">
              <i class="fa-solid fa-bars" aria-hidden="true"></i>
            </button>
            ${showSearch ? `
            <div class="h-left-search">
              <form class="search" method="GET" action="${searchAction}">
                <input name="q" value="${esc(q)}" placeholder="${searchPlaceholder}" />
                ${selectedCity ? `<input type="hidden" name="city" value="${esc(selectedCity)}" />` : ``}
                <input type="hidden" name="pg" value="1" />
                <input type="hidden" name="limit" value="${esc(String(limit))}" />
                ${(showVenueCreate || showVenueExisting || showVenueAnalytics || showJobsCreate || showJobsExisting || showJobsApplicants || showJobsAnalytics || showAdsCreate || showAdsExisting || showAdsAnalytics) ? `` : `<input type="hidden" name="status" value="${esc(String(statusMode))}" />`}
                ${(showVenueCreate || showVenueExisting || showVenueAnalytics || showJobsCreate || showJobsExisting || showJobsApplicants || showJobsAnalytics || showAdsCreate || showAdsExisting || showAdsAnalytics) ? `` : (recurringOnly ? `<input type="hidden" name="recurring" value="${esc(String(1))}" />` : ``)}
                ${q ? `<a class="btn" href="${searchResetHref}">Reset</a>` : ``}
              </form>
            </div>
            ` : ``}
          </div>

          <div class="h-right">
            <div class="header-tools">
              <div class="header-account-menu" data-account-menu>
                <button type="button" class="header-icon-btn header-account-trigger" data-account-trigger title="Account" aria-label="Account" aria-expanded="false" aria-haspopup="true">
                  ${currentUser?.photoUrl
                    ? `<img class="header-avatar" src="${esc(currentUser.photoUrl)}" alt="${esc(currentUser.displayName || currentUser.username || "User")}" />`
                    : `<i class="fa-regular fa-user" aria-hidden="true"></i>`}
                  ${currentUser?.id ? `<span class="header-status-badge ${esc(currentPresenceClass)}" title="${esc(currentPresenceLabel)}" aria-label="${esc(currentPresenceLabel)}"></span>` : ``}
                </button>
                <div class="header-account-dropdown" data-account-dropdown>
                  <div class="account-menu-group">
                    <a class="account-menu-link" href="/admin/preferences">
                      <span>Preferences</span>
                      <span class="account-menu-icon" aria-hidden="true">${renderInlineIcon("gear")}</span>
                    </a>
                  </div>
                  <div class="account-menu-divider"></div>
                  <div class="account-menu-group">
                    <div class="account-menu-section-label">Status</div>
                    <div class="account-status-grid">
                      ${[
                        { value: "available", label: "Available" },
                        { value: "away", label: "Away" },
                        { value: "dnd", label: "Do Not Disturb" },
                      ].map((statusOption) => `
                        <form class="account-status-form" method="POST" action="/admin/preferences/status">
                          <input type="hidden" name="status" value="${statusOption.value}" />
                          <input type="hidden" name="redirectTo" value="${esc(currentAdminPath)}" />
                          <button class="account-status-btn ${currentPresenceStatus === statusOption.value ? "active" : ""}" type="submit">
                            <span class="account-status-meta">
                              <span class="account-status-dot is-${statusOption.value}"></span>
                              <span>${statusOption.label}</span>
                            </span>
                          </button>
                        </form>
                      `).join("")}
                    </div>
                  </div>
                  <div class="account-menu-divider"></div>
                  <div class="account-menu-group">
                    <a class="account-menu-link" href="/logout">
                      <span>Log Out</span>
                      <span class="account-menu-icon" aria-hidden="true">${renderInlineIcon("logout")}</span>
                    </a>
                  </div>
                </div>
              </div>
              ${canUseMessages ? `<a class="header-icon-btn header-message-icon" href="/admin/messages${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" title="Messages" aria-label="Messages">
                <i class="fa-regular fa-envelope" aria-hidden="true"></i>
                ${unreadMessagesCount > 0 ? `<span class="icon-badge">${unreadMessagesCount > 99 ? "99+" : unreadMessagesCount}</span>` : ``}
              </a>` : ``}
              <a class="header-icon-btn" href="${canApproveEvents ? `/admin/approve-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}` : `/admin${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}`}" title="Notifications" aria-label="Notifications">
                <i class="fa-regular fa-bell" aria-hidden="true"></i>
                ${canApproveEvents && pendingCount > 0 ? `<span class="icon-badge">${pendingCount > 99 ? "99+" : pendingCount}</span>` : ``}
              </a>
            </div>
          </div>
        </div>

        <script>
        (function(){
          var lastCount = ${pendingCount};
          var lastMessageCount = ${unreadMessagesCount};
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
              var m = Number(json && json.messages || 0);
              if(c > lastCount && document.visibilityState === 'visible'){
                beep();
              }
              if(m > lastMessageCount && document.visibilityState === 'visible'){
                beep();
              }
              lastCount = c;
              lastMessageCount = m;
            }catch(e){}
          }

          setInterval(check, pollMs);
        })();
        </script>

        <!-- Dashboard Overview -->
        ${showDashboard ? `
        <section class="dashboard-shell" id="dashboard-overview">
          <div class="dashboard-col dashboard-col-fill">
            <details class="card dashboard-card" id="dashboard-quick-links" data-collapsible-card open>
              <summary class="sectionTitle">
                <span class="card-toggle" data-card-toggle aria-expanded="true" aria-controls="dashboard-quick-links-body">
                  <h2>Quick links</h2>
                  <i class="fa-solid fa-chevron-down card-caret" aria-hidden="true"></i>
                </span>
              </summary>
              <div class="card-body" id="dashboard-quick-links-body">
                <div class="quick-links-grid${isOrganizerUser ? ` is-organizer` : ``}">
                  ${canManageEvents ? `<div class="quick-links-group">
                    <div class="quick-links-group-title">Events</div>
                    <a class="btn quick-link" href="/admin/existing-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">${isOrganizerUser ? "My Events" : "All Events"}</a>
                    <a class="btn quick-link" href="/admin/create-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Event</a>
                    ${isOrganizerUser
                      ? `<a class="btn quick-link" href="/admin/upload-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Upload Events</a>`
                      : canApproveEvents
                      ? `<a class="btn quick-link" href="/admin/approve-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Approve Events${pendingCount > 0 ? ` (${pendingCount})` : ""}</a>`
                      : (canSeeEventsAnalytics
                        ? `<a class="btn quick-link" href="/admin/events-analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Events Analytics</a>`
                        : ``)}
                  </div>` : ``}
                  ${canManageVenues ? `<div class="quick-links-group">
                    <div class="quick-links-group-title">Venues</div>
                    <a class="btn quick-link" href="/admin/venues${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Venues</a>
                    <a class="btn quick-link" href="/admin/venues/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Venue</a>
                    ${canSeeVenueAnalytics ? `<a class="btn quick-link" href="/admin/venues/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Venue Analytics</a>` : ``}
                  </div>` : ``}
                  ${canManageJobs ? `<div class="quick-links-group">
                    <div class="quick-links-group-title">Jobs</div>
                    <a class="btn quick-link" href="/admin/jobs${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Jobs</a>
                    <a class="btn quick-link" href="/admin/jobs/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Job</a>
                    <a class="btn quick-link" href="/admin/jobs/applicants${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Applicants</a>
                  </div>` : ``}
                  ${canManageAds ? `<div class="quick-links-group">
                    <div class="quick-links-group-title">Ads</div>
                    <a class="btn quick-link" href="/admin/ads${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">All Ads</a>
                    <a class="btn quick-link" href="/admin/ads/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Ad</a>
                    ${canSeeAdsAnalytics ? `<a class="btn quick-link" href="/admin/ads/analytics${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Ads Analytics</a>` : ``}
                  </div>` : ``}
                </div>
              </div>
            </details>

            <details class="card dashboard-card" id="dashboard-calendar-card" data-dashboard-card="calendar" data-collapsible-card open>
              <summary class="sectionTitle">
                <span class="card-toggle" data-card-toggle aria-expanded="true" aria-controls="dashboard-calendar-body">
                  <h2>Calendar</h2>
                  <i class="fa-solid fa-chevron-down card-caret" aria-hidden="true"></i>
                </span>
              </summary>
              <div class="card-body" id="dashboard-calendar-body">
                ${dashboardCalendarHtml}
              </div>
            </details>

            <details class="card dashboard-card" id="dashboard-release-notes-card" data-dashboard-card="release-notes" data-collapsible-card open>
              <summary class="sectionTitle">
                <span class="card-toggle" data-card-toggle aria-expanded="true" aria-controls="dashboard-release-notes-body">
                  <h2>Release notes</h2>
                  <i class="fa-solid fa-chevron-down card-caret" aria-hidden="true"></i>
                </span>
              </summary>
              <div class="card-body" id="dashboard-release-notes-body">
                <div class="mini">
                  <div style="font-weight:650; margin-bottom:8px;">Release notes</div>
                  <div class="release-meta">
                    <div class="release-row"><div class="label">App version</div><div class="value">${esc(stats.appVersion)}</div></div>
                    <div class="release-row"><div class="label">Latest update</div><div class="value">${esc(latestRelease.date)}</div></div>
                  </div>
                  <div style="margin-top:12px; display:grid; gap:8px;">
                    <div class="release-latest">
                      <div class="value">${esc(latestRelease.text)}</div>
                    </div>
                  </div>
                  <div style="margin-top:12px;">
                    <a class="btn" href="/admin/updates-log">View full release notes</a>
                  </div>
                </div>
              </div>
            </details>
          </div>

          <div class="dashboard-col dashboard-col-fill dashboard-insights" data-dashboard-column="right">
            ${canUseMessages ? `<details class="card dashboard-card" id="dashboard-messages-card" data-dashboard-card="messages" data-collapsible-card open>
              <summary class="sectionTitle">
                <span class="card-toggle" data-card-toggle aria-expanded="true" aria-controls="dashboard-messages-body">
                  <h2>Messages</h2>
                  <i class="fa-solid fa-chevron-down card-caret" aria-hidden="true"></i>
                </span>
              </summary>
              <div class="card-body" id="dashboard-messages-body">
                <div class="insight-list">${messagesDashboardHtml}</div>
                <div style="margin-top:12px;">
                  <a class="btn" href="/admin/messages${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Open messages</a>
                </div>
              </div>
            </details>` : ``}

            <details class="card dashboard-card" id="dashboard-activity-card" data-dashboard-card="activity" data-collapsible-card open>
              <summary class="sectionTitle">
                <span class="card-toggle" data-card-toggle aria-expanded="true" aria-controls="dashboard-activity-body">
                  <h2>Activity</h2>
                  <i class="fa-solid fa-chevron-down card-caret" aria-hidden="true"></i>
                </span>
              </summary>
              <div class="card-body" id="dashboard-activity-body">
                <div class="activity-list">${activityDashboardHtml}</div>
              </div>
            </details>

            ${(canSeeEventsAnalytics || canSeeVenueAnalytics || canSeeAdsAnalytics) ? `<details class="card dashboard-card" id="dashboard-insights-card" data-dashboard-card="insights" data-collapsible-card open>
              <summary class="sectionTitle">
                <span class="card-toggle" data-card-toggle aria-expanded="true" aria-controls="dashboard-insights-body">
                  <h2>Insights</h2>
                  <i class="fa-solid fa-chevron-down card-caret" aria-hidden="true"></i>
                </span>
              </summary>
              <div class="card-body" id="dashboard-insights-body">
                <div class="insights-switcher" id="dashboardInsightsSwitcher">
                  ${canSeeEventsAnalytics ? `<button type="button" class="is-active" data-insight-target="events" onclick="(function(btn){var wrap=btn.parentNode;Array.prototype.forEach.call(wrap.querySelectorAll('[data-insight-target]'),function(el){el.classList.toggle('is-active',el===btn);});Array.prototype.forEach.call(document.querySelectorAll('[data-insight-panel]'),function(panel){panel.classList.toggle('is-active',panel.getAttribute('data-insight-panel')==='events');});if(window.ocDashboardInsightActivate) window.ocDashboardInsightActivate('events');})(this)">Events</button>` : ``}
                  ${canSeeVenueAnalytics ? `<button type="button" class="${canSeeEventsAnalytics ? "" : "is-active"}" data-insight-target="venues" onclick="(function(btn){var wrap=btn.parentNode;Array.prototype.forEach.call(wrap.querySelectorAll('[data-insight-target]'),function(el){el.classList.toggle('is-active',el===btn);});Array.prototype.forEach.call(document.querySelectorAll('[data-insight-panel]'),function(panel){panel.classList.toggle('is-active',panel.getAttribute('data-insight-panel')==='venues');});if(window.ocDashboardInsightActivate) window.ocDashboardInsightActivate('venues');})(this)">Venues</button>` : ``}
                  ${canSeeAdsAnalytics ? `<button type="button" class="${(!canSeeEventsAnalytics && !canSeeVenueAnalytics) ? "is-active" : ""}" data-insight-target="ads" onclick="(function(btn){var wrap=btn.parentNode;Array.prototype.forEach.call(wrap.querySelectorAll('[data-insight-target]'),function(el){el.classList.toggle('is-active',el===btn);});Array.prototype.forEach.call(document.querySelectorAll('[data-insight-panel]'),function(panel){panel.classList.toggle('is-active',panel.getAttribute('data-insight-panel')==='ads');});if(window.ocDashboardInsightActivate) window.ocDashboardInsightActivate('ads');})(this)">Ads</button>` : ``}
                </div>
                ${canSeeEventsAnalytics ? `<div class="insight-panel is-active" data-insight-panel="events"><div class="insight-list">
                  <div class="insight-row"><div class="label">Events</div><div class="value">${esc(stats.total)}</div></div>
                  <div class="insight-row"><div class="label">Upcoming</div><div class="value">${esc(stats.upcoming)}</div></div>
                  <div class="insight-row"><div class="label">Featured</div><div class="value">${esc(stats.featured)}</div></div>
                  <div class="insight-row"><div class="label">Views</div><div class="value">${esc(stats.views)}</div></div>
                </div></div>` : ``}
                ${canSeeVenueAnalytics ? `<div class="insight-panel ${canSeeEventsAnalytics ? "" : "is-active"}" data-insight-panel="venues"><div class="insight-list">
                  <div class="insight-row"><div class="label">Venues</div><div class="value">${esc(venueStats.total)}</div></div>
                  <div class="insight-row"><div class="label">Views</div><div class="value">${esc(venueStats.views)}</div></div>
                  <div class="insight-row"><div class="label">Total Link Clicks</div><div class="value">${esc(venueStats.totalClicks)}</div></div>
                </div></div>` : ``}
                ${canSeeAdsAnalytics ? `<div class="insight-panel ${(!canSeeEventsAnalytics && !canSeeVenueAnalytics) ? "is-active" : ""}" data-insight-panel="ads"><div class="insight-list">
                  <div class="insight-row"><div class="label">Ads</div><div class="value">${esc(adAnalyticsStats.total)}</div></div>
                  <div class="insight-row"><div class="label">Active</div><div class="value">${esc(adAnalyticsStats.active)}</div></div>
                  <div class="insight-row"><div class="label">Clicks</div><div class="value">${esc(adAnalyticsStats.clicks)}</div></div>
                  <div class="insight-row"><div class="label">Views</div><div class="value">${esc(adAnalyticsStats.views)}</div></div>
                </div></div>` : ``}
                </div>
              </div>
            </details>` : ``}
          </div>
        </section>
        ` : ``}

        <!-- Metrics -->
        ${showAnalytics ? `
        <section class="metrics" id="analytics">
          ${selectedEventAnalytics ? `
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("All views", analyticsMetricHelp.allViews)}</div>
              <div class="v">${esc(selectedEventAnalytics.allViews.toLocaleString("en-US"))}</div>
            </div>
          </div>
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("Direct views", analyticsMetricHelp.directViews)}</div>
              <div class="v">${esc(selectedEventAnalytics.directViews.toLocaleString("en-US"))}</div>
            </div>
            <div class="tag">${esc(selectedEventAnalytics.allViews > 0 ? `${Math.round((selectedEventAnalytics.directViews / selectedEventAnalytics.allViews) * 100)}%` : "0%")}</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("Referral views", analyticsMetricHelp.referralViews)}</div>
              <div class="v">${esc(selectedEventAnalytics.referralViews.toLocaleString("en-US"))}</div>
            </div>
            <div class="tag">${esc(selectedEventAnalytics.allViews > 0 ? `${Math.round((selectedEventAnalytics.referralViews / selectedEventAnalytics.allViews) * 100)}%` : "0%")}</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("Internal views", analyticsMetricHelp.internalViews)}</div>
              <div class="v">${esc(selectedEventAnalytics.internalViews.toLocaleString("en-US"))}</div>
            </div>
            <div class="tag">${esc(selectedEventAnalytics.allViews > 0 ? `${Math.round((selectedEventAnalytics.internalViews / selectedEventAnalytics.allViews) * 100)}%` : "0%")}</div>
          </div>
          ` : `
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("Total events", analyticsMetricHelp.totalEvents)}</div>
              <div class="v">${esc(stats.total)}</div>
            </div>
          </div>
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("Unique events", analyticsMetricHelp.uniqueEvents)}</div>
              <div class="v">${esc(stats.uniqueTotal)}</div>
            </div>
          </div>
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("Upcoming", analyticsMetricHelp.upcoming)}</div>
              <div class="v">${esc(stats.upcoming)}</div>
            </div>
          </div>
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("Featured", analyticsMetricHelp.featured)}</div>
              <div class="v">${esc(stats.featured)}</div>
            </div>
          </div>
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("All views", analyticsMetricHelp.allViews)}</div>
              <div class="v">${esc(stats.sourceTracked)}</div>
            </div>
          </div>
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("Direct views", analyticsMetricHelp.directViews)}</div>
              <div class="v">${esc(stats.sourceDirect)}</div>
            </div>
            <div class="tag">${esc(stats.sourceDirectPct)}</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("Referral views", analyticsMetricHelp.referralViews)}</div>
              <div class="v">${esc(stats.sourceReferral)}</div>
            </div>
            <div class="tag">${esc(stats.sourceReferralPct)}</div>
          </div>
          <div class="metric">
            <div>
              <div class="k">${analyticsMetricLabel("Internal views", analyticsMetricHelp.internalViews)}</div>
              <div class="v">${esc(stats.sourceInternal)}</div>
            </div>
            <div class="tag">${esc(stats.sourceInternalPct)}</div>
          </div>
          `}
        </section>
        ` : ``}

        <!-- Charts -->
        ${showAnalytics ? `
        <section class="${isOrganizerUser ? "analytics-main-grid organizer-analytics-single" : "grid2 analytics-main-grid organizer-chart-grid"}">
          <div class="card">
            <div class="sectionTitle sectionTitle--chart">
              <div class="left">
                <div class="chartTopRow">
                    <div class="chartLegend" id="eventsChartLegend" aria-label="Chart legend">
                      <div class="chartLegendItem is-events" data-legend-metric="events">
                        <span class="chartLegendLine"></span>
                        <span>${isOrganizerUser ? "My events" : "Events"}</span>
                      </div>
                      <div class="chartLegendItem is-views" data-legend-metric="views">
                        <span class="chartLegendLine is-dashed"></span>
                      <span>Views</span>
                    </div>
                  </div>
                  <p class="sub" id="chartRangeLabel">${esc(chartRangeLabelByMode[chartViewMode] || chartRangeLabelByMode.daily)}</p>
                </div>
              </div>
              <div class="right">
                <div class="seg" id="chartViewSeg" aria-label="Chart view">
                  <a href="${buildAnalyticsChartHref("daily")}" data-view="daily" class="${chartViewMode === "daily" ? "on" : ""}">Daily</a>
                  <a href="${buildAnalyticsChartHref("weekly")}" data-view="weekly" class="${chartViewMode === "weekly" ? "on" : ""}">Weekly</a>
                  <a href="${buildAnalyticsChartHref("monthly")}" data-view="monthly" class="${chartViewMode === "monthly" ? "on" : ""}">Monthly</a>
                  <a href="${buildAnalyticsChartHref("yearly")}" data-view="yearly" class="${chartViewMode === "yearly" ? "on" : ""}">Yearly</a>
                </div>
              </div>
            </div>
            <div class="chart-wrap" id="eventsChartWrap" style="min-height:96px;">
              <div id="eventsChartSvgHost">${eventsChartSvgByMode[chartViewMode] || eventsChartSvgByMode.daily}</div>
              <div id="eventsChartData" data-chart="${esc(chartDataJson)}" hidden></div>
              <canvas id="eventsChart" style="width:100%; height:194px; display:none;"></canvas>
                <div id="eventsChartTip" style="position:absolute; display:none; pointer-events:none; padding:6px 8px; border-radius:6px; border:1px solid rgba(148,163,184,.35); background:rgba(255,255,255,.98); color:rgba(15,23,42,.95); font-size:12px; line-height:1.2; box-shadow:none;"></div>
            </div>
          </div>

          ${!isOrganizerUser ? `
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>${esc(analyticsSideTitle)}</h2>
                <p class="sub">${esc(analyticsSideSub)}</p>
              </div>
            </div>
            ${analyticsSideBodyHtml}
          </div>
          ` : ``}
        </section>
        ` : ``}

        ${showOrganizers ? `
        <section class="metrics" id="organizer-analytics-metrics">
          <div class="metric"><div><div class="k">${analyticsMetricLabel("Organizers", analyticsMetricHelp.organizers)}</div><div class="v">${organizerAnalyticsOptions.length.toLocaleString("en-US")}</div></div></div>
          <div class="metric"><div><div class="k">${analyticsMetricLabel("Unique events", analyticsMetricHelp.uniqueEvents)}</div><div class="v">${organizerPageSummary.uniqueEvents.toLocaleString("en-US")}</div></div></div>
          <div class="metric"><div><div class="k">${analyticsMetricLabel("Total events", analyticsMetricHelp.totalEvents)}</div><div class="v">${organizerPageSummary.totalOccurrences.toLocaleString("en-US")}</div></div></div>
          <div class="metric"><div><div class="k">${analyticsMetricLabel("Upcoming", analyticsMetricHelp.upcoming)}</div><div class="v">${organizerPageSummary.upcomingOccurrences.toLocaleString("en-US")}</div></div></div>
        </section>

        <section class="grid2 analytics-main-grid organizer-chart-grid">
          <div class="card">
            <div class="sectionTitle sectionTitle--chart">
              <div class="left">
                <div class="chartTopRow">
                  <div class="chartLegend" id="organizerChartLegend" aria-label="Organizer chart legend">
                    <div class="chartLegendItem is-events" data-legend-metric="events">
                      <span class="chartLegendLine"></span>
                      <span>Events</span>
                    </div>
                    <div class="chartLegendItem is-views" data-legend-metric="views">
                      <span class="chartLegendLine is-dashed"></span>
                      <span>Views</span>
                    </div>
                  </div>
                  <p class="sub" id="organizerChartRangeLabel">Last 12 months</p>
                </div>
                <div class="chartTitle" style="font-weight:700;">${esc(organizerChartTitle)}</div>
              </div>
            </div>
            <div class="chart-wrap" id="organizerChartWrap" style="min-height:220px;">
              <div id="organizerChartSvgHost">${organizerChartSvg}</div>
              <div id="organizerChartData" data-chart="${esc(organizerChartDataJson)}" hidden></div>
              <canvas id="organizerChart" style="position:absolute; inset:0; width:100%; height:260px; display:none;"></canvas>
              <div id="organizerChartTip" style="position:absolute; display:none; pointer-events:none; padding:6px 8px; border-radius:6px; border:1px solid rgba(148,163,184,.35); background:rgba(255,255,255,.98); color:rgba(15,23,42,.95); font-size:12px; line-height:1.2; box-shadow:none;"></div>
            </div>
          </div>

          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>${esc(organizerInsightsHeading)}</h2>
                <p class="sub">${esc(organizerInsightsSub)}</p>
              </div>
            </div>
            ${organizerAnalyticsOptions.length ? `
            ${organizerSelectionHtml}
            <div class="mini" style="margin-top:14px;">
              <div class="kv"><div class="k">Unique events</div><div class="v">${organizerSummary.uniqueEvents.toLocaleString("en-US")}</div></div>
              <div class="kv"><div class="k">Total events</div><div class="v">${organizerSummary.totalOccurrences.toLocaleString("en-US")}</div></div>
              <div class="kv"><div class="k">Upcoming</div><div class="v">${organizerSummary.upcomingOccurrences.toLocaleString("en-US")}</div></div>
              <div class="kv"><div class="k">Featured</div><div class="v">${organizerSummary.featured.toLocaleString("en-US")}</div></div>
              <div class="kv"><div class="k">All views</div><div class="v">${organizerSummary.allViews.toLocaleString("en-US")}</div></div>
              <div class="kv"><div class="k">Direct views</div><div class="v">${organizerSummary.directViews.toLocaleString("en-US")}</div></div>
              <div class="kv"><div class="k">Referral views</div><div class="v">${organizerSummary.referralViews.toLocaleString("en-US")}</div></div>
              <div class="kv"><div class="k">Internal views</div><div class="v">${organizerSummary.internalViews.toLocaleString("en-US")}</div></div>
            </div>
            ` : `
            <div class="mini">
              No organizers found for the current city yet.
            </div>
            `}
          </div>
        </section>

        ${selectedOrganizer ? `
        <section>
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>${esc(organizerTopEventsTitle)}</h2>
                <p class="sub">Top 5 by lifetime views</p>
              </div>
            </div>
            <div class="mini mini-list">${organizerTopEventsHtml}</div>
          </div>
        </section>
        ` : `
        <section class="grid2 analytics-main-grid">
          <div class="card organizer-leaderboard-card">
            <div class="sectionTitle">
              <div>
                <h2>Top 10 organizers</h2>
                <p class="sub">Performance ranked by views</p>
              </div>
            </div>
            <div class="mini">
              <table class="analytics-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Organizer</th>
                    <th>Unique</th>
                    <th>Total</th>
                    <th>Upcoming</th>
                    <th>Views</th>
                  </tr>
                </thead>
                <tbody>${organizerLeaderboardHtml}</tbody>
              </table>
            </div>
          </div>

          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>${esc(organizerTopEventsTitle)}</h2>
                <p class="sub">Top 5 by lifetime views</p>
              </div>
            </div>
            <div class="mini mini-list">${organizerTopEventsHtml}</div>
          </div>
        </section>
        `}
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
            <div class="mini mini-list">${topTodayHtml}</div>
          </div>
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Top events this week</h2>
                <p class="sub">Top 5 by views</p>
              </div>
            </div>
            <div class="mini mini-list">${topWeekHtml}</div>
          </div>
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Top events this month</h2>
                <p class="sub">Top 5 by views</p>
              </div>
            </div>
            <div class="mini mini-list">${topMonthHtml}</div>
          </div>
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Top events this year</h2>
                <p class="sub">Top 5 by views</p>
              </div>
            </div>
            <div class="mini mini-list">${topYearHtml}</div>
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
          ${inviteLimitNoticeHtml}
          <form method="POST" action="/admin/invites?city=${encodeURIComponent(selectedCity)}" style="display:grid; gap:12px; max-width:520px;">
            <div class="field">
              <label>Email (optional, to lock invite)</label>
              <input type="email" name="email" placeholder="name@example.com" />
            </div>
            <div class="field">
              <label>Role</label>
              <select name="role">
                ${liveRoleOptionsMarkup("organizer")}
              </select>
            </div>
            <div class="field">
              <label>City</label>
              <select name="city" ${hasDeveloperAccess ? "" : "disabled"}>
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

        ${showMessages ? `
        <section class="messages-layout" id="messages">
          <div class="card messages-card messages-contact-card">
            <div class="sectionTitle">
              <div>
                <h2>${esc(selectedCity)} users</h2>
                <p class="sub">Message people in your city, see who is online, or open Support Circle for troubleshooting help.</p>
              </div>
            </div>
            ${messagesNoticeHtml}
            <div class="message-list">${messageContactsHtml}</div>
          </div>

          <div class="card messages-card">
            <div class="sectionTitle">
              <div>
                <h2>${selectedMessageContact ? esc(selectedMessageContact.supportAlias ? "Support Circle" : (selectedMessageContact.displayName || selectedMessageContact.username || selectedMessageContact.email || "Conversation")) : "Conversation"}</h2>
                <p class="sub">${selectedMessageContact ? esc(selectedMessageContact.supportAlias ? "Troubleshooting chat" : `${selectedCity} conversation`) : `Choose a ${selectedCity} user to start messaging.`}</p>
              </div>
            </div>
            <div class="messages-panel">
            ${selectedMessageContact ? `
            <div class="mini messages-profile">
              <div class="user-line" style="font-weight:650; color:var(--text);">
                ${onlineStatusMarkup(selectedMessageContact.lastSeenAt, `${selectedMessageContact.supportAlias ? "Support Circle" : (selectedMessageContact.displayName || selectedMessageContact.username || selectedMessageContact.email || "User")} status`)}
                <span>${esc(selectedMessageContact.supportAlias ? "Support Circle" : (selectedMessageContact.displayName || selectedMessageContact.username || selectedMessageContact.email || "User"))}</span>
              </div>
                  <div class="muted" style="margin-top:6px;">${selectedMessageContact.supportAlias ? `Direct troubleshooting help for ${esc(selectedCity)} users` : `Role: ${esc(formatRoleLabel(selectedMessageContact.role || "organizer"))} · City: ${esc(selectedMessageContact.city || selectedCity)}`}</div>
            </div>
            ` : ``}
            <div class="messages-thread">${messageConversationHtml}</div>
            ${selectedMessageContact ? `<div class="message-typing-status" id="messageTypingStatus" aria-live="polite"></div>` : ``}
            ${selectedMessageContact ? `
            <form class="messages-compose" method="POST" action="/admin/messages" id="messagesComposeForm">
              <input type="hidden" name="recipientUserId" value="${esc(String(selectedMessageContact.id))}" />
              ${selectedCity ? `<input type="hidden" name="city" value="${esc(selectedCity)}" />` : ``}
              <textarea class="ctrl" name="body" id="messagesComposeBody" placeholder="Write a message to ${esc(selectedMessageContact.supportAlias ? "Support Circle" : (selectedMessageContact.displayName || selectedMessageContact.username || selectedMessageContact.email || "this user"))}..." required></textarea>
              <div><button class="btn btn-primary" type="submit">Send message</button></div>
            </form>
            ` : ``}
            </div>
          </div>
        </section>
        <script>
        (function(){
          var recipientUserId = ${selectedMessageContact ? Number(selectedMessageContact.id || 0) : 0};
          var currentCity = ${JSON.stringify(String(selectedCity || ""))};
          var bodyEl = document.getElementById("messagesComposeBody");
          var formEl = document.getElementById("messagesComposeForm");
          var typingEl = document.getElementById("messageTypingStatus");
          if (!recipientUserId || !bodyEl || !typingEl) return;

          var lastTypedAt = 0;
          var typingSent = false;
          var typingTimeout = null;
          var heartbeatMs = 3000;
          var idleMs = 5000;

          function setTypingLabel(name){
            if (!typingEl) return;
            if (name) {
              typingEl.textContent = name + " is typing...";
              typingEl.classList.add("is-active");
            } else {
              typingEl.textContent = "";
              typingEl.classList.remove("is-active");
            }
          }

          async function sendTyping(active){
            try{
              await fetch("/admin/messages/typing", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  recipientUserId: recipientUserId,
                  city: currentCity,
                  active: active ? 1 : 0
                }),
                cache: "no-store"
              });
              typingSent = !!active;
            }catch(e){}
          }

          function scheduleStop(){
            if (typingTimeout) window.clearTimeout(typingTimeout);
            typingTimeout = window.setTimeout(function(){
              sendTyping(false);
            }, idleMs);
          }

          bodyEl.addEventListener("input", function(){
            var hasText = !!String(bodyEl.value || "").trim();
            lastTypedAt = Date.now();
            if (hasText && !typingSent) {
              sendTyping(true);
            } else if (!hasText && typingSent) {
              sendTyping(false);
            }
            scheduleStop();
          });

          bodyEl.addEventListener("blur", function(){
            sendTyping(false);
          });

          if (formEl) {
            formEl.addEventListener("submit", function(){
              sendTyping(false);
            });
          }

          window.addEventListener("beforeunload", function(){
            if (!typingSent) return;
            try{
              navigator.sendBeacon("/admin/messages/typing", new Blob([JSON.stringify({
                recipientUserId: recipientUserId,
                city: currentCity,
                active: 0
              })], { type: "application/json" }));
            }catch(e){}
          });

          async function pollTyping(){
            try{
              var url = "/admin/messages/typing?user=" + encodeURIComponent(String(recipientUserId));
              if (currentCity) url += "&city=" + encodeURIComponent(currentCity);
              var res = await fetch(url, { cache: "no-store" });
              if (!res.ok) return;
              var json = await res.json();
              if (json && json.ok && json.typing && json.name) {
                setTypingLabel(String(json.name));
              } else {
                setTypingLabel("");
              }
            }catch(e){}
          }

          pollTyping();
          window.setInterval(function(){
            var hasText = !!String(bodyEl.value || "").trim();
            if (typingSent && hasText && (Date.now() - lastTypedAt) < idleMs) {
              sendTyping(true);
            }
            pollTyping();
          }, heartbeatMs);
        })();
        </script>
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
                <div class="note" style="margin-top:10px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
                  <span class="online-dot ${esc(currentPresenceClass)}" title="${esc(currentPresenceLabel)}" aria-label="${esc(currentPresenceLabel)}"></span>
                  <span>Status: <strong style="color:var(--text);">${esc(currentPresenceLabel)}</strong></span>
                  <span>·</span>
                  <span>Role: <strong style="color:var(--text);">${esc(formatRoleLabel(currentUser.role || "organizer"))}</strong></span>
                  <span>·</span>
                  <span>City: <strong style="color:var(--text);">${esc(currentUser.city || selectedCity)}</strong></span>
                </div>
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

        ${showUpdatesLog ? `
        <section class="gridMain single" id="updates-log">
          <div class="card">
            <div class="sectionTitle">
              <div>
                <h2>Release notes</h2>
                <p class="sub">Full running log of dashboard and API updates, newest first.</p>
              </div>
            </div>
            <div class="mini">
              <div class="release-meta" style="margin-bottom:14px;">
                <div class="release-row"><div class="label">App version</div><div class="value">${esc(stats.appVersion)}</div></div>
                <div class="release-row"><div class="label">Most recent update</div><div class="value">${esc(latestRelease.text)}</div></div>
              </div>
              ${releaseLogItems.map((item) => `
                <div class="insight-row" style="padding:12px 0;">
                  <div class="label">${esc(item.date)}</div>
                  <div class="value">${esc(item.text)}</div>
                </div>
              `).join("")}
            </div>
          </div>
        </section>
        ` : ``}

        <!-- Manage -->
        ${(showCreate || showUpload || showExisting) ? `
        <section class="gridMain ${isSingleManage ? "single" : ""}" id="manage">
          ${showCreate ? `
          <div class="card" id="create">
            <div class="sectionTitle">
              <div>
                <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
                  <h2 style="margin:0;">${editEvent ? "Edit event" : "Create event"}</h2>
                  <span class="pill">${esc(selectedCity)}</span>
                </div>
                <p class="sub">This saves to SQLite and powers your API</p>
              </div>
            </div>

            <form method="POST" action="/admin/events" enctype="multipart/form-data">
              ${editEvent ? `<input type="hidden" name="id" value="${esc(editEvent.id)}" />` : ""}
              ${fromPending ? `<input type="hidden" name="pendingId" value="${esc(pendingEvent.id)}" />` : ""}

              <div class="rec-box" style="margin-top:0; border-color:rgba(16,185,129,.35); background:linear-gradient(180deg, rgba(16,185,129,.10), rgba(16,185,129,.04)); box-shadow:0 0 0 1px rgba(16,185,129,.08) inset;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:8px;">
                  <label for="cityHidden" style="margin:0; font-size:18px; font-weight:800; letter-spacing:-0.01em;">Area</label>
                  <span class="pill" style="background:rgba(16,185,129,.14); border-color:rgba(16,185,129,.24); color:#166534;">Choose where this event will publish</span>
                </div>
                <div class="note" style="margin:0 0 10px 0; color:#42526b;">This controls which area site the event is added to.</div>
                <select class="ctrl" name="city" id="cityHidden" required style="font-size:18px; font-weight:700; border-width:2px; border-color:rgba(16,185,129,.28); background:#fff;">
                  ${cityOptions}
                </select>
              </div>
              <input type="hidden" name="eventTypeChoice" id="eventTypeChoice" value="${esc(inferredEventType || "single")}" />

              <input type="hidden" name="startDateTimeISO" id="startDateTimeISO" value="" />
              <input type="hidden" name="endDateTimeISO" id="endDateTimeISO" value="" />

              <div class="event-type-shell is-visible" id="eventTypeShell">

              ${canFeatureEvents ? `
              <div class="rec-box">
                <div class="checkbox">
                  <input type="checkbox" id="featured" name="featured" value="1" ${isFeatured ? "checked" : ""} />
                  <label for="featured" style="margin:0;font-size:12px;font-weight:650;">Featured event</label>
                </div>
                <div class="note">Featured events show a badge on the event card and event page.</div>
                ${canCurateEventPromotions ? `
                <div class="checkbox" style="margin-top:10px;">
                  <input type="checkbox" id="eddiesPick" name="eddiesPick" value="1" ${isEddiesPick ? "checked" : ""} />
                  <label for="eddiesPick" style="margin:0;font-size:12px;font-weight:650;">Eddie's Pick</label>
                </div>
                <div class="note">Shows this event as Eddie's Pick in weekend emails.</div>
                ` : ``}
              </div>
              ` : ""}

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

              ${isOrganizerUser ? `
              <div class="note" style="margin-top:12px;">SEO is generated automatically from your event title, description, location, and organizer details.</div>
              ` : `
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
              `}

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Start</label>
                  <input id="startDateTime" class="ctrl" type="datetime-local" name="startDateTime"
                    value="${esc(displayEventStartLocalValue)}" required />
                </div>
                <div>
                  <label style="margin-top:0;">End</label>
                  <input id="endDateTime" class="ctrl" type="datetime-local" name="endDateTime"
                    value="${esc(displayEventEndLocalValue)}" required />
                </div>
              </div>

              <div class="rec-box multi-day-shell ${inferredEventType === "multi-day" ? "is-visible" : ""}" id="multiDayScheduleShell" style="margin-top:14px;">
                <div style="display:flex; align-items:center; justify-content:space-between; gap:12px; margin-bottom:6px; flex-wrap:wrap;">
                  <div style="font-weight:650;">Daily Schedule</div>
                  <label class="checkbox" style="margin:0; gap:8px; cursor:pointer;" onclick="(function(){var el=document.getElementById('multiDayUseCustomDates');var recurringBtn=document.querySelector('[data-event-type=\"recurring\"]');var hidden=document.getElementById('eventTypeChoice');var recWrap=document.getElementById('recurrenceSettings');var hasRec=document.getElementById('hasRecurrence');var recType=document.getElementById('recurrenceType');var multi=document.getElementById('multiDayScheduleShell');if(el) el.checked=true;if(hidden) hidden.value='recurring';if(recurringBtn&&recurringBtn.click){recurringBtn.click();}if(recWrap) recWrap.style.display='';if(hasRec) hasRec.checked=true;if(recType) recType.value='custom';if(window.ocSyncRecurrenceUI) window.ocSyncRecurrenceUI();if(multi){multi.classList.remove('is-visible');multi.hidden=true;multi.style.display='none';}setTimeout(function(){var box=document.getElementById('customBox');if(box&&box.scrollIntoView) box.scrollIntoView({behavior:'smooth', block:'nearest'});if(el) el.checked=false;},0);return false;})()">
                    <input type="checkbox" id="multiDayUseCustomDates" />
                    <span style="font-size:12px; font-weight:650; color:var(--muted);">Use custom dates instead</span>
                  </label>
                </div>
                <div class="note">For multi-day events, each day in the selected range gets its own row so you can set different hours. The overall Start and End fields above still define the event's first and last day.</div>
                <input type="hidden" name="multiDayScheduleJson" id="multiDayScheduleJson" value='${esc(JSON.stringify(multiDaySchedule || []))}' />
                <div id="multiDayScheduleWrap" style="margin-top:12px;">
                  <div class="multi-day-empty">Choose a multi-day start and end range to build the daily schedule.</div>
                </div>
              </div>

              <!-- Recurring Events -->
              <div class="rec-box recurrence" id="recurrenceSettings">
                <div class="checkbox event-type-managed-rec-toggle">
                  <input type="checkbox" id="hasRecurrence" name="hasRecurrence" value="1" ${hasRecurrence ? "checked" : ""} onchange="window.ocSyncRecurrenceUI && window.ocSyncRecurrenceUI()" />
                  <label for="hasRecurrence" style="margin:0;font-size:12px;font-weight:650;">Recurring event</label>
                </div>
                <div class="note event-type-managed-rec-toggle">Weekly/monthly rule or custom dates list.</div>

                <input type="hidden" name="recurrenceStartDate" value="${esc(recurrenceStartDateVal)}" />
                <input type="hidden" name="recurrenceUntilDate" value="${esc(recurrenceUntilDateVal)}" />
                <div class="note" style="margin-top:12px;">For recurring events, the start date above becomes the first occurrence date and the end date above becomes the repeat-until date. The start and end times repeat for each occurrence.</div>

                <div class="rec-grid" style="margin-top:12px;">
                  <div>
                    <div class="rec-label">Recurrence Type</div>
                    <select id="recurrenceType" name="recurrenceType" class="ctrl" onchange="window.ocSyncRecurrenceUI && window.ocSyncRecurrenceUI()">
                      <option value="none" ${ruleType === "none" ? "selected" : ""}>None</option>
                      <option value="weekly" ${ruleType === "weekly" ? "selected" : ""}>Weekly</option>
                      <option value="monthly" ${ruleType === "monthly" ? "selected" : ""}>Monthly</option>
                      <option value="custom" ${ruleType === "custom" ? "selected" : ""}>Custom Dates</option>
                    </select>
                  </div>

                  <div id="intervalRow" style="${showRecurringOptions ? "" : "display:none;"}">
                    <div class="rec-label">Interval</div>
                    <input class="ctrl" type="number" min="1" name="recurrenceInterval" value="${esc(recurrenceInterval)}" />
                    <div class="rec-help">Example: every 1 week, every 2 weeks, every 1 month, etc.</div>
                  </div>
                </div>

                <div id="weeklyBox" style="margin-top:14px;${showWeeklyOptions ? "" : "display:none;"}">
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

                <div id="monthlyBox" style="margin-top:14px;${showMonthlyOptions ? "" : "display:none;"}">
                  <div class="rec-grid">
                    <div>
                      <div class="rec-label">Monthly Mode</div>
                      <select id="monthlyMode" name="monthlyMode" class="ctrl" onchange="window.ocSyncRecurrenceUI && window.ocSyncRecurrenceUI()">
                        <option value="monthday" ${monthlyMode === "monthday" ? "selected" : ""}>On day of month</option>
                        <option value="nthweekday" ${monthlyMode === "nthweekday" ? "selected" : ""}>On nth weekday</option>
                      </select>
                    </div>
                    <div></div>
                  </div>

                  <div id="monthdayBox" style="margin-top:12px;${showMonthdayOptions ? "" : "display:none;"}">
                    <div class="rec-label">Day of Month (1–31)</div>
                    <input class="ctrl" type="number" min="1" max="31" name="byMonthday" value="${esc(byMonthday)}" />
                  </div>

                  <div id="nthweekdayBox" style="margin-top:12px;${showNthWeekdayOptions ? "" : "display:none;"}">
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

                <div id="customBox" style="margin-top:14px;${showCustomOptions ? "" : "display:none;"}">
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
              <script>
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
                  var addBtn = document.getElementById("addCustomDate");
                  var pruneBtn = document.getElementById("prunePastDates");
                  var wrap = document.getElementById("customDatesWrap");
                  function show(el, on){
                    if (!el) return;
                    el.style.display = on ? "" : "none";
                  }
                  window.ocSyncRecurrenceUI = function(){
                    var enabled = !!(hasRecEl && hasRecEl.checked);
                    var t = typeEl ? String(typeEl.value || "none") : "none";
                    if (!enabled) {
                      show(intervalRow, false);
                      show(weeklyBox, false);
                      show(monthlyBox, false);
                      show(customBox, false);
                      return;
                    }
                    show(intervalRow, t !== "none" && t !== "custom");
                    show(weeklyBox, t === "weekly");
                    show(monthlyBox, t === "monthly");
                    show(customBox, t === "custom");
                    if (t === "monthly") {
                      var mm = monthlyModeEl ? String(monthlyModeEl.value || "monthday") : "monthday";
                      show(monthdayBox, mm === "monthday");
                      show(nthweekdayBox, mm === "nthweekday");
                    } else {
                      show(monthdayBox, false);
                      show(nthweekdayBox, false);
                    }
                  };
                  function attachRemove(){
                    if (!wrap) return;
                    var btns = wrap.querySelectorAll("button[data-remove-date]");
                    for (var i = 0; i < btns.length; i++) {
                      btns[i].onclick = function(){
                        var chip = this.closest ? this.closest(".chip") : null;
                        if (chip) chip.remove();
                      };
                    }
                  }
                  attachRemove();
                  if (addBtn && wrap) {
                    addBtn.addEventListener("click", function(){
                      var chip = document.createElement("span");
                      chip.className = "chip";
                      var startLocal = (document.getElementById("startDateTime") || {}).value || "";
                      var endLocal = (document.getElementById("endDateTime") || {}).value || "";
                      var startTime = startLocal && startLocal.length >= 16 ? startLocal.slice(11,16) : "";
                      var endTime = endLocal && endLocal.length >= 16 ? endLocal.slice(11,16) : startTime;
                      chip.innerHTML =
                        '<input class="ctrl" style="width:160px; padding:8px 10px;" type="date" name="customDate" value="" />' +
                        '<input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customStart" value="" />' +
                        '<input class="ctrl" style="width:120px; padding:8px 10px;" type="time" name="customEnd" value="" />' +
                        '<button type="button" data-remove-date="1" aria-label="Remove">×</button>';
                      wrap.appendChild(chip);
                      var st = chip.querySelector('input[name="customStart"]');
                      var en = chip.querySelector('input[name="customEnd"]');
                      if (st && startTime) st.value = startTime;
                      if (en && endTime) en.value = endTime;
                      attachRemove();
                    });
                  }
                  if (pruneBtn && wrap) {
                    pruneBtn.addEventListener("click", function(){
                      var today = new Date();
                      var todayStr = today.getFullYear() + "-" + String(today.getMonth() + 1).padStart(2, "0") + "-" + String(today.getDate()).padStart(2, "0");
                      var chips = wrap.querySelectorAll(".chip");
                      for (var i = 0; i < chips.length; i++) {
                        var chip = chips[i];
                        var date = (chip.querySelector('input[name="customDate"]') || {}).value || "";
                        if (date && date < todayStr) chip.remove();
                      }
                    });
                  }
                  window.ocSyncRecurrenceUI();
                })();
              </script>
              <label>Flyer Image (Upload)</label>
              <input id="imageFileInput" class="ctrl" type="file" name="imageFile" accept="image/*" />
              <div class="note">${isOrganizerUser ? "Images are automatically formatted after upload." : "Uploading replaces the Image URL below."}</div>

              <img id="uploadPreview" style="margin-top:10px; width:160px; height:160px; object-fit:cover; border-radius:var(--radius); border:1px solid var(--line); display:none;" alt="Flyer upload preview" />

              ${isOrganizerUser ? `` : `
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
              `}

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
              <input class="ctrl" name="organizer" value="${esc(organizerFormValue)}" ${isOrganizerUser ? "readonly" : ""} required />
              ${isOrganizerUser ? `<div class="note">Organizer accounts save events under your organizer identity automatically.</div>` : ``}

              <div class="rec-box" style="margin-top:14px;">
                <div class="checkbox">
                  <input type="checkbox" id="forceDuplicateSave" name="forceDuplicateSave" value="1" />
                  <label for="forceDuplicateSave" style="margin:0;font-size:12px;font-weight:650;">Save anyway if a possible duplicate is found</label>
                </div>
                <div class="note">Use this only when you are sure it is a separate event and not an accidental duplicate.</div>
              </div>

              <div class="actions">
                <button type="submit" class="btn btn-primary">${editEvent ? "Update Event" : "Save Event"}</button>
              ${editEvent ? `<a class="btn btn-link" href="/admin/existing-events?pg=${pg}&limit=${limit}${q ? `&q=${encodeURIComponent(q)}` : ""}${statusMode ? `&status=${encodeURIComponent(statusMode)}` : ""}${recurringOnly ? `&recurring=1` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}">Cancel</a>` : ""}
                <span class="note">Dates are saved in Pacific time automatically.</span>
              </div>
              </div>
            </form>
          </div>
          ` : ``}

          ${showUpload ? `
          <div class="card" id="upload-events">
            <div class="sectionTitle">
              <div>
                <h2>Upload events</h2>
                <p class="sub">Bulk import events from CSV with optional ZIP image matching.</p>
              </div>
              <div class="right">
                <a class="btn" href="/assets/templates/event-import-template.csv" download>Download Template</a>
                <span class="pill">/${esc(selectedCity.toLowerCase())}</span>
              </div>
            </div>
            ${(req.query.bulkImported || req.query.bulkSkipped || req.query.bulkErrors) ? `
              <div class="mini" style="margin-bottom:12px;">
                <div><strong>Imported:</strong> ${esc(req.query.bulkImported || "0")}</div>
                <div><strong>Skipped:</strong> ${esc(req.query.bulkSkipped || "0")}</div>
                <div><strong>Errors:</strong> ${esc(req.query.bulkErrors || "0")}</div>
                ${req.query.bulkNotice ? `<div class="note" style="margin-top:8px;">${esc(req.query.bulkNotice)}</div>` : ``}
              </div>
            ` : ``}
            <form method="POST" action="/admin/events/bulk-import" enctype="multipart/form-data">
              <input type="hidden" name="city" value="${esc(formCity)}" />
              <label>CSV File</label>
              <input class="ctrl" type="file" name="eventsCsv" accept=".csv,text/csv" required />
              <label style="margin-top:10px;">Image ZIP (optional)</label>
              <input class="ctrl" type="file" name="imageZip" accept=".zip,application/zip" />
              <div class="note">If you upload a ZIP, add an <strong style="color:var(--text);">imageFile</strong>, <strong style="color:var(--text);">imageFilename</strong>, or <strong style="color:var(--text);">image</strong> column in the CSV that matches each image filename inside the ZIP.</div>
              <div class="note">Supported columns matching the form: featured, eddiesPick, category1, category2, category3, title, description, eventDetails, goodToKnow, seoTitle, metaDescription, focusKeyphrase, imageAlt, startDateTime, endDateTime, hasRecurrence, recurrenceStartDate, recurrenceUntilDate, recurrenceType, recurrenceInterval, weeklyByDay, monthlyMode, byMonthday, setPos, monthlyByDay, customDate, customStart, customEnd, imageUrl, imageFile, imageFilename, ticketLabel, ticketUrl, location, organizer, city.</div>
              <div class="note">Date/time values should be full date-times like <strong style="color:var(--text);">2026-04-15 18:00</strong> or ISO timestamps.</div>
              <div class="note">For recurring imports: use <strong style="color:var(--text);">recurrenceType</strong> as <strong style="color:var(--text);">weekly</strong>, <strong style="color:var(--text);">monthly</strong>, or <strong style="color:var(--text);">custom</strong>. Use pipe-separated values like <strong style="color:var(--text);">MO|WE|FR</strong> for weekly days, and for custom dates use matching pipe-separated <strong style="color:var(--text);">customDate</strong>, <strong style="color:var(--text);">customStart</strong>, and <strong style="color:var(--text);">customEnd</strong> values.</div>
              <div class="actions" style="margin-top:12px;">
                <button type="submit" class="btn btn-primary">Import CSV</button>
              </div>
            </form>
            ${(bulkImportedRows.length || bulkSkippedItems.length || bulkErrorItems.length) ? `
            <div class="card" style="margin-top:14px; padding:16px;">
              <div class="sectionTitle" style="margin-bottom:8px;">
                <div>
                  <h2 style="font-size:18px;">Upload review</h2>
                  <p class="sub">What was added or skipped in the most recent upload.</p>
                </div>
              </div>
              ${bulkImportedRows.length ? `
                <div class="mini" style="margin-bottom:12px;">
                  <div style="font-weight:700; color:var(--text); margin-bottom:8px;">Imported events</div>
                  ${bulkImportedRows.map((event) => `
                    <div class="kv">
                      <span class="k">#${Number(event.id || 0)} - ${esc(event.title || "Event")}</span>
                      <strong class="v">${esc(fmtPendingDate(event.startDateTime))}</strong>
                    </div>
                    <div class="note" style="margin:-4px 0 8px 0;">${esc(event.location || "")}${event.organizer ? ` · ${esc(event.organizer)}` : ""}</div>
                  `).join("")}
                </div>
              ` : ``}
              ${bulkSkippedItems.length ? `
                <div class="mini" style="margin-bottom:12px;">
                  <div style="font-weight:700; color:var(--text); margin-bottom:8px;">Skipped rows</div>
                  ${bulkSkippedItems.map((item) => `<div class="note" style="margin-bottom:6px;">${esc(item)}</div>`).join("")}
                </div>
              ` : ``}
              ${bulkErrorItems.length ? `
                <div class="mini">
                  <div style="font-weight:700; color:var(--text); margin-bottom:8px;">Errors</div>
                  ${bulkErrorItems.map((item) => `<div class="note" style="margin-bottom:6px;">${esc(item)}</div>`).join("")}
                </div>
              ` : ``}
            </div>
            ` : ``}
          </div>
          ` : ``}

          ${showExisting ? `
	          <div class="card" id="existing">
	            <div class="sectionTitle">
	              <div>
	                <h2>${isOrganizerUser ? "My events" : "All events"}</h2>
	                <p class="sub">${isOrganizerUser ? "Manage and review your organizer events" : "Edit, delete, and check stats"}</p>
	              </div>
                <div class="right">
                  <a class="btn btn-primary" href="/admin/create-events${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Event</a>
                </div>
	            </div>

	            <div class="eventsFilters">
	              <div class="eventsFilterTabs">
	                <a class="btn ${statusMode === "upcoming" ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}&sort=${encodeURIComponent(sort)}&status=upcoming${recurringOnly ? `&recurring=1` : ``}">Upcoming</a>
	                <a class="btn ${statusMode === "past" ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}&sort=${encodeURIComponent(sort)}&status=past${recurringOnly ? `&recurring=1` : ``}">Past</a>
	                <a class="btn ${statusMode === "archived" ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}&sort=${encodeURIComponent(sort)}&status=archived${recurringOnly ? `&recurring=1` : ``}">Archived</a>
	                <a class="btn btn-wide ${recurringOnly ? "btn-primary" : ""}" href="/admin/existing-events?pg=1&limit=${esc(String(limit))}${q ? `&q=${encodeURIComponent(q)}` : ""}${fromDate ? `&from=${encodeURIComponent(fromDate)}` : ""}${toDate ? `&to=${encodeURIComponent(toDate)}` : ""}&sort=${encodeURIComponent(sort)}&status=${encodeURIComponent(statusMode)}${recurringOnly ? `` : `&recurring=1`}">${recurringOnly ? "Recurring On" : "Recurring Only"}</a>
	              </div>
                <form class="listSearchRow" method="GET" action="/admin/existing-events">
                  <input type="hidden" name="pg" value="1" />
                  <input type="hidden" name="limit" value="${esc(String(limit))}" />
                  <input type="hidden" name="status" value="${esc(String(statusMode))}" />
                  ${recurringOnly ? `<input type="hidden" name="recurring" value="1" />` : ``}
                  ${selectedCity ? `<input type="hidden" name="city" value="${esc(selectedCity)}" />` : ``}
	                <div class="filterField">
	                  <label for="eventSearch">Search</label>
	                  <input id="eventSearch" name="q" class="ctrl" type="text" placeholder="Search title, slug, location, or ID" value="${esc(q)}" />
	                </div>
	                <div class="filterField">
	                  <label for="sortBy">Sort by</label>
	                  <select id="sortBy" name="sort" class="ctrl sortBy">
	                    <option value="datetime" ${sort === "datetime" ? "selected" : ""}>Event date/time</option>
	                    <option value="alpha" ${sort === "alpha" ? "selected" : ""}>Alphabetical (A-Z)</option>
	                    <option value="recent" ${sort === "recent" ? "selected" : ""}>Recently added</option>
	                    <option value="id" ${sort === "id" ? "selected" : ""}>Newest ID first</option>
	                  </select>
	                </div>
	                <div class="filterField">
	                  <label for="eventDateFrom">Date range</label>
	                  <div class="dateRange">
	                    <input id="eventDateFrom" name="from" class="ctrl dateCtrl" type="date" value="${esc(fromDate)}" />
	                    <span class="dateRangeSep">to</span>
	                    <input id="eventDateTo" name="to" class="ctrl dateCtrl" type="date" value="${esc(toDate)}" />
	                  </div>
	                </div>
	                <div class="filterActions">
	                  <button id="eventSearchApply" type="submit" class="btn btn-primary">Apply</button>
	                  <button id="eventSearchClear" type="button" class="btn">Reset</button>
	                </div>
                </form>
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
              <div class="right">
                <a class="btn btn-primary" href="/admin/venues/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Venue</a>
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
		                        <div class="chartTitle" style="font-weight:700;">${esc(selectedVenue.name || `Venue #${selectedVenue.id}`)} monthly performance</div>
		                        <p class="sub" id="venueChartRangeLabel">Last 12 months</p>
		                        <div class="chartLegend" id="venueChartLegend" aria-label="Chart legend">
		                          <div class="chartLegendItem is-events" data-legend-metric="views">
		                            <span class="chartLegendLine"></span>
		                            <span>Views</span>
		                          </div>
		                          <div class="chartLegendItem is-views" data-legend-metric="clicks">
		                            <span class="chartLegendLine is-dashed"></span>
		                            <span>Total Clicks</span>
		                          </div>
		                        </div>
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
		                      <div id="venueChartSvgHost" data-active-metric="views">${venueChartSvgViews}</div>
		                      <div id="venueChartSvgViews" hidden>${venueChartSvgViews}</div>
		                      <div id="venueChartSvgClicks" hidden>${venueChartSvgClicks}</div>
		                      <canvas id="venueChart" style="position:absolute; inset:0; width:100%; height:260px; display:block;"></canvas>
		                      <div id="venueChartTip" style="position:absolute; display:none; pointer-events:none; padding:6px 8px; border-radius:6px; border:1px solid rgba(148,163,184,.35); background:rgba(255,255,255,.98); color:rgba(15,23,42,.95); font-size:12px; line-height:1.2; box-shadow:none;"></div>
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
                  <label style="margin-top:0;">Hiring Type</label>
                  <div class="card" style="padding:14px;">
                    <div class="note" style="margin-bottom:8px;">Select one or both if the same posting covers multiple schedules.</div>
                    ${JOB_EMPLOYMENT_TYPE_OPTIONS.map((type) => `
                      <label style="display:flex; align-items:center; gap:8px; margin:8px 0 0; font-weight:600; color:var(--text);">
                        <input type="checkbox" name="employmentTypes" value="${esc(type)}" ${editJobEmploymentTypes.includes(type) ? "checked" : ""} />
                        <span>${esc(type)}</span>
                      </label>
                    `).join("")}
                  </div>
                </div>
                <div>
                  <label style="margin-top:0;">Application Method</label>
                  <select class="ctrl" name="applicationMode">
                    <option value="external" ${editJobApplicationMode === "external" ? "selected" : ""}>External URL only</option>
                    <option value="website" ${editJobApplicationMode === "website" ? "selected" : ""}>Website form only</option>
                    <option value="both" ${editJobApplicationMode === "both" ? "selected" : ""}>Both website form and external URL</option>
                  </select>
                  <div class="note">Choose whether applications happen on your website, off-site, or both.</div>
                </div>
              </div>

              <div class="rec-grid" style="margin-top:10px;">
                <div>
                  <label style="margin-top:0;">Salary / Pay Range</label>
                  <input class="ctrl" name="salaryRange" value="${esc(editJob?.salaryRange || "")}" placeholder="$20/hr · $45k-$60k" />
                </div>
              </div>

              <label>Apply URL</label>
              <input class="ctrl" name="applyUrl" value="${esc(editJob?.applyUrl || "")}" placeholder="https://..." />
              <div class="note">Only required when the job uses an external apply link.</div>

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

              <div class="card" style="margin-top:14px; padding:16px;">
                <div class="sectionTitle" style="margin-bottom:8px;">
                  <div>
                    <h2 style="font-size:18px;">SEO</h2>
                    <p class="sub">Optional overrides for search and social previews.</p>
                  </div>
                </div>
                <label>SEO Title</label>
                <input class="ctrl" name="seoTitle" value="${esc(editJob?.seoTitle || "")}" />
                <div class="note">Recommended ~50-60 characters.</div>

                <label>Meta Description</label>
                <textarea class="ctrl" name="metaDescription" rows="3">${esc(editJob?.metaDescription || "")}</textarea>
                <div class="note">Recommended ~140-160 characters.</div>

                <div class="rec-grid" style="margin-top:10px;">
                  <div>
                    <label style="margin-top:0;">Focus Keyphrase</label>
                    <input class="ctrl" name="focusKeyphrase" value="${esc(editJob?.focusKeyphrase || "")}" />
                  </div>
                  <div>
                    <label style="margin-top:0;">Image Alt Text</label>
                    <input class="ctrl" name="imageAlt" value="${esc(editJob?.imageAlt || "")}" />
                  </div>
                </div>
              </div>

              <div class="card" style="margin-top:14px; padding:16px;">
                <div class="sectionTitle" style="margin-bottom:8px;">
                  <div>
                    <h2 style="font-size:18px;">Website application fields</h2>
                    <p class="sub">Choose which fields are shown if this job accepts applications on your website.</p>
                  </div>
                </div>
                <div class="rec-grid">
                  ${JOB_APPLICATION_FIELDS.map((field) => `
                    <div>
                      <label style="margin-top:0;">${esc(field.label)}</label>
                      <select class="ctrl" name="applicationField_${esc(field.key)}">
                        <option value="off" ${editJobApplicationFields[field.key] === "off" ? "selected" : ""}>Off</option>
                        <option value="optional" ${editJobApplicationFields[field.key] === "optional" ? "selected" : ""}>Optional</option>
                        <option value="required" ${editJobApplicationFields[field.key] === "required" ? "selected" : ""}>Required</option>
                      </select>
                    </div>
                  `).join("")}
                </div>
              </div>

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
              <div class="right">
                <a class="btn btn-primary" href="/admin/jobs/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Job</a>
                <a class="btn" href="/jobs${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}" target="_blank" rel="noopener">View JSON</a>
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
                        <div><strong>Type:</strong> ${esc(formatEmploymentTypeDisplay(safeParseJson(j.employmentTypesJson, null), j.employmentType || ""))}</div>
                        <div><strong>Apply method:</strong> ${esc(j.applicationMode || "external")}</div>
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
                ${(() => {
                  const submitted = safeParseJson(a.fieldsJson, null);
                  const submittedSummary = submitted && typeof submitted === "object"
                    ? Object.entries(submitted)
                        .filter(([, value]) => value !== "" && value !== false && value !== null && value !== undefined)
                        .map(([key]) => JOB_APPLICATION_FIELDS.find((field) => field.key === key)?.label || key)
                        .join(", ")
                    : "";
                  return `
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
                        ${submittedSummary ? `<div><strong>Submitted fields:</strong> ${esc(submittedSummary)}</div>` : ``}
                        ${a.coverLetter ? `<div><strong>Cover letter:</strong> ${esc(String(a.coverLetter).slice(0, 180))}${String(a.coverLetter).length > 180 ? "..." : ""}</div>` : ``}
                        ${a.resumeUrl ? `<div><strong>Resume:</strong> <a href="${esc(a.resumeUrl)}" target="_blank" rel="noopener">View</a></div>` : ``}
                      </div>
                    </div>
                  </div>
                </div>
              `;
                })()}
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
                  <div class="mini" style="display:grid; gap:10px;">
                    ${(() => {
                      const selectedPlacements = normalizeAdPlacements(editAd?.placements || editAd?.placementsJson, editAd?.placement || "homepage-top");
                      const options = [...selectedPlacements.filter((placement) => !adPlacementOptions.includes(placement)), ...adPlacementOptions];
                      return options.map((placement) => `
                        <label class="checkbox" style="padding:0;">
                          <input type="checkbox" name="placements" value="${esc(placement)}" ${selectedPlacements.includes(placement) ? "checked" : ""} />
                          <span>${esc(adPlacementOptions.includes(placement) ? placement : `${placement} (existing custom)`)}</span>
                        </label>
                      `).join("");
                    })()}
                  </div>
                  <div class="note">Select one or more placement keys used by the website and plugin.</div>
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
              <div class="right">
                <a class="btn btn-primary" href="/admin/ads/create${selectedCity ? `?city=${encodeURIComponent(selectedCity)}` : ""}">Create Ad</a>
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
                        <div><strong>Placements:</strong> ${esc((ad.placements || []).join(", ") || ad.placement || "default")}</div>
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
                          ${esc(ad.name || `Ad #${ad.id}`)} · ${esc((ad.placements || []).join(", ") || ad.placement || "default")}
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
                    <div class="kv"><span class="k">Placements</span><strong class="v">${esc((selectedAd.placements || []).join(", ") || selectedAd.placement || "default")}</strong></div>
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
                      <div class="chartTitle" style="font-weight:700;">${esc(selectedAd.name || `Ad #${selectedAd.id}`)} monthly performance</div>
                      <p class="sub" id="adChartRangeLabel">Last 12 months</p>
                      <div class="chartLegend" id="adChartLegend" aria-label="Chart legend">
                        <div class="chartLegendItem is-events" data-legend-metric="views">
                          <span class="chartLegendLine"></span>
                          <span>Views</span>
                        </div>
                        <div class="chartLegendItem is-views" data-legend-metric="clicks">
                          <span class="chartLegendLine is-dashed"></span>
                          <span>Clicks</span>
                        </div>
                      </div>
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
                    <div id="adChartSvgHost" data-active-metric="views">${adChartSvgViews}</div>
                    <div id="adChartSvgViews" hidden>${adChartSvgViews}</div>
                    <div id="adChartSvgClicks" hidden>${adChartSvgClicks}</div>
                    <canvas id="adChart" style="position:absolute; inset:0; width:100%; height:260px; display:block;"></canvas>
                    <div id="adChartTip" style="position:absolute; display:none; pointer-events:none; padding:6px 8px; border-radius:6px; border:1px solid rgba(148,163,184,.35); background:rgba(255,255,255,.98); color:rgba(15,23,42,.95); font-size:12px; line-height:1.2; box-shadow:none;"></div>
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
        var body = document.body;
        var toggle = document.getElementById("mobileSidebarToggle");
        var backdrop = document.getElementById("sidebarBackdrop");
        var sidebar = document.getElementById("adminSidebar");
        if (!body || !toggle || !backdrop || !sidebar) return;

        function sync(open){
          body.classList.toggle("sidebar-open", !!open);
          toggle.setAttribute("aria-expanded", open ? "true" : "false");
        }

        toggle.addEventListener("click", function(){
          sync(!body.classList.contains("sidebar-open"));
        });
        backdrop.addEventListener("click", function(){
          sync(false);
        });
        sidebar.addEventListener("click", function(e){
          if (window.innerWidth > 1100) return;
          var link = e.target.closest("a");
          if (link) sync(false);
        });
        window.addEventListener("resize", function(){
          if (window.innerWidth > 1100) sync(false);
        });
        document.addEventListener("keydown", function(e){
          if (e.key === "Escape") sync(false);
        });
      })();

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
          if (card.tagName === 'DETAILS') {
            var sync = function(){
              btn.setAttribute('aria-expanded', card.open ? 'true' : 'false');
            };
            card.addEventListener('toggle', sync);
            sync();
            return;
          }
          btn.addEventListener('click', function(){
            var collapsed = card.getAttribute('data-collapsed') === 'true';
            card.setAttribute('data-collapsed', collapsed ? 'false' : 'true');
            btn.setAttribute('aria-expanded', collapsed ? 'true' : 'false');
          });
        });
      })();

      // ---- dashboard insights switcher ----
      (function(){
        var switcher = document.getElementById('dashboardInsightsSwitcher');
        if (!switcher) return;
        var buttons = Array.prototype.slice.call(switcher.querySelectorAll('[data-insight-target]'));
        var panels = Array.prototype.slice.call(document.querySelectorAll('[data-insight-panel]'));
        function activate(target){
          buttons.forEach(function(btn){
            btn.classList.toggle('is-active', btn.getAttribute('data-insight-target') === target);
          });
          panels.forEach(function(panel){
            panel.classList.toggle('is-active', panel.getAttribute('data-insight-panel') === target);
          });
        }
        window.ocDashboardInsightActivate = activate;
        buttons.forEach(function(btn){
          btn.addEventListener('click', function(){
            activate(btn.getAttribute('data-insight-target'));
          });
        });
      })();

      // ---- pagination scroll restore ----
      (function(){
        var storageKey = 'oc_pagination_scroll_restore';
        try {
          var raw = sessionStorage.getItem(storageKey);
          if (raw) {
            var saved = JSON.parse(raw);
            var samePath = saved && saved.path === window.location.pathname;
            var fresh = saved && typeof saved.ts === 'number' && (Date.now() - saved.ts) < 10000;
            if (samePath && fresh && typeof saved.y === 'number') {
              requestAnimationFrame(function(){
                window.scrollTo({ top: Math.max(0, saved.y), left: 0, behavior: 'auto' });
              });
            }
            sessionStorage.removeItem(storageKey);
          }
        } catch (_) {}

        document.addEventListener('click', function(e){
          var link = e.target.closest('.pager a[href], .dashboard-calendar-pager a[href], .dashboard-calendar-month-row a[href], .dashboard-calendar-grid a[href], .dashboard-calendar-scope-toggle a[href]');
          if (!link) return;
          var href = String(link.getAttribute('href') || '');
          if (!href || href.charAt(0) === '#') return;
          try {
            sessionStorage.setItem(storageKey, JSON.stringify({
              path: window.location.pathname,
              y: window.scrollY || window.pageYOffset || 0,
              ts: Date.now(),
            }));
          } catch (_) {}
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

        form.addEventListener("submit", function(ev){
          var eventTypeChoice = String(((document.getElementById("eventTypeChoice") || {}).value) || "").trim();
          if (!eventTypeChoice) {
            ev.preventDefault();
            return;
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

          var multiDayHidden = document.getElementById("multiDayScheduleJson");
          var multiDayWrap = document.getElementById("multiDayScheduleWrap");
          if (multiDayHidden && multiDayWrap) {
            var dayRows = multiDayWrap.querySelectorAll("[data-multi-day-row]");
            var dayItems = [];
            for (var j = 0; j < dayRows.length; j++) {
              var row = dayRows[j];
              var date = String(row.getAttribute("data-date") || "").trim();
              var dayStart = (row.querySelector('input[name="multiDayStart"]') || {}).value || "";
              var dayEnd = (row.querySelector('input[name="multiDayEnd"]') || {}).value || "";
              if (!date || !dayStart || !dayEnd) continue;
              dayItems.push({ date: date, startTime: dayStart, endTime: dayEnd });
            }
            multiDayHidden.value = JSON.stringify(dayItems);
          }

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

      // Event type chooser controls the create-event experience
      (function(){
        var picker = document.getElementById("eventTypePicker");
        var shell = document.getElementById("eventTypeShell");
        var hidden = document.getElementById("eventTypeChoice");
        if (!picker || !shell || !hidden) return;

        var buttons = Array.prototype.slice.call(picker.querySelectorAll("[data-event-type]"));
        if (!buttons.length) return;

        var hasRecEl = document.getElementById("hasRecurrence");
        var typeEl = document.getElementById("recurrenceType");
        var recurrenceSettings = document.getElementById("recurrenceSettings");
        var multiDayShell = document.getElementById("multiDayScheduleShell");
        var lastRecurringType = typeEl && typeEl.value && typeEl.value !== "none" ? String(typeEl.value) : "weekly";

        function emitChange(el){
          if (!el) return;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }

        function setSelection(nextType){
          var selected = String(nextType || "").trim().toLowerCase();
          hidden.value = selected;
          emitChange(hidden);
          shell.classList.toggle("is-visible", !!selected);
          shell.hidden = !selected;
          shell.style.display = selected ? "block" : "none";
          if (recurrenceSettings) recurrenceSettings.style.display = selected === "recurring" ? "" : "none";
          if (multiDayShell) {
            multiDayShell.classList.toggle("is-visible", selected === "multi-day");
            multiDayShell.hidden = selected !== "multi-day";
            multiDayShell.style.display = selected === "multi-day" ? "block" : "none";
          }
          buttons.forEach(function(btn){
            btn.classList.toggle("is-active", (btn.getAttribute("data-event-type") || "") === selected);
          });

          if (hasRecEl) {
            if (selected === "recurring") {
              hasRecEl.checked = true;
              if (typeEl) {
                if (!typeEl.value || typeEl.value === "none") {
                  typeEl.value = lastRecurringType || "weekly";
                }
                lastRecurringType = String(typeEl.value || lastRecurringType || "weekly");
              }
            } else {
              hasRecEl.checked = false;
              if (typeEl && typeEl.value && typeEl.value !== "none") {
                lastRecurringType = String(typeEl.value);
              }
            }
            emitChange(hasRecEl);
          }
          emitChange(typeEl);
        }

        buttons.forEach(function(btn){
          btn.addEventListener("click", function(){
            setSelection(btn.getAttribute("data-event-type") || "");
          });
        });

        if (typeEl) {
          typeEl.addEventListener("change", function(){
            if (typeEl.value && typeEl.value !== "none") {
              lastRecurringType = String(typeEl.value);
            }
          });
        }

        setSelection(hidden.value || "");
      })();

      // Multi-day per-day schedule editor
      (function(){
        var wrap = document.getElementById("multiDayScheduleWrap");
        var hidden = document.getElementById("multiDayScheduleJson");
        var startEl = document.getElementById("startDateTime");
        var endEl = document.getElementById("endDateTime");
        var typeChoice = document.getElementById("eventTypeChoice");
        var shell = document.getElementById("multiDayScheduleShell");
        if (!wrap || !hidden || !startEl || !endEl || !typeChoice) return;

        function parseLocalDateTime(value){
          var s = String(value || "").trim();
          var m = s.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/);
          if (m) {
            return {
              year: Number(m[1]),
              month: Number(m[2]),
              day: Number(m[3]),
              hour: Number(m[4]),
              minute: Number(m[5]),
              second: Number(m[6] || 0),
            };
          }
          m = s.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
          if (m) {
            return {
              year: Number(m[1]),
              month: Number(m[2]),
              day: Number(m[3]),
              hour: Number(m[4]),
              minute: Number(m[5]),
              second: Number(m[6] || 0),
            };
          }
          m = s.match(/^(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{1,2}):(\d{2})\s*([AP]M)$/i);
          if (m) {
            var hour12 = Number(m[4]) % 12;
            var meridiem = String(m[6] || "").toUpperCase();
            return {
              year: Number(m[3]),
              month: Number(m[1]),
              day: Number(m[2]),
              hour: meridiem === "PM" ? hour12 + 12 : hour12,
              minute: Number(m[5]),
              second: 0,
            };
          }
          return null;
        }
        function pad(n){ return String(n).padStart(2, "0"); }
        function toDateKey(parts){ return parts.year + "-" + pad(parts.month) + "-" + pad(parts.day); }
        function toTimeValue(parts){ return pad(parts.hour) + ":" + pad(parts.minute); }
        function formatDateLabel(dateKey){
          var d = new Date(dateKey + "T12:00:00");
          if (isNaN(d.getTime())) return dateKey;
          return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
        }
        function toInputDateValue(dateKey){
          var d = new Date(dateKey + "T12:00:00");
          if (isNaN(d.getTime())) return "";
          return pad(d.getMonth() + 1) + "/" + pad(d.getDate()) + "/" + d.getFullYear();
        }
        function enumerateDates(startKey, endKey){
          var out = [];
          var cur = new Date(startKey + "T12:00:00");
          var end = new Date(endKey + "T12:00:00");
          if (isNaN(cur.getTime()) || isNaN(end.getTime()) || cur > end) return out;
          while (cur <= end) {
            out.push(cur.getFullYear() + "-" + pad(cur.getMonth() + 1) + "-" + pad(cur.getDate()));
            cur.setDate(cur.getDate() + 1);
          }
          return out;
        }
        function parseExisting(){
          try {
            var parsed = JSON.parse(hidden.value || "[]");
            if (!Array.isArray(parsed)) return {};
            var out = {};
            parsed.forEach(function(item){
              var date = String((item && item.date) || "").trim();
              var startTime = String((item && item.startTime) || "").trim();
              var endTime = String((item && item.endTime) || "").trim();
              if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
              if (!/^\d{2}:\d{2}$/.test(startTime)) return;
              if (!/^\d{2}:\d{2}$/.test(endTime)) return;
              out[date] = { startTime: startTime, endTime: endTime };
            });
            return out;
          } catch (_) {
            return {};
          }
        }
        function readCurrentRows(){
          var out = {};
          var rows = wrap.querySelectorAll("[data-multi-day-row]");
          for (var i = 0; i < rows.length; i++) {
            var row = rows[i];
            var date = String(row.getAttribute("data-date") || "").trim();
            var startInput = row.querySelector('input[name="multiDayStart"]');
            var endInput = row.querySelector('input[name="multiDayEnd"]');
            var startTime = startInput && startInput.value ? String(startInput.value).trim() : "";
            var endTime = endInput && endInput.value ? String(endInput.value).trim() : "";
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
            if (!/^\d{2}:\d{2}$/.test(startTime)) continue;
            if (!/^\d{2}:\d{2}$/.test(endTime)) continue;
            out[date] = { startTime: startTime, endTime: endTime };
          }
          return out;
        }
        function isMultiDaySelected(){
          var selected = String(typeChoice.value || "").trim().toLowerCase();
          return selected === "multi-day";
        }
        function render(){
          if (!isMultiDaySelected()) return;
          var startParts = parseLocalDateTime(startEl.value);
          var endParts = parseLocalDateTime(endEl.value);
          if (!startParts || !endParts) {
            wrap.innerHTML = '<div class="multi-day-empty">Choose a multi-day start and end range to build the daily schedule.</div>';
            return;
          }
          var startKey = toDateKey(startParts);
          var endKey = toDateKey(endParts);
          var dateKeys = enumerateDates(startKey, endKey);
          if (!dateKeys.length || (dateKeys.length === 1 && startKey === endKey)) {
            wrap.innerHTML = '<div class="multi-day-empty">Choose a start and end date on different days to add one row per day.</div>';
            return;
          }
          var existing = parseExisting();
          var draft = readCurrentRows();
          var defaultStart = toTimeValue(startParts);
          var defaultEnd = toTimeValue(endParts);
          wrap.innerHTML = '<div class="multi-day-list">' + dateKeys.map(function(dateKey){
            var saved = draft[dateKey] || existing[dateKey] || {};
            var startVal = saved.startTime || defaultStart;
            var endVal = saved.endTime || defaultEnd;
            return '' +
              '<div class="multi-day-row" data-multi-day-row="1" data-date="' + dateKey + '">' +
                '<div>' +
                  '<div class="multi-day-date-label">' + formatDateLabel(dateKey) + '</div>' +
                  '<input class="ctrl multi-day-date-input" type="text" value="' + toInputDateValue(dateKey) + '" readonly />' +
                '</div>' +
                '<div><label style="margin-top:0;">Start time</label><input class="ctrl" type="time" name="multiDayStart" value="' + startVal + '" /></div>' +
                '<div><label style="margin-top:0;">End time</label><input class="ctrl" type="time" name="multiDayEnd" value="' + endVal + '" /></div>' +
              '</div>';
          }).join("") + '</div>';
        }

        startEl.addEventListener("change", render);
        endEl.addEventListener("change", render);
        typeChoice.addEventListener("change", render);
        render();
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
        var scrollStorageKey = "oc_admin_scroll_state";
        function storeScrollForTarget(targetPath){
          try {
            sessionStorage.setItem(scrollStorageKey, JSON.stringify({
              path: String(targetPath || window.location.pathname || ""),
              y: window.scrollY || window.pageYOffset || 0,
              ts: Date.now(),
            }));
            sessionStorage.setItem("oc_admin_scroll", String(window.scrollY || 0));
          } catch (_) {}
        }

        document.addEventListener("click", function(ev){
          var link = ev.target && ev.target.closest ? ev.target.closest('a[href]') : null;
          if (link) {
            var href = String(link.getAttribute("href") || "").trim();
            if (href && href.charAt(0) !== "#" && !/^javascript:/i.test(href) && String(link.getAttribute("target") || "").toLowerCase() !== "_blank") {
              try {
                var url = new URL(href, window.location.origin);
                if (url.origin === window.location.origin && url.pathname.indexOf("/admin") === 0) {
                  storeScrollForTarget(url.pathname);
                }
              } catch (_) {}
            }
          }

          var submitter = ev.target && ev.target.closest ? ev.target.closest('button[type="submit"], input[type="submit"]') : null;
          if (submitter && submitter.form) {
            var action = String(submitter.form.getAttribute("action") || window.location.pathname || "").trim();
            try {
              var submitUrl = new URL(action || window.location.pathname, window.location.origin);
              storeScrollForTarget(submitUrl.pathname);
            } catch (_) {
              storeScrollForTarget(window.location.pathname);
            }
          }
        }, true);

        document.addEventListener("submit", function(ev){
          var formEl = ev.target;
          if (!formEl || !formEl.getAttribute) return;
          var action = String(formEl.getAttribute("action") || window.location.pathname || "").trim();
          try {
            var actionUrl = new URL(action || window.location.pathname, window.location.origin);
            if (actionUrl.origin === window.location.origin && actionUrl.pathname.indexOf("/admin") === 0) {
              storeScrollForTarget(actionUrl.pathname);
            }
          } catch (_) {
            storeScrollForTarget(window.location.pathname);
          }
        }, true);

        document.addEventListener("change", function(ev){
          var el = ev.target;
          if (!el || !el.matches) return;
          if (!el.matches('select, input[type="checkbox"], input[type="radio"]')) return;
          storeScrollForTarget(window.location.pathname);
        }, true);

        var form = document.querySelector('.listSearchRow[action="/admin/existing-events"], form.listSearchRow[action="/admin/existing-events"]');
        var input = document.getElementById('eventSearch');
        var fromInput = document.getElementById('eventDateFrom');
        var toInput = document.getElementById('eventDateTo');
        var sortInput = document.getElementById('sortBy');
        var applyBtn = document.getElementById('eventSearchApply');
        var clearBtn = document.getElementById('eventSearchClear');
        if(!input) return;

        function go(){
          try {
            sessionStorage.setItem("oc_admin_scroll", String(window.scrollY || 0));
          } catch (_) {}
          if (form) {
            form.submit();
            return;
          }
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
        if(sortInput){
          sortInput.addEventListener('change', function(){
            go();
          });
        }
        if(clearBtn){
          clearBtn.addEventListener('click', function(){
            input.value = '';
            if (fromInput) fromInput.value = '';
            if (toInput) toInput.value = '';
            if (sortInput) sortInput.value = 'datetime';
            go();
          });
        }
      })();

      // Restore scroll position after actions
      (function(){
        try {
          var restored = false;
          var rawState = sessionStorage.getItem("oc_admin_scroll_state");
          if (rawState) {
            sessionStorage.removeItem("oc_admin_scroll_state");
            var state = JSON.parse(rawState);
            var path = String((state && state.path) || "");
            var age = Number((state && state.ts) || 0);
            var yPos = parseInt(String((state && state.y) || "0"), 10);
            if (path === window.location.pathname && !isNaN(yPos) && yPos > 0 && age && (Date.now() - age) < 120000) {
              restored = true;
              window.scrollTo({ top: yPos, left: 0, behavior: "auto" });
            }
          }
          if (!restored) {
            var y = sessionStorage.getItem("oc_admin_scroll");
            if (y !== null) {
              sessionStorage.removeItem("oc_admin_scroll");
              var n = parseInt(y, 10);
              if (!isNaN(n) && n > 0) window.scrollTo({ top: n, left: 0, behavior: "auto" });
            }
          } else {
            sessionStorage.removeItem("oc_admin_scroll");
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

      // Simple line charts (no libraries) + hover tooltip + view toggles
(function(){
  function getChartFrame(width, height){
    const padL = 56, padR = 18, padT = 18, padB = 46;
    return {
      padL, padR, padT, padB,
      gw: width - padL - padR,
      gh: height - padT - padB,
    };
  }

  function getYScale(values){
    const maxV = Math.max(1, ...(values || [0]));
    const yTicks = Math.min(6, maxV);
    const tickStep = Math.max(1, Math.ceil(maxV / yTicks));
    return { yTicks, tickStep, yMax: tickStep * yTicks };
  }

  function clamp(value, min, max){
    return Math.min(max, Math.max(min, value));
  }

  function getLinePoints(frame, values){
    const n = values.length;
    if (!n) return [];
    const step = n === 1 ? 0 : frame.gw / (n - 1);
    const scale = getYScale(values);
    const yMin = frame.padT;
    const yMax = frame.padT + frame.gh;
    return values.map((value, index) => ({
      x: frame.padL + step * index,
      y: clamp(frame.padT + frame.gh - ((Number(value || 0) / scale.yMax) * frame.gh), yMin, yMax),
      value: Number(value || 0),
      index,
    }));
  }

  function drawSmoothLine(ctx, points){
    if (!points.length) return;
    const yMin = Math.min.apply(null, points.map((p) => (typeof p.chartMinY !== "undefined" ? p.chartMinY : p.y)));
    const yMax = Math.max.apply(null, points.map((p) => (typeof p.chartMaxY !== "undefined" ? p.chartMaxY : p.y)));
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    if (points.length === 1) {
      ctx.lineTo(points[0].x, points[0].y);
    } else {
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = clamp(p1.y + (p2.y - p0.y) / 6, yMin, yMax);
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = clamp(p2.y - (p3.y - p1.y) / 6, yMin, yMax);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      }
    }
    ctx.stroke();
  }

  function drawSmoothAreaFill(ctx, points, baselineY){
    if (!points.length) return;
    const yMin = Math.min.apply(null, points.map((p) => (typeof p.chartMinY !== "undefined" ? p.chartMinY : p.y)));
    const yMax = Math.max.apply(null, points.map((p) => (typeof p.chartMaxY !== "undefined" ? p.chartMaxY : p.y)));
    ctx.beginPath();
    ctx.moveTo(points[0].x, baselineY);
    ctx.lineTo(points[0].x, points[0].y);
    if (points.length === 1) {
      ctx.lineTo(points[0].x, points[0].y);
    } else {
      for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[i - 1] || points[i];
        const p1 = points[i];
        const p2 = points[i + 1];
        const p3 = points[i + 2] || p2;
        const cp1x = p1.x + (p2.x - p0.x) / 6;
        const cp1y = clamp(p1.y + (p2.y - p0.y) / 6, yMin, yMax);
        const cp2x = p2.x - (p3.x - p1.x) / 6;
        const cp2y = clamp(p2.y - (p3.y - p1.y) / 6, yMin, yMax);
        ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
      }
    }
    const last = points[points.length - 1];
    ctx.lineTo(last.x, baselineY);
    ctx.closePath();
    ctx.fill();
  }

  function ensureChartHoverOverlay($wrap, key){
    if (!$wrap) return null;
    const attr = "data-chart-hover-overlay";
    let root = $wrap.querySelector('[' + attr + '="' + key + '"]');
    if (!root) {
      root = document.createElement("div");
      root.setAttribute(attr, key);
      root.style.position = "absolute";
      root.style.inset = "0";
      root.style.pointerEvents = "none";
      root.style.zIndex = "3";
      root.innerHTML =
        '<div data-hover-line style="position:absolute; display:none; width:1px; background:rgba(148,163,184,.45); border-radius:999px;"></div>' +
        '<div data-hover-point="secondary" style="position:absolute; display:none; width:14px; height:14px; margin-left:-7px; margin-top:-7px; border-radius:999px; background:#fff; border:2px solid rgba(37,99,235,.72); box-shadow:0 0 0 6px rgba(37,99,235,.10);"></div>' +
        '<div data-hover-point="primary" style="position:absolute; display:none; width:16px; height:16px; margin-left:-8px; margin-top:-8px; border-radius:999px; background:#fff; border:3px solid rgba(16,185,129,.82); box-shadow:0 0 0 6px rgba(16,185,129,.12);"></div>';
      $wrap.appendChild(root);
    }
    return {
      root,
      line: root.querySelector("[data-hover-line]"),
      primary: root.querySelector('[data-hover-point="primary"]'),
      secondary: root.querySelector('[data-hover-point="secondary"]'),
    };
  }

  function showChartHoverOverlay(overlay, frame, primaryPoint, secondaryPoint, colors){
    if (!overlay || !frame || !primaryPoint) return;
    const guideX = primaryPoint.x;
    if (overlay.line) {
      overlay.line.style.display = "block";
      overlay.line.style.left = Math.round(guideX) + "px";
      overlay.line.style.top = Math.round(frame.padT) + "px";
      overlay.line.style.height = Math.round(frame.gh) + "px";
    }
    if (overlay.primary) {
      overlay.primary.style.display = "block";
      overlay.primary.style.left = Math.round(primaryPoint.x) + "px";
      overlay.primary.style.top = Math.round(primaryPoint.y) + "px";
      overlay.primary.style.borderColor = (colors && colors.primary) || "rgba(16,185,129,.82)";
      overlay.primary.style.boxShadow = "0 0 0 6px " + ((colors && colors.primaryGlow) || "rgba(16,185,129,.12)");
    }
    if (overlay.secondary) {
      if (secondaryPoint) {
        overlay.secondary.style.display = "block";
        overlay.secondary.style.left = Math.round(secondaryPoint.x) + "px";
        overlay.secondary.style.top = Math.round(secondaryPoint.y) + "px";
        overlay.secondary.style.borderColor = (colors && colors.secondary) || "rgba(37,99,235,.72)";
        overlay.secondary.style.boxShadow = "0 0 0 6px " + ((colors && colors.secondaryGlow) || "rgba(37,99,235,.10)");
      } else {
        overlay.secondary.style.display = "none";
      }
    }
  }

  function hideChartHoverOverlay(overlay){
    if (!overlay) return;
    if (overlay.line) overlay.line.style.display = "none";
    if (overlay.primary) overlay.primary.style.display = "none";
    if (overlay.secondary) overlay.secondary.style.display = "none";
  }

  function renderChartTipHtml(title, rows){
    const titleHtml = '<div style="font-size:18px; line-height:1.25; font-weight:500; color:#334155; margin-bottom:14px;">' + String(title || "") + '</div>';
    const rowsHtml = (rows || []).map((row) => {
      return '<div style="display:flex; align-items:center; justify-content:space-between; gap:18px; margin-top:8px;">' +
        '<span style="font-size:16px; color:#334155; white-space:nowrap;">' + String(row.label || "") + '</span>' +
        '<span style="font-size:18px; font-weight:700; color:' + String(row.color || "#0f172a") + '; white-space:nowrap;">' + String(row.value || "") + '</span>' +
      '</div>';
    }).join("");
    return titleHtml + rowsHtml;
  }

  function showChartTipCard($tip, $wrap, anchorX, anchorY, html){
    if (!$tip || !$wrap) return;
    $tip.style.display = "block";
    $tip.style.position = "absolute";
    $tip.style.pointerEvents = "none";
    $tip.style.zIndex = "9";
    $tip.style.padding = "18px 22px";
    $tip.style.borderRadius = "18px";
    $tip.style.border = "2px solid rgba(148,163,184,.55)";
    $tip.style.background = "rgba(255,255,255,.98)";
    $tip.style.color = "#0f172a";
    $tip.style.fontSize = "14px";
    $tip.style.lineHeight = "1.25";
    $tip.style.boxShadow = "0 18px 44px rgba(15,23,42,.12)";
    $tip.style.backdropFilter = "blur(8px)";
    $tip.style.minWidth = "280px";
    $tip.style.maxWidth = "360px";
    $tip.innerHTML = html;
    const wrapRect = $wrap.getBoundingClientRect();
    const tipRect = $tip.getBoundingClientRect();
    const left = clamp(anchorX - (tipRect.width / 2), 14, Math.max(14, wrapRect.width - tipRect.width - 14));
    const top = clamp(anchorY - tipRect.height - 24, 12, Math.max(12, wrapRect.height - tipRect.height - 12));
    $tip.style.left = Math.round(left) + "px";
    $tip.style.top = Math.round(top) + "px";
  }

  function getSvgChartHoverGeometry($svgHost, labels, index, valuesA, valuesB){
    const svgEl = $svgHost ? $svgHost.querySelector("svg") : null;
    if (!svgEl) return null;
    const rect = svgEl.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    const padL = rect.width * (56 / 1200);
    const padR = rect.width * (18 / 1200);
    const padT = rect.height * (18 / 260);
    const padB = rect.height * (42 / 260);
    const frame = { padT, gh: rect.height - padT - padB };
    const safeIndex = Math.max(0, Math.min(Number(index || 0), Math.max(0, labels.length - 1)));
    const pointX = labels.length > 1 ? padL + ((rect.width - padL - padR) / (labels.length - 1)) * safeIndex : rect.width / 2;
    const scale = getYScale((valuesA || []).concat(valuesB || []).map((v) => Number(v || 0)));
    const primaryY = clamp(frame.padT + frame.gh - ((Number((valuesA || [])[safeIndex] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh);
    const secondaryY = clamp(frame.padT + frame.gh - ((Number((valuesB || [])[safeIndex] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh);
    return { frame, pointX, primaryY, secondaryY };
  }

  function drawLineChart(ctx, width, height, labels, values, options){
    const frame = getChartFrame(width, height);
    const scale = getYScale(values);
    const points = getLinePoints(frame, values).map((point) => ({
      ...point,
      chartMinY: frame.padT,
      chartMaxY: frame.padT + frame.gh,
    }));
    const lineColor = options.lineColor || "rgba(37,99,235,.72)";
    const fillColor = options.fillColor || "rgba(37,99,235,.08)";
    const hoverColor = options.hoverColor || "rgba(37,99,235,.95)";

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(15,23,42,.08)";
    ctx.fillStyle = "rgba(71,85,105,.9)";
    ctx.font = "500 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";

    for (let i = 0; i <= scale.yTicks; i++) {
      const v = i * scale.tickStep;
      const y = frame.padT + frame.gh - (v / scale.yMax) * frame.gh;
      ctx.beginPath();
      ctx.moveTo(frame.padL, y);
      ctx.lineTo(frame.padL + frame.gw, y);
      ctx.stroke();
      ctx.fillText(String(v), 18, y + 4);
    }

    if (points.length > 1) {
      const labelStep = points.length <= 4 ? 1 : Math.ceil(points.length / 4);
      labels.forEach((label, index) => {
        if (index !== points.length - 1 && index % labelStep !== 0) return;
        const point = points[index];
        ctx.textAlign = index === points.length - 1 ? "right" : (index === 0 ? "left" : "center");
        ctx.fillStyle = "rgba(71,85,105,.95)";
        ctx.fillText(String(label || ""), point.x, frame.padT + frame.gh + 30);
      });
    } else if (points.length === 1) {
      ctx.textAlign = "center";
      ctx.fillStyle = "rgba(71,85,105,.95)";
      ctx.fillText(String(labels[0] || ""), points[0].x, frame.padT + frame.gh + 30);
    }

    if (points.length) {
      ctx.save();
      ctx.fillStyle = fillColor;
      drawSmoothAreaFill(ctx, points, frame.padT + frame.gh);
      ctx.restore();

      ctx.strokeStyle = lineColor;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawSmoothLine(ctx, points);
      ctx.lineWidth = 1;

      if (Number.isInteger(options.hoverIndex) && options.hoverIndex >= 0 && points[options.hoverIndex]) {
        const point = points[options.hoverIndex];
        ctx.beginPath();
        ctx.arc(point.x, point.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = hoverColor;
        ctx.fill();
        ctx.lineWidth = 4;
        ctx.strokeStyle = "rgba(37,99,235,.25)";
        ctx.stroke();
      }
    }

    return { frame, points };
  }

  function getNearestPointIndex(points, mx, my, frame){
    if (!points.length) return -1;
    if (mx < frame.padL || mx > frame.padL + frame.gw || my < frame.padT || my > frame.padT + frame.gh) return -1;
    let closest = -1;
    let min = Infinity;
    points.forEach((point, index) => {
      const dist = Math.abs(point.x - mx);
      if (dist < min) {
        min = dist;
        closest = index;
      }
    });
    return min <= 24 ? closest : -1;
  }

  function initEventsChart(){
    const $svgHost = document.getElementById("eventsChartSvgHost");
    const $data   = document.getElementById("eventsChartData");
    const $canvas = document.getElementById("eventsChart");
    const $wrap   = document.getElementById("eventsChartWrap");
    const $tip    = document.getElementById("eventsChartTip");
    const $seg    = document.getElementById("chartViewSeg");
    const $range  = document.getElementById("chartRangeLabel");
    const $legend = document.getElementById("eventsChartLegend");
    const $info = document.getElementById("eventsChartInfo");
    const hoverOverlay = ensureChartHoverOverlay($wrap, "events");
    if ($svgHost) {
      if ($canvas) $canvas.style.display = "none";
      if ($info) $info.style.display = "none";
      let svgChartSets = { events: {}, views: {} };
      try {
        if ($data) {
          const rawChartJson = ($data.getAttribute("data-chart") || ($data.textContent || "").trim() || "{}");
          const parsed = JSON.parse(rawChartJson);
          if (parsed && typeof parsed === "object") {
            svgChartSets = parsed;
          }
        }
      } catch (_) {}
      const hasCityEventSeries = !!(svgChartSets.cityEvents && svgChartSets.cityEvents.daily);
      function showSvgChartTip(index, ev){
        if (!$tip || !ev) return;
        const activeViewEl = $seg ? $seg.querySelector(".on") : null;
        const mode = activeViewEl ? String(activeViewEl.getAttribute("data-view") || "daily") : "daily";
        const eventSet = (svgChartSets.events && svgChartSets.events[mode]) ? svgChartSets.events[mode] : { labels: [], values: [] };
        const viewSet = (svgChartSets.views && svgChartSets.views[mode]) ? svgChartSets.views[mode] : { labels: [], values: [] };
        const cityEventSet = (svgChartSets.cityEvents && svgChartSets.cityEvents[mode]) ? svgChartSets.cityEvents[mode] : { labels: [], values: [] };
        const labels = Array.isArray(eventSet.labels) ? eventSet.labels : [];
        const eventValues = Array.isArray(eventSet.values) ? eventSet.values : [];
        const viewValues = Array.isArray(viewSet.values) ? viewSet.values : [];
        const cityEventValues = Array.isArray(cityEventSet.values) ? cityEventSet.values : [];
        const safeIndex = Math.max(0, Math.min(Number(index || 0), labels.length - 1));
        const label = String(labels[safeIndex] || "");
        const periodNames = { daily: "Day", weekly: "Week", monthly: "Month", yearly: "Year" };
        const svgEl = $svgHost ? $svgHost.querySelector("svg") : null;
        const svgRect = svgEl ? svgEl.getBoundingClientRect() : null;
        const plotFrame = svgRect ? {
          padT: svgRect.height * (18 / 260),
          gh: svgRect.height - (svgRect.height * (18 / 260)) - (svgRect.height * (42 / 260)),
        } : null;
        const pointX = svgRect && labels.length > 1
          ? (svgRect.width * (56 / 1200)) + ((svgRect.width - (svgRect.width * (56 / 1200)) - (svgRect.width * (18 / 1200))) / (labels.length - 1)) * safeIndex
          : (svgRect ? svgRect.width / 2 : 0);
        const allValues = eventValues.concat(viewValues).map((v) => Number(v || 0));
        const yScale = getYScale(allValues);
        const primaryY = plotFrame
          ? clamp(plotFrame.padT + plotFrame.gh - ((Number(eventValues[safeIndex] || 0) / yScale.yMax) * plotFrame.gh), plotFrame.padT, plotFrame.padT + plotFrame.gh)
          : 0;
        const secondaryY = plotFrame
          ? clamp(plotFrame.padT + plotFrame.gh - ((Number(viewValues[safeIndex] || 0) / yScale.yMax) * plotFrame.gh), plotFrame.padT, plotFrame.padT + plotFrame.gh)
          : 0;
        showChartHoverOverlay(hoverOverlay, { padT: plotFrame ? plotFrame.padT : 0, gh: plotFrame ? plotFrame.gh : 0 }, { x: pointX, y: primaryY }, { x: pointX, y: secondaryY }, {
          primary: "rgba(16,185,129,.82)",
          primaryGlow: "rgba(16,185,129,.12)",
          secondary: "rgba(37,99,235,.72)",
          secondaryGlow: "rgba(37,99,235,.10)",
        });
        showChartTipCard($tip, $wrap, pointX, Math.min(primaryY, secondaryY), renderChartTipHtml(
          (periodNames[mode] || "Period") + ": " + label,
          [
            { label: hasCityEventSeries ? "My events" : "Events", value: Number(eventValues[safeIndex] || 0).toLocaleString("en-US"), color: "#0f172a" },
            ...(Number(cityEventValues[safeIndex] || 0) > 0 ? [{ label: "City events", value: Number(cityEventValues[safeIndex] || 0).toLocaleString("en-US"), color: "#475569" }] : []),
            { label: "Views", value: Number(viewValues[safeIndex] || 0).toLocaleString("en-US"), color: "#0f172a" },
          ]
        ));
      }
      function hideSvgChartTip(){
        if ($tip) $tip.style.display = "none";
        hideChartHoverOverlay(hoverOverlay);
      }
      function getSvgHoverIndexFromEvent(ev){
        const activeViewEl = $seg ? $seg.querySelector(".on") : null;
        const mode = activeViewEl ? String(activeViewEl.getAttribute("data-view") || "daily") : "daily";
        const eventSet = (svgChartSets.events && svgChartSets.events[mode]) ? svgChartSets.events[mode] : { labels: [], values: [] };
        const labels = Array.isArray(eventSet.labels) ? eventSet.labels : [];
        if (!labels.length || !$svgHost) return -1;
        const svgEl = $svgHost.querySelector("svg");
        if (!svgEl) return -1;
        const rect = svgEl.getBoundingClientRect();
        if (!rect.width || !rect.height) return -1;
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const padL = rect.width * (56 / 1200);
        const padR = rect.width * (18 / 1200);
        const padT = rect.height * (18 / 260);
        const padB = rect.height * (42 / 260);
        const plotW = rect.width - padL - padR;
        const plotH = rect.height - padT - padB;
        if (mx < padL || mx > padL + plotW || my < padT || my > padT + plotH) return -1;
        if (labels.length === 1) return 0;
        const stepX = plotW / (labels.length - 1);
        const rawIndex = Math.round((mx - padL) / stepX);
        return Math.max(0, Math.min(rawIndex, labels.length - 1));
      }
      window.ocShowEventsChartTipIndex = showSvgChartTip;
      window.ocHideEventsChartTip = hideSvgChartTip;

      $svgHost.addEventListener("mousemove", function(ev){
        const index = getSvgHoverIndexFromEvent(ev);
        if (!Number.isInteger(index) || index < 0) {
          hideSvgChartTip();
          return;
        }
        showSvgChartTip(index, ev);
      });
      $svgHost.addEventListener("mouseleave", hideSvgChartTip);
      return;
    }
    if ($canvas) $canvas.style.display = "block";
    if ($info) $info.style.display = "none";

    if (!$canvas || !$wrap) return;
    const ctx = $canvas.getContext("2d");
    if (!ctx) return;

    let chartSets = { events: {}, views: {} };
    try {
      if ($data) {
        const rawChartJson = ($data.getAttribute("data-chart") || ($data.textContent || "").trim() || "{}");
        const parsed = JSON.parse(rawChartJson);
        if (parsed && typeof parsed === "object") {
          const parsedEvents = parsed.events || {};
          const parsedViews = parsed.views || {};
          const parsedCityEvents = parsed.cityEvents || {};
          chartSets = {
            events: {
              daily: {
                labels: parsedEvents.daily && Array.isArray(parsedEvents.daily.labels) ? parsedEvents.daily.labels : [],
                values: parsedEvents.daily && Array.isArray(parsedEvents.daily.values) ? parsedEvents.daily.values : [],
              },
              weekly: {
                labels: parsedEvents.weekly && Array.isArray(parsedEvents.weekly.labels) ? parsedEvents.weekly.labels : [],
                values: parsedEvents.weekly && Array.isArray(parsedEvents.weekly.values) ? parsedEvents.weekly.values : [],
              },
              monthly: {
                labels: parsedEvents.monthly && Array.isArray(parsedEvents.monthly.labels) ? parsedEvents.monthly.labels : [],
                values: parsedEvents.monthly && Array.isArray(parsedEvents.monthly.values) ? parsedEvents.monthly.values : [],
              },
              yearly: {
                labels: parsedEvents.yearly && Array.isArray(parsedEvents.yearly.labels) ? parsedEvents.yearly.labels : [],
                values: parsedEvents.yearly && Array.isArray(parsedEvents.yearly.values) ? parsedEvents.yearly.values : [],
              },
            },
            views: {
              daily: {
                labels: parsedViews.daily && Array.isArray(parsedViews.daily.labels) ? parsedViews.daily.labels : [],
                values: parsedViews.daily && Array.isArray(parsedViews.daily.values) ? parsedViews.daily.values : [],
              },
              weekly: {
                labels: parsedViews.weekly && Array.isArray(parsedViews.weekly.labels) ? parsedViews.weekly.labels : [],
                values: parsedViews.weekly && Array.isArray(parsedViews.weekly.values) ? parsedViews.weekly.values : [],
              },
              monthly: {
                labels: parsedViews.monthly && Array.isArray(parsedViews.monthly.labels) ? parsedViews.monthly.labels : [],
                values: parsedViews.monthly && Array.isArray(parsedViews.monthly.values) ? parsedViews.monthly.values : [],
              },
              yearly: {
                labels: parsedViews.yearly && Array.isArray(parsedViews.yearly.labels) ? parsedViews.yearly.labels : [],
                values: parsedViews.yearly && Array.isArray(parsedViews.yearly.values) ? parsedViews.yearly.values : [],
              },
            },
            cityEvents: {
              daily: {
                labels: parsedCityEvents.daily && Array.isArray(parsedCityEvents.daily.labels) ? parsedCityEvents.daily.labels : [],
                values: parsedCityEvents.daily && Array.isArray(parsedCityEvents.daily.values) ? parsedCityEvents.daily.values : [],
              },
              weekly: {
                labels: parsedCityEvents.weekly && Array.isArray(parsedCityEvents.weekly.labels) ? parsedCityEvents.weekly.labels : [],
                values: parsedCityEvents.weekly && Array.isArray(parsedCityEvents.weekly.values) ? parsedCityEvents.weekly.values : [],
              },
              monthly: {
                labels: parsedCityEvents.monthly && Array.isArray(parsedCityEvents.monthly.labels) ? parsedCityEvents.monthly.labels : [],
                values: parsedCityEvents.monthly && Array.isArray(parsedCityEvents.monthly.values) ? parsedCityEvents.monthly.values : [],
              },
              yearly: {
                labels: parsedCityEvents.yearly && Array.isArray(parsedCityEvents.yearly.labels) ? parsedCityEvents.yearly.labels : [],
                values: parsedCityEvents.yearly && Array.isArray(parsedCityEvents.yearly.values) ? parsedCityEvents.yearly.values : [],
              },
            },
          };
        }
      }
    } catch (_) {}
    const hasCityEventSeries = !!(chartSets.cityEvents && chartSets.cityEvents.daily);

    let mode = "daily";
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

  function getPeriodLabel(rawLabel){
    const label = String(rawLabel || "").trim();
    if (!label) return "";
    const prefixMap = {
      daily: "Day",
      weekly: "Week",
      monthly: "Month",
      yearly: "Year",
    };
    return (prefixMap[mode] || "Period") + ": " + label;
  }

  function syncLegend(){
    if (!$legend) return;
    $legend.querySelectorAll("[data-legend-metric]").forEach((item) => {
      const itemMetric = item.getAttribute("data-legend-metric") || "";
      const line = item.querySelector(".chartLegendLine");
      if (!line) return;
      const isPrimary = itemMetric === "events";
      line.classList.toggle("is-dashed", !isPrimary);
    });
  }

    function sizeCanvas(){
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      let w = $wrap.clientWidth || Math.floor($wrap.getBoundingClientRect().width || 0);
      if (!w || w < 10) w = Math.floor(($canvas.parentElement ? $canvas.parentElement.getBoundingClientRect().width : 0) || 0);
      w = Math.max(320, w || 320);
      let h = $wrap.clientHeight || Math.floor($wrap.getBoundingClientRect().height || 0);
      h = Math.max(220, h || 260);
      $canvas.style.width  = w + "px";
      $canvas.style.height = h + "px";
      $canvas.width  = Math.floor(w * dpr);
      $canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }

    function draw(){
      const primarySet = (chartSets.events && chartSets.events[mode]) ? chartSets.events[mode] : chartSets.events.daily;
      const secondarySet = (chartSets.views && chartSets.views[mode])
        ? chartSets.views[mode]
        : ((chartSets.views && chartSets.views.daily) ? chartSets.views.daily : { labels: [], values: [] });
    const labels = (primarySet && primarySet.labels) ? primarySet.labels : [];
    const primaryValues = (primarySet && primarySet.values) ? primarySet.values : [];
    const secondaryValues = (secondarySet && secondarySet.values) ? secondarySet.values : [];
    const combinedValues = [...primaryValues, ...secondaryValues];

      const { w, h } = sizeCanvas();
      ctx.clearRect(0,0,w,h);

      const hasAnyValue = combinedValues.some((value) => Number(value || 0) > 0);
      if (!labels.length || !hasAnyValue){
        ctx.fillStyle = "rgba(15,23,42,.75)";
      ctx.font = "600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      ctx.fillText("No recent activity", 18, 90);
      return;
    }

      const frame = getChartFrame(w, h);
      const scale = getYScale(combinedValues);
      const primaryPoints = labels.map((label, index) => ({
        x: frame.padL + (labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1)) * index),
        y: clamp(frame.padT + frame.gh - ((Number(primaryValues[index] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh),
        value: Number(primaryValues[index] || 0),
        index,
        chartMinY: frame.padT,
        chartMaxY: frame.padT + frame.gh,
      }));
      const secondaryPoints = labels.length === secondaryValues.length ? labels.map((label, index) => ({
            x: frame.padL + (labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1)) * index),
            y: clamp(frame.padT + frame.gh - ((Number(secondaryValues[index] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh),
            value: Number(secondaryValues[index] || 0),
            index,
            chartMinY: frame.padT,
            chartMaxY: frame.padT + frame.gh,
        })) : [];

    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(15,23,42,.08)";
    ctx.fillStyle = "rgba(71,85,105,.9)";
    ctx.font = "500 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    for (let i = 0; i <= scale.yTicks; i++) {
      const v = i * scale.tickStep;
      const y = frame.padT + frame.gh - (v / scale.yMax) * frame.gh;
      ctx.beginPath();
      ctx.moveTo(frame.padL, y);
      ctx.lineTo(frame.padL + frame.gw, y);
      ctx.stroke();
      ctx.fillText(String(v), 18, y + 4);
    }
    if (primaryPoints.length > 1) {
      const labelStep = primaryPoints.length <= 4 ? 1 : Math.ceil(primaryPoints.length / 4);
      labels.forEach((label, index) => {
        if (index !== primaryPoints.length - 1 && index % labelStep !== 0) return;
        const point = primaryPoints[index];
        ctx.textAlign = index === primaryPoints.length - 1 ? "right" : (index === 0 ? "left" : "center");
        ctx.fillStyle = "rgba(71,85,105,.95)";
        ctx.fillText(String(label || ""), point.x, frame.padT + frame.gh + 30);
      });
    }

    const primaryColor = "rgba(16,185,129,.82)";
    const secondaryColor = "rgba(37,99,235,.72)";

    if (primaryPoints.length) {
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(primaryPoints[0].x, frame.padT + frame.gh);
      ctx.lineTo(primaryPoints[0].x, primaryPoints[0].y);
      if (primaryPoints.length === 1) {
        ctx.lineTo(primaryPoints[0].x, primaryPoints[0].y);
      } else {
        for (let i = 0; i < primaryPoints.length - 1; i++) {
          const p0 = primaryPoints[i - 1] || primaryPoints[i];
          const p1 = primaryPoints[i];
          const p2 = primaryPoints[i + 1];
          const p3 = primaryPoints[i + 2] || p2;
          const cp1x = p1.x + (p2.x - p0.x) / 6;
          const cp1y = clamp(p1.y + (p2.y - p0.y) / 6, frame.padT, frame.padT + frame.gh);
          const cp2x = p2.x - (p3.x - p1.x) / 6;
          const cp2y = clamp(p2.y - (p3.y - p1.y) / 6, frame.padT, frame.padT + frame.gh);
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        }
      }
      const last = primaryPoints[primaryPoints.length - 1];
      ctx.lineTo(last.x, frame.padT + frame.gh);
      ctx.closePath();
      ctx.fillStyle = "rgba(16,185,129,.10)";
      ctx.fill();
      ctx.restore();
    }

    if (secondaryPoints.length) {
      ctx.save();
      ctx.strokeStyle = secondaryColor;
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 6]);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawSmoothLine(ctx, secondaryPoints);
      ctx.restore();
    }

    ctx.save();
    ctx.strokeStyle = primaryColor;
    ctx.lineWidth = 3;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    drawSmoothLine(ctx, primaryPoints);
    ctx.restore();

  }

  function getPointIndexFromEvent(ev){
    const set = (chartSets.events && chartSets.events[mode]) ? chartSets.events[mode] : chartSets.events.daily;
    const values = (set && set.values) ? set.values : [];
    if (!values.length) return -1;

    const rect = $canvas.getBoundingClientRect();
    const mx = ev.clientX - rect.left;
    const my = ev.clientY - rect.top;
    const frame = getChartFrame(rect.width, rect.height);
    const points = getLinePoints(frame, values);
    return getNearestPointIndex(points, mx, my, frame);
  }

  function showTip(ev, idx){
    if (!$tip) return;
    const eventSet = (chartSets.events && chartSets.events[mode]) ? chartSets.events[mode] : chartSets.events.daily;
    const viewSet = (chartSets.views && chartSets.views[mode]) ? chartSets.views[mode] : chartSets.views.daily;
    const cityEventSet = (chartSets.cityEvents && chartSets.cityEvents[mode])
      ? chartSets.cityEvents[mode]
      : ((chartSets.cityEvents && chartSets.cityEvents.daily) ? chartSets.cityEvents.daily : { labels: [], values: [] });
    const labels = (eventSet && eventSet.labels) ? eventSet.labels : [];
    const eventValues = (eventSet && eventSet.values) ? eventSet.values : [];
    const viewValues = (viewSet && viewSet.values) ? viewSet.values : [];
    const cityEventValues = (cityEventSet && cityEventSet.values) ? cityEventSet.values : [];

    const rect = $canvas.getBoundingClientRect();
    const eventValue = Number(typeof eventValues[idx] !== "undefined" ? eventValues[idx] : 0);
    const viewValue = Number(typeof viewValues[idx] !== "undefined" ? viewValues[idx] : 0);
    const cityEventValue = Number(typeof cityEventValues[idx] !== "undefined" ? cityEventValues[idx] : 0);
    const periodLabel = getPeriodLabel(labels[idx] || "");
    const frame = getChartFrame(rect.width, rect.height);
    const scale = getYScale(eventValues.concat(viewValues));
    const stepX = labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1));
    const pointX = frame.padL + stepX * idx;
    const primaryY = clamp(frame.padT + frame.gh - ((eventValue / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh);
    const secondaryY = clamp(frame.padT + frame.gh - ((viewValue / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh);
    showChartHoverOverlay(hoverOverlay, frame, { x: pointX, y: primaryY }, { x: pointX, y: secondaryY }, {
      primary: "rgba(16,185,129,.82)",
      primaryGlow: "rgba(16,185,129,.12)",
      secondary: "rgba(37,99,235,.72)",
      secondaryGlow: "rgba(37,99,235,.10)",
    });
    showChartTipCard($tip, $wrap, pointX, Math.min(primaryY, secondaryY), renderChartTipHtml(
      periodLabel,
      [
        { label: hasCityEventSeries ? "My events" : "Events", value: eventValue.toLocaleString("en-US"), color: "#0f172a" },
        ...(hasCityEventSeries ? [{ label: "City events", value: cityEventValue.toLocaleString("en-US"), color: "#475569" }] : []),
        { label: "Views", value: viewValue.toLocaleString("en-US"), color: "#0f172a" },
      ]
    ));
  }

  function hideTip(){
    if ($tip) $tip.style.display = "none";
    hideChartHoverOverlay(hoverOverlay);
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
      syncLegend();
      draw();
    });
  }

  // Hover tooltip
  $canvas.addEventListener("mousemove", (e) => {
    const idx = getPointIndexFromEvent(e);
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
    syncLegend();
    draw();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }

  window.addEventListener("resize", () => window.requestAnimationFrame(draw));
}

  function initOrganizerChart(){
    const $data = document.getElementById("organizerChartData");
    const $canvas = document.getElementById("organizerChart");
    const $wrap = document.getElementById("organizerChartWrap");
    const $tip = document.getElementById("organizerChartTip");
    const $legend = document.getElementById("organizerChartLegend");
    const $svgHost = document.getElementById("organizerChartSvgHost");
    if (!$canvas || !$wrap) return;
    const hoverOverlay = ensureChartHoverOverlay($wrap, "organizer");

    const ctx = $canvas.getContext("2d");
    if (!ctx) return;

    let chartSets = {
      events: { labels: [], values: [] },
      views: { labels: [], values: [] },
    };
    try {
      if ($data) {
        const parsed = JSON.parse($data.getAttribute("data-chart") || "{}");
        if (parsed && typeof parsed === "object") {
          const parsedEvents = parsed.events || {};
          const parsedViews = parsed.views || {};
          chartSets = {
            events: {
              labels: Array.isArray(parsedEvents.labels) ? parsedEvents.labels : [],
              values: Array.isArray(parsedEvents.values) ? parsedEvents.values : [],
            },
            views: {
              labels: Array.isArray(parsedViews.labels) ? parsedViews.labels : [],
              values: Array.isArray(parsedViews.values) ? parsedViews.values : [],
            },
          };
        }
      }
    } catch (_) {}

    let hoverIndex = -1;

    if ($svgHost) {
      if ($canvas) $canvas.style.display = "none";
      function showSvgTip(index, ev){
        if (!$tip || !ev) return;
        const eventSet = chartSets.events || { labels: [], values: [] };
        const viewSet = chartSets.views || { labels: [], values: [] };
        const labels = Array.isArray(eventSet.labels) ? eventSet.labels : [];
        const eventValues = Array.isArray(eventSet.values) ? eventSet.values : [];
        const viewValues = Array.isArray(viewSet.values) ? viewSet.values : [];
        const safeIndex = Math.max(0, Math.min(Number(index || 0), labels.length - 1));
        const geometry = getSvgChartHoverGeometry($svgHost, labels, safeIndex, eventValues, viewValues);
        if (!geometry) return;
        showChartHoverOverlay(hoverOverlay, geometry.frame, { x: geometry.pointX, y: geometry.primaryY }, { x: geometry.pointX, y: geometry.secondaryY }, {
          primary: "rgba(16,185,129,.82)",
          primaryGlow: "rgba(16,185,129,.12)",
          secondary: "rgba(37,99,235,.72)",
          secondaryGlow: "rgba(37,99,235,.10)",
        });
        showChartTipCard($tip, $wrap, geometry.pointX, Math.min(geometry.primaryY, geometry.secondaryY), renderChartTipHtml(
          "Month: " + String(labels[safeIndex] || ""),
          [
            { label: "Events", value: Number(eventValues[safeIndex] || 0).toLocaleString("en-US"), color: "#0f172a" },
            { label: "Views", value: Number(viewValues[safeIndex] || 0).toLocaleString("en-US"), color: "#0f172a" },
          ]
        ));
      }
      function hideSvgTip(){
        if ($tip) $tip.style.display = "none";
        hideChartHoverOverlay(hoverOverlay);
      }
      function getSvgHoverIndex(ev){
        const eventSet = chartSets.events || { labels: [], values: [] };
        const labels = Array.isArray(eventSet.labels) ? eventSet.labels : [];
        if (!labels.length) return -1;
        const svgEl = $svgHost.querySelector("svg");
        if (!svgEl) return -1;
        const rect = svgEl.getBoundingClientRect();
        if (!rect.width || !rect.height) return -1;
        const mx = ev.clientX - rect.left;
        const my = ev.clientY - rect.top;
        const padL = rect.width * (56 / 1200);
        const padR = rect.width * (18 / 1200);
        const padT = rect.height * (18 / 260);
        const padB = rect.height * (42 / 260);
        const plotW = rect.width - padL - padR;
        const plotH = rect.height - padT - padB;
        if (mx < padL || mx > padL + plotW || my < padT || my > padT + plotH) return -1;
        if (labels.length === 1) return 0;
        return Math.max(0, Math.min(Math.round((mx - padL) / (plotW / (labels.length - 1))), labels.length - 1));
      }
      syncLegend();
      $svgHost.addEventListener("mousemove", (ev) => {
        const index = getSvgHoverIndex(ev);
        if (!Number.isInteger(index) || index < 0) {
          hideSvgTip();
          return;
        }
        showSvgTip(index, ev);
      });
      $svgHost.addEventListener("mouseleave", hideSvgTip);
      return;
    }

    function syncLegend(){
      if (!$legend) return;
      $legend.querySelectorAll("[data-legend-metric]").forEach((item) => {
        const itemMetric = item.getAttribute("data-legend-metric") || "";
        const line = item.querySelector(".chartLegendLine");
        if (!line) return;
        line.classList.toggle("is-dashed", itemMetric !== "events");
      });
    }
    function sizeCanvas(){
      const dpr = Math.max(1, window.devicePixelRatio || 1);
      let w = $wrap.clientWidth || Math.floor($wrap.getBoundingClientRect().width || 0);
      w = Math.max(320, w || 320);
      let h = $wrap.clientHeight || Math.floor($wrap.getBoundingClientRect().height || 0);
      h = Math.max(260, h || 320);
      $canvas.style.width = w + "px";
      $canvas.style.height = h + "px";
      $canvas.width = Math.floor(w * dpr);
      $canvas.height = Math.floor(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      return { w, h };
    }
    function draw(){
      const primarySet = chartSets.events || { labels: [], values: [] };
      const secondarySet = chartSets.views || { labels: [], values: [] };
      const labels = primarySet.labels || [];
      const primaryValues = primarySet.values || [];
      const secondaryValues = secondarySet.values || [];
      const combinedValues = [...primaryValues, ...secondaryValues];
      const { w, h } = sizeCanvas();
      ctx.clearRect(0, 0, w, h);
      if (!labels.length || !combinedValues.length) {
        ctx.fillStyle = "rgba(15,23,42,.75)";
        ctx.font = "600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.fillText("No organizer history yet", 18, 90);
        return;
      }
      const frame = getChartFrame(w, h);
      const scale = getYScale(combinedValues);
      const primaryPoints = labels.map((label, index) => ({
        x: frame.padL + (labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1)) * index),
        y: clamp(frame.padT + frame.gh - ((Number(primaryValues[index] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh),
        value: Number(primaryValues[index] || 0),
        index,
        chartMinY: frame.padT,
        chartMaxY: frame.padT + frame.gh,
      }));
      const secondaryPoints = labels.length === secondaryValues.length ? labels.map((label, index) => ({
        x: frame.padL + (labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1)) * index),
        y: clamp(frame.padT + frame.gh - ((Number(secondaryValues[index] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh),
        value: Number(secondaryValues[index] || 0),
        index,
        chartMinY: frame.padT,
        chartMaxY: frame.padT + frame.gh,
      })) : [];

      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(15,23,42,.08)";
      ctx.fillStyle = "rgba(71,85,105,.9)";
      ctx.font = "500 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      for (let i = 0; i <= scale.yTicks; i++) {
        const v = i * scale.tickStep;
        const y = frame.padT + frame.gh - (v / scale.yMax) * frame.gh;
        ctx.beginPath();
        ctx.moveTo(frame.padL, y);
        ctx.lineTo(frame.padL + frame.gw, y);
        ctx.stroke();
        ctx.fillText(String(v), 18, y + 4);
      }
      if (primaryPoints.length > 1) {
        const labelStep = primaryPoints.length <= 4 ? 1 : Math.ceil(primaryPoints.length / 4);
        labels.forEach((label, index) => {
          if (index !== primaryPoints.length - 1 && index % labelStep !== 0) return;
          const point = primaryPoints[index];
          ctx.textAlign = index === primaryPoints.length - 1 ? "right" : (index === 0 ? "left" : "center");
          ctx.fillStyle = "rgba(71,85,105,.95)";
          ctx.fillText(String(label || ""), point.x, frame.padT + frame.gh + 30);
        });
      }

      const primaryColor = "rgba(16,185,129,.82)";
      const secondaryColor = "rgba(37,99,235,.72)";

      if (primaryPoints.length) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(primaryPoints[0].x, frame.padT + frame.gh);
        ctx.lineTo(primaryPoints[0].x, primaryPoints[0].y);
        for (let i = 0; i < primaryPoints.length - 1; i++) {
          const p0 = primaryPoints[i - 1] || primaryPoints[i];
          const p1 = primaryPoints[i];
          const p2 = primaryPoints[i + 1];
          const p3 = primaryPoints[i + 2] || p2;
          const cp1x = p1.x + (p2.x - p0.x) / 6;
          const cp1y = clamp(p1.y + (p2.y - p0.y) / 6, frame.padT, frame.padT + frame.gh);
          const cp2x = p2.x - (p3.x - p1.x) / 6;
          const cp2y = clamp(p2.y - (p3.y - p1.y) / 6, frame.padT, frame.padT + frame.gh);
          ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
        }
        const last = primaryPoints[primaryPoints.length - 1];
        ctx.lineTo(last.x, frame.padT + frame.gh);
        ctx.closePath();
        ctx.fillStyle = "rgba(16,185,129,.10)";
        ctx.fill();
        ctx.restore();
      }
      if (secondaryPoints.length) {
        ctx.save();
        ctx.strokeStyle = secondaryColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        drawSmoothLine(ctx, secondaryPoints);
        ctx.restore();
      }
      ctx.save();
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawSmoothLine(ctx, primaryPoints);
      ctx.restore();

    }
    function getPointIndexFromEvent(ev){
      const set = chartSets.events || { labels: [], values: [] };
      const values = set.values || [];
      if (!values.length) return -1;
      const rect = $canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const frame = getChartFrame(rect.width, rect.height);
      const points = getLinePoints(frame, values);
      return getNearestPointIndex(points, mx, my, frame);
    }
    function showTip(ev, idx){
      if (!$tip) return;
      const eventSet = chartSets.events || { labels: [], values: [] };
      const viewSet = chartSets.views || { labels: [], values: [] };
      const labels = eventSet.labels || viewSet.labels || [];
      const eventValue = Number((eventSet.values || [])[idx] || 0);
      const viewValue = Number((viewSet.values || [])[idx] || 0);
      const rect = $canvas.getBoundingClientRect();
      const frame = getChartFrame(rect.width, rect.height);
      const scale = getYScale(eventSet.values.concat(viewSet.values));
      const stepX = labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1));
      const pointX = frame.padL + stepX * idx;
      const primaryY = clamp(frame.padT + frame.gh - ((eventValue / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh);
      const secondaryY = clamp(frame.padT + frame.gh - ((viewValue / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh);
      showChartHoverOverlay(hoverOverlay, frame, { x: pointX, y: primaryY }, { x: pointX, y: secondaryY }, {
        primary: "rgba(16,185,129,.82)",
        primaryGlow: "rgba(16,185,129,.12)",
        secondary: "rgba(37,99,235,.72)",
        secondaryGlow: "rgba(37,99,235,.10)",
      });
      showChartTipCard($tip, $wrap, pointX, Math.min(primaryY, secondaryY), renderChartTipHtml(
        "Month: " + String(labels[idx] || ""),
        [
          { label: "Events", value: eventValue.toLocaleString("en-US"), color: "#0f172a" },
          { label: "Views", value: viewValue.toLocaleString("en-US"), color: "#0f172a" },
        ]
      ));
    }
    function hideTip(){ if ($tip) $tip.style.display = "none"; hideChartHoverOverlay(hoverOverlay); }

    $canvas.addEventListener("mousemove", (e) => {
      const idx = getPointIndexFromEvent(e);
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

    syncLegend();
    draw();
    window.addEventListener("resize", () => window.requestAnimationFrame(draw));
  }

  function initVenueChart(){
    const $data = document.getElementById("venueChartData");
    const $canvas = document.getElementById("venueChart");
    const $wrap = document.getElementById("venueChartWrap");
    const $tip = document.getElementById("venueChartTip");
    const $metricSeg = document.getElementById("venueChartMetricSeg");
    const $legend = document.getElementById("venueChartLegend");
    const $svgHost = document.getElementById("venueChartSvgHost");
    const $svgViews = document.getElementById("venueChartSvgViews");
    const $svgClicks = document.getElementById("venueChartSvgClicks");
    if (!$wrap || !$metricSeg) return;
    const hoverOverlay = ensureChartHoverOverlay($wrap, "venue");

    function syncSvgFallback(nextMetric){
      if (!$svgHost) return;
      const targetMetric = nextMetric === "clicks" ? "clicks" : "views";
      const source = targetMetric === "clicks" ? $svgClicks : $svgViews;
      if (source && source.innerHTML) $svgHost.innerHTML = source.innerHTML;
      $svgHost.setAttribute("data-active-metric", targetMetric);
    }

    const ctx = $canvas ? $canvas.getContext("2d") : null;
    if (!ctx || !$canvas) {
      syncSvgFallback("views");
      return;
    }

    let chartSets = {
      views: { labels: [], values: [] },
      clicks: { labels: [], values: [] },
    };
    try {
      if ($data) {
        const parsed = JSON.parse($data.getAttribute("data-chart") || "{}");
        if (parsed && typeof parsed === "object") {
          const parsedViews = parsed.views || {};
          const parsedClicks = parsed.clicks || {};
          chartSets = {
            views: {
              labels: Array.isArray(parsedViews.labels) ? parsedViews.labels : [],
              values: Array.isArray(parsedViews.values) ? parsedViews.values : [],
            },
            clicks: {
              labels: Array.isArray(parsedClicks.labels) ? parsedClicks.labels : [],
              values: Array.isArray(parsedClicks.values) ? parsedClicks.values : [],
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

    function getSecondaryMetric(){
      return metric === "views" ? "clicks" : "views";
    }

    function setActiveBtn(){
      $metricSeg.querySelectorAll("[data-metric]").forEach((btn) => {
        const on = btn.getAttribute("data-metric") === metric;
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    function syncLegend(){
      if (!$legend) return;
      $legend.querySelectorAll("[data-legend-metric]").forEach((item) => {
        const itemMetric = item.getAttribute("data-legend-metric") || "";
        const line = item.querySelector(".chartLegendLine");
        if (!line) return;
        line.classList.toggle("is-dashed", itemMetric !== metric);
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
      const primarySet = getSet();
      const secondarySet = chartSets[getSecondaryMetric()] || { labels: [], values: [] };
      const labels = primarySet.labels || [];
      const primaryValues = primarySet.values || [];
      const secondaryValues = secondarySet.values || [];
      const combinedValues = [...primaryValues, ...secondaryValues];
      const { w, h } = sizeCanvas();
      ctx.clearRect(0, 0, w, h);

      if (!labels.length || !combinedValues.length) {
        ctx.fillStyle = "rgba(15,23,42,.75)";
        ctx.font = "600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.fillText("No monthly venue history yet", 18, 90);
        return;
      }

      const frame = getChartFrame(w, h);
      const scale = getYScale(combinedValues);
      const primaryPoints = labels.map((label, index) => ({
        x: frame.padL + (labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1)) * index),
        y: clamp(frame.padT + frame.gh - ((Number(primaryValues[index] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh),
        value: Number(primaryValues[index] || 0),
        index,
        chartMinY: frame.padT,
        chartMaxY: frame.padT + frame.gh,
      }));
      const secondaryPoints = labels.length === secondaryValues.length
        ? labels.map((label, index) => ({
            x: frame.padL + (labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1)) * index),
            y: clamp(frame.padT + frame.gh - ((Number(secondaryValues[index] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh),
            value: Number(secondaryValues[index] || 0),
            index,
            chartMinY: frame.padT,
            chartMaxY: frame.padT + frame.gh,
          }))
        : [];

      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(15,23,42,.08)";
      ctx.fillStyle = "rgba(71,85,105,.9)";
      ctx.font = "500 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      for (let i = 0; i <= scale.yTicks; i++) {
        const v = i * scale.tickStep;
        const y = frame.padT + frame.gh - (v / scale.yMax) * frame.gh;
        ctx.beginPath();
        ctx.moveTo(frame.padL, y);
        ctx.lineTo(frame.padL + frame.gw, y);
        ctx.stroke();
        ctx.fillText(String(v), 18, y + 4);
      }
      if (primaryPoints.length > 1) {
        const labelStep = primaryPoints.length <= 4 ? 1 : Math.ceil(primaryPoints.length / 4);
        labels.forEach((label, index) => {
          if (index !== primaryPoints.length - 1 && index % labelStep !== 0) return;
          const point = primaryPoints[index];
          ctx.textAlign = index === primaryPoints.length - 1 ? "right" : (index === 0 ? "left" : "center");
          ctx.fillStyle = "rgba(71,85,105,.95)";
          ctx.fillText(String(label || ""), point.x, frame.padT + frame.gh + 30);
        });
      }

      const viewsColor = "rgba(16,185,129,.82)";
      const clicksColor = "rgba(37,99,235,.72)";
      const primaryColor = metric === "views" ? viewsColor : clicksColor;
      const secondaryColor = metric === "views" ? clicksColor : viewsColor;

      if (primaryPoints.length) {
        ctx.save();
        ctx.fillStyle = metric === "views" ? "rgba(16,185,129,.10)" : "rgba(37,99,235,.08)";
        drawSmoothAreaFill(ctx, primaryPoints, frame.padT + frame.gh);
        ctx.restore();
      }

      if (secondaryPoints.length) {
        ctx.save();
        ctx.strokeStyle = secondaryColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        drawSmoothLine(ctx, secondaryPoints);
        ctx.restore();
      }

      ctx.save();
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawSmoothLine(ctx, primaryPoints);
      ctx.restore();

    }

    function getPointIndexFromEvent(ev){
      const set = getSet();
      const values = set.values || [];
      if (!values.length) return -1;
      const rect = $canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const frame = getChartFrame(rect.width, rect.height);
      const points = getLinePoints(frame, values);
      return getNearestPointIndex(points, mx, my, frame);
    }

    function showTip(ev, idx){
      if (!$tip) return;
      const viewsSet = chartSets.views || { labels: [], values: [] };
      const clicksSet = chartSets.clicks || { labels: [], values: [] };
      const labels = viewsSet.labels || clicksSet.labels || [];
      const viewsValue = Number((viewsSet.values || [])[idx] || 0);
      const clicksValue = Number((clicksSet.values || [])[idx] || 0);
      const rect = $canvas.getBoundingClientRect();
      const frame = getChartFrame(rect.width, rect.height);
      const scale = getYScale(viewsSet.values.concat(clicksSet.values));
      const stepX = labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1));
      const pointX = frame.padL + stepX * idx;
      const primaryY = clamp(frame.padT + frame.gh - ((Number((getSet().values || [])[idx] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh);
      const secondaryMetricValues = (chartSets[getSecondaryMetric()] || { values: [] }).values || [];
      const secondaryY = clamp(frame.padT + frame.gh - ((Number(secondaryMetricValues[idx] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh);
      showChartHoverOverlay(hoverOverlay, frame, { x: pointX, y: primaryY }, { x: pointX, y: secondaryY }, {
        primary: metric === "views" ? "rgba(16,185,129,.82)" : "rgba(37,99,235,.72)",
        primaryGlow: metric === "views" ? "rgba(16,185,129,.12)" : "rgba(37,99,235,.10)",
        secondary: metric === "views" ? "rgba(37,99,235,.72)" : "rgba(16,185,129,.82)",
        secondaryGlow: metric === "views" ? "rgba(37,99,235,.10)" : "rgba(16,185,129,.12)",
      });
      showChartTipCard($tip, $wrap, pointX, Math.min(primaryY, secondaryY), renderChartTipHtml(
        "Month: " + String(labels[idx] || ""),
        [
          { label: "Views", value: viewsValue.toLocaleString("en-US"), color: "#0f172a" },
          { label: "Total Clicks", value: clicksValue.toLocaleString("en-US"), color: "#0f172a" },
        ]
      ));
    }

    function hideTip(){
      if ($tip) $tip.style.display = "none";
      hideChartHoverOverlay(hoverOverlay);
    }

    function showSvgFallbackTip(ev, idx){
      if (!$svgHost || !$tip) return;
      const viewsSet = chartSets.views || { labels: [], values: [] };
      const clicksSet = chartSets.clicks || { labels: [], values: [] };
      const labels = viewsSet.labels || clicksSet.labels || [];
      const geometry = getSvgChartHoverGeometry(
        $svgHost,
        labels,
        idx,
        metric === "views" ? (viewsSet.values || []) : (clicksSet.values || []),
        metric === "views" ? (clicksSet.values || []) : (viewsSet.values || [])
      );
      if (!geometry) return;
      const viewsValue = Number((viewsSet.values || [])[idx] || 0);
      const clicksValue = Number((clicksSet.values || [])[idx] || 0);
      showChartHoverOverlay(hoverOverlay, geometry.frame, { x: geometry.pointX, y: geometry.primaryY }, { x: geometry.pointX, y: geometry.secondaryY }, {
        primary: metric === "views" ? "rgba(16,185,129,.82)" : "rgba(37,99,235,.72)",
        primaryGlow: metric === "views" ? "rgba(16,185,129,.12)" : "rgba(37,99,235,.10)",
        secondary: metric === "views" ? "rgba(37,99,235,.72)" : "rgba(16,185,129,.82)",
        secondaryGlow: metric === "views" ? "rgba(37,99,235,.10)" : "rgba(16,185,129,.12)",
      });
      showChartTipCard($tip, $wrap, geometry.pointX, Math.min(geometry.primaryY, geometry.secondaryY), renderChartTipHtml(
        "Month: " + String(labels[idx] || ""),
        [
          { label: "Views", value: viewsValue.toLocaleString("en-US"), color: "#0f172a" },
          { label: "Total Clicks", value: clicksValue.toLocaleString("en-US"), color: "#0f172a" },
        ]
      ));
    }

    function getSvgFallbackIndex(ev){
      if (!$svgHost) return -1;
      const labels = (getSet().labels || []);
      if (!labels.length) return -1;
      const svgEl = $svgHost.querySelector("svg");
      if (!svgEl) return -1;
      const rect = svgEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return -1;
      const padL = rect.width * (56 / 1200);
      const padR = rect.width * (18 / 1200);
      const padT = rect.height * (18 / 260);
      const padB = rect.height * (42 / 260);
      const plotW = rect.width - padL - padR;
      const plotH = rect.height - padT - padB;
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      if (mx < padL || mx > padL + plotW || my < padT || my > padT + plotH) return -1;
      if (labels.length === 1) return 0;
      return Math.max(0, Math.min(Math.round((mx - padL) / (plotW / (labels.length - 1))), labels.length - 1));
    }

    $metricSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-metric]");
      if (!btn) return;
      metric = btn.getAttribute("data-metric") || "views";
      hoverIndex = -1;
      hideTip();
      syncSvgFallback(metric);
      setActiveBtn();
      syncLegend();
      draw();
    });

    $canvas.addEventListener("mousemove", (e) => {
      const idx = getPointIndexFromEvent(e);
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
    if ($svgHost) {
      $svgHost.addEventListener("mousemove", (e) => {
        const idx = getSvgFallbackIndex(e);
        if (idx >= 0) showSvgFallbackTip(e, idx); else hideTip();
      });
      $svgHost.addEventListener("mouseleave", hideTip);
    }

    setActiveBtn();
    syncLegend();
    syncSvgFallback(metric);
    draw();
    window.addEventListener("resize", () => window.requestAnimationFrame(draw));
  }

  function initAdChart(){
    const $data = document.getElementById("adChartData");
    const $canvas = document.getElementById("adChart");
    const $wrap = document.getElementById("adChartWrap");
    const $tip = document.getElementById("adChartTip");
    const $metricSeg = document.getElementById("adChartMetricSeg");
    const $legend = document.getElementById("adChartLegend");
    const $svgHost = document.getElementById("adChartSvgHost");
    const $svgViews = document.getElementById("adChartSvgViews");
    const $svgClicks = document.getElementById("adChartSvgClicks");
    if (!$wrap || !$metricSeg) return;
    const hoverOverlay = ensureChartHoverOverlay($wrap, "ad");

    function syncSvgFallback(nextMetric){
      if (!$svgHost) return;
      const targetMetric = nextMetric === "clicks" ? "clicks" : "views";
      const source = targetMetric === "clicks" ? $svgClicks : $svgViews;
      if (source && source.innerHTML) $svgHost.innerHTML = source.innerHTML;
      $svgHost.setAttribute("data-active-metric", targetMetric);
    }

    const ctx = $canvas ? $canvas.getContext("2d") : null;
    if (!ctx || !$canvas) {
      syncSvgFallback("views");
      return;
    }

    let chartSets = {
      views: { labels: [], values: [] },
      clicks: { labels: [], values: [] },
    };
    try {
      if ($data) {
        const parsed = JSON.parse($data.getAttribute("data-chart") || "{}");
        if (parsed && typeof parsed === "object") {
          const parsedViews = parsed.views || {};
          const parsedClicks = parsed.clicks || {};
          chartSets = {
            views: {
              labels: Array.isArray(parsedViews.labels) ? parsedViews.labels : [],
              values: Array.isArray(parsedViews.values) ? parsedViews.values : [],
            },
            clicks: {
              labels: Array.isArray(parsedClicks.labels) ? parsedClicks.labels : [],
              values: Array.isArray(parsedClicks.values) ? parsedClicks.values : [],
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

    function getSecondaryMetric(){
      return metric === "views" ? "clicks" : "views";
    }

    function setActiveBtn(){
      $metricSeg.querySelectorAll("[data-metric]").forEach((btn) => {
        const on = btn.getAttribute("data-metric") === metric;
        btn.classList.toggle("on", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      });
    }

    function syncLegend(){
      if (!$legend) return;
      $legend.querySelectorAll("[data-legend-metric]").forEach((item) => {
        const itemMetric = item.getAttribute("data-legend-metric") || "";
        const line = item.querySelector(".chartLegendLine");
        if (!line) return;
        line.classList.toggle("is-dashed", itemMetric !== metric);
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
      const primarySet = getSet();
      const secondarySet = chartSets[getSecondaryMetric()] || { labels: [], values: [] };
      const labels = primarySet.labels || [];
      const primaryValues = primarySet.values || [];
      const secondaryValues = secondarySet.values || [];
      const combinedValues = [...primaryValues, ...secondaryValues];
      const out = sizeCanvas();
      const w = out.w;
      const h = out.h;
      ctx.clearRect(0, 0, w, h);

      if (!labels.length || !combinedValues.length) {
        ctx.fillStyle = "rgba(15,23,42,.75)";
        ctx.font = "600 14px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
        ctx.fillText("No monthly ad history yet", 18, 90);
        return;
      }

      const frame = getChartFrame(w, h);
      const scale = getYScale(combinedValues);
      const primaryPoints = labels.map((label, index) => ({
        x: frame.padL + (labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1)) * index),
        y: clamp(frame.padT + frame.gh - ((Number(primaryValues[index] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh),
        value: Number(primaryValues[index] || 0),
        index,
        chartMinY: frame.padT,
        chartMaxY: frame.padT + frame.gh,
      }));
      const secondaryPoints = labels.length === secondaryValues.length
        ? labels.map((label, index) => ({
            x: frame.padL + (labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1)) * index),
            y: clamp(frame.padT + frame.gh - ((Number(secondaryValues[index] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh),
            value: Number(secondaryValues[index] || 0),
            index,
            chartMinY: frame.padT,
            chartMaxY: frame.padT + frame.gh,
          }))
        : [];

      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(15,23,42,.08)";
      ctx.fillStyle = "rgba(71,85,105,.9)";
      ctx.font = "500 12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
      for (let i = 0; i <= scale.yTicks; i++) {
        const v = i * scale.tickStep;
        const y = frame.padT + frame.gh - (v / scale.yMax) * frame.gh;
        ctx.beginPath();
        ctx.moveTo(frame.padL, y);
        ctx.lineTo(frame.padL + frame.gw, y);
        ctx.stroke();
        ctx.fillText(String(v), 18, y + 4);
      }
      if (primaryPoints.length > 1) {
        const labelStep = primaryPoints.length <= 4 ? 1 : Math.ceil(primaryPoints.length / 4);
        labels.forEach((label, index) => {
          if (index !== primaryPoints.length - 1 && index % labelStep !== 0) return;
          const point = primaryPoints[index];
          ctx.textAlign = index === primaryPoints.length - 1 ? "right" : (index === 0 ? "left" : "center");
          ctx.fillStyle = "rgba(71,85,105,.95)";
          ctx.fillText(String(label || ""), point.x, frame.padT + frame.gh + 30);
        });
      }

      const viewsColor = "rgba(16,185,129,.82)";
      const clicksColor = "rgba(37,99,235,.72)";
      const primaryColor = metric === "views" ? viewsColor : clicksColor;
      const secondaryColor = metric === "views" ? clicksColor : viewsColor;

      if (primaryPoints.length) {
        ctx.save();
        ctx.fillStyle = metric === "views" ? "rgba(16,185,129,.10)" : "rgba(37,99,235,.08)";
        drawSmoothAreaFill(ctx, primaryPoints, frame.padT + frame.gh);
        ctx.restore();
      }

      if (secondaryPoints.length) {
        ctx.save();
        ctx.strokeStyle = secondaryColor;
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.lineCap = "round";
        ctx.lineJoin = "round";
        drawSmoothLine(ctx, secondaryPoints);
        ctx.restore();
      }

      ctx.save();
      ctx.strokeStyle = primaryColor;
      ctx.lineWidth = 3;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      drawSmoothLine(ctx, primaryPoints);
      ctx.restore();

    }

    function getPointIndexFromEvent(ev){
      const set = getSet();
      const values = set.values || [];
      if (!values.length) return -1;
      const rect = $canvas.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const frame = getChartFrame(rect.width, rect.height);
      const points = getLinePoints(frame, values);
      return getNearestPointIndex(points, mx, my, frame);
    }

    function showTip(ev, idx){
      if (!$tip) return;
      const viewsSet = chartSets.views || { labels: [], values: [] };
      const clicksSet = chartSets.clicks || { labels: [], values: [] };
      const labels = viewsSet.labels || clicksSet.labels || [];
      const viewsValue = Number((viewsSet.values || [])[idx] || 0);
      const clicksValue = Number((clicksSet.values || [])[idx] || 0);
      const rect = $canvas.getBoundingClientRect();
      const frame = getChartFrame(rect.width, rect.height);
      const scale = getYScale(viewsSet.values.concat(clicksSet.values));
      const stepX = labels.length <= 1 ? 0 : (frame.gw / (labels.length - 1));
      const pointX = frame.padL + stepX * idx;
      const primaryY = clamp(frame.padT + frame.gh - ((Number((getSet().values || [])[idx] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh);
      const secondaryMetricValues = (chartSets[getSecondaryMetric()] || { values: [] }).values || [];
      const secondaryY = clamp(frame.padT + frame.gh - ((Number(secondaryMetricValues[idx] || 0) / scale.yMax) * frame.gh), frame.padT, frame.padT + frame.gh);
      showChartHoverOverlay(hoverOverlay, frame, { x: pointX, y: primaryY }, { x: pointX, y: secondaryY }, {
        primary: metric === "views" ? "rgba(16,185,129,.82)" : "rgba(37,99,235,.72)",
        primaryGlow: metric === "views" ? "rgba(16,185,129,.12)" : "rgba(37,99,235,.10)",
        secondary: metric === "views" ? "rgba(37,99,235,.72)" : "rgba(16,185,129,.82)",
        secondaryGlow: metric === "views" ? "rgba(37,99,235,.10)" : "rgba(16,185,129,.12)",
      });
      showChartTipCard($tip, $wrap, pointX, Math.min(primaryY, secondaryY), renderChartTipHtml(
        "Month: " + String(labels[idx] || ""),
        [
          { label: "Views", value: viewsValue.toLocaleString("en-US"), color: "#0f172a" },
          { label: "Clicks", value: clicksValue.toLocaleString("en-US"), color: "#0f172a" },
        ]
      ));
    }

    function hideTip(){
      if ($tip) $tip.style.display = "none";
      hideChartHoverOverlay(hoverOverlay);
    }

    function showSvgFallbackTip(ev, idx){
      if (!$svgHost || !$tip) return;
      const viewsSet = chartSets.views || { labels: [], values: [] };
      const clicksSet = chartSets.clicks || { labels: [], values: [] };
      const labels = viewsSet.labels || clicksSet.labels || [];
      const geometry = getSvgChartHoverGeometry(
        $svgHost,
        labels,
        idx,
        metric === "views" ? (viewsSet.values || []) : (clicksSet.values || []),
        metric === "views" ? (clicksSet.values || []) : (viewsSet.values || [])
      );
      if (!geometry) return;
      const viewsValue = Number((viewsSet.values || [])[idx] || 0);
      const clicksValue = Number((clicksSet.values || [])[idx] || 0);
      showChartHoverOverlay(hoverOverlay, geometry.frame, { x: geometry.pointX, y: geometry.primaryY }, { x: geometry.pointX, y: geometry.secondaryY }, {
        primary: metric === "views" ? "rgba(16,185,129,.82)" : "rgba(37,99,235,.72)",
        primaryGlow: metric === "views" ? "rgba(16,185,129,.12)" : "rgba(37,99,235,.10)",
        secondary: metric === "views" ? "rgba(37,99,235,.72)" : "rgba(16,185,129,.82)",
        secondaryGlow: metric === "views" ? "rgba(37,99,235,.10)" : "rgba(16,185,129,.12)",
      });
      showChartTipCard($tip, $wrap, geometry.pointX, Math.min(geometry.primaryY, geometry.secondaryY), renderChartTipHtml(
        "Month: " + String(labels[idx] || ""),
        [
          { label: "Views", value: viewsValue.toLocaleString("en-US"), color: "#0f172a" },
          { label: "Clicks", value: clicksValue.toLocaleString("en-US"), color: "#0f172a" },
        ]
      ));
    }

    function getSvgFallbackIndex(ev){
      if (!$svgHost) return -1;
      const labels = (getSet().labels || []);
      if (!labels.length) return -1;
      const svgEl = $svgHost.querySelector("svg");
      if (!svgEl) return -1;
      const rect = svgEl.getBoundingClientRect();
      if (!rect.width || !rect.height) return -1;
      const padL = rect.width * (56 / 1200);
      const padR = rect.width * (18 / 1200);
      const padT = rect.height * (18 / 260);
      const padB = rect.height * (42 / 260);
      const plotW = rect.width - padL - padR;
      const plotH = rect.height - padT - padB;
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      if (mx < padL || mx > padL + plotW || my < padT || my > padT + plotH) return -1;
      if (labels.length === 1) return 0;
      return Math.max(0, Math.min(Math.round((mx - padL) / (plotW / (labels.length - 1))), labels.length - 1));
    }

    $metricSeg.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-metric]");
      if (!btn) return;
      metric = btn.getAttribute("data-metric") || "views";
      hoverIndex = -1;
      hideTip();
      syncSvgFallback(metric);
      setActiveBtn();
      syncLegend();
      draw();
    });

    $canvas.addEventListener("mousemove", (e) => {
      const idx = getPointIndexFromEvent(e);
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
    if ($svgHost) {
      $svgHost.addEventListener("mousemove", (e) => {
        const idx = getSvgFallbackIndex(e);
        if (idx >= 0) showSvgFallbackTip(e, idx); else hideTip();
      });
      $svgHost.addEventListener("mouseleave", hideTip);
    }

    setActiveBtn();
    syncLegend();
    syncSvgFallback(metric);
    draw();
    window.addEventListener("resize", () => window.requestAnimationFrame(draw));
  }

  initEventsChart();
  initOrganizerChart();
  initVenueChart();
  initAdChart();

  (function initHeaderAccountMenu(){
    var menu = document.querySelector('[data-account-menu]');
    if (!menu) return;
    var trigger = menu.querySelector('[data-account-trigger]');
    var dropdown = menu.querySelector('[data-account-dropdown]');
    if (!trigger || !dropdown) return;

    function setOpen(next){
      menu.classList.toggle('is-open', !!next);
      trigger.setAttribute('aria-expanded', next ? 'true' : 'false');
    }

    trigger.addEventListener('click', function(event){
      event.preventDefault();
      event.stopPropagation();
      setOpen(!menu.classList.contains('is-open'));
    });

    document.addEventListener('click', function(event){
      if (!menu.contains(event.target)) setOpen(false);
    });

    document.addEventListener('keydown', function(event){
      if (event.key === 'Escape') setOpen(false);
    });
  })();
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
router.get("/events-organizers", async (req, res) => renderAdmin(req, res, "events-organizers"));
router.get("/create-events", async (req, res) => renderAdmin(req, res, "create"));
router.get("/approve-events", async (req, res) => renderAdmin(req, res, "approve"));
router.get("/upload-events", async (req, res) => renderAdmin(req, res, "upload-events"));
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
router.get("/messages", async (req, res) => renderAdmin(req, res, "messages"));
router.get("/preferences", async (req, res) => renderAdmin(req, res, "preferences"));
router.get("/updates-log", async (req, res) => renderAdmin(req, res, "updates-log"));
router.get("/invites", async (req, res) => renderAdmin(req, res, "invites"));
router.get("/users", async (req, res) => renderAdmin(req, res, "users"));
router.get("/pending-count", async (req, res) => {
  try {
    await ensureMessageSchema();
    await ensureUserProfileSchema();
    const city = String(req.query.city || "Enumclaw");
    const row = await get("SELECT COUNT(*) AS n FROM pending_events WHERE city = ?", [city]);
    const currentUser = await resolveSessionUser(req);
    let messages = 0;
    if (currentUser?.id) {
      const messageRow = await get(
        "SELECT COUNT(*) AS count FROM messages WHERE recipientUserId = ? AND city = ? AND readAt IS NULL",
        [currentUser.id, city]
      );
      messages = Number(messageRow?.count || 0);
    }
    return res.json({ ok: true, count: Number(row?.n || 0), messages });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, count: 0, messages: 0 });
  }
});

router.post("/messages", async (req, res) => {
  try {
    await ensureMessageSchema();
    await ensureUserProfileSchema();
    const currentUser = await resolveSessionUser(req);
    const supportCircleUser = await resolveSupportCircleUser();
    if (!currentUser?.id) return res.status(403).send("Forbidden");

    const requestedCity = String(req.body?.city || req.query.city || currentUser.city || "Enumclaw").trim() || "Enumclaw";
    const city = pickAccessibleCity(requestedCity, hasDeveloperAccessRole(req.user?.role || "") ? { role: "developer" } : currentUser, { fallbackCity: currentUser.city || "Enumclaw" });
    const recipientUserId = parseInt(String(req.body?.recipientUserId || ""), 10);
    const body = String(req.body?.body || "").trim().slice(0, 4000);

    if (!Number.isInteger(recipientUserId) || recipientUserId <= 0 || recipientUserId === Number(currentUser.id)) {
      return res.redirect(`/admin/messages?notice=recipient${city ? `&city=${encodeURIComponent(city)}` : ""}`);
    }
    if (!body) {
      return res.redirect(`/admin/messages?notice=empty${city ? `&city=${encodeURIComponent(city)}` : ""}${Number.isInteger(recipientUserId) ? `&user=${encodeURIComponent(String(recipientUserId))}` : ""}`);
    }

    const recipient = await get(
      "SELECT id, city, permissionsJson FROM users WHERE id = ? LIMIT 1",
      [recipientUserId]
    );
    const isSupportCircleRecipient = supportCircleUser?.id && Number(supportCircleUser.id) === Number(recipientUserId);
    if (!recipient?.id || (!isSupportCircleRecipient && !getUserAllowedCities(recipient, recipient.city || "Enumclaw").includes(city))) {
      return res.redirect(`/admin/messages?notice=recipient${city ? `&city=${encodeURIComponent(city)}` : ""}`);
    }

    await run(
      "INSERT INTO messages (city, senderUserId, recipientUserId, body, createdAt) VALUES (?, ?, ?, ?, datetime('now'))",
      [city, currentUser.id, recipientUserId, body]
    );
    try {
      await run(
        `INSERT INTO message_typing_status (city, senderUserId, recipientUserId, isTyping, updatedAt)
         VALUES (?, ?, ?, 0, datetime('now'))
         ON CONFLICT(city, senderUserId, recipientUserId)
         DO UPDATE SET isTyping = 0, updatedAt = datetime('now')`,
        [city, currentUser.id, recipientUserId]
      );
    } catch (_) {}
    return res.redirect(`/admin/messages?notice=sent&user=${encodeURIComponent(String(recipientUserId))}${city ? `&city=${encodeURIComponent(city)}` : ""}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to send message.");
  }
});

router.get("/messages/typing", async (req, res) => {
  try {
    await ensureMessageSchema();
    await ensureUserProfileSchema();
    const currentUser = await resolveSessionUser(req);
    const supportCircleUser = await resolveSupportCircleUser();
    if (!currentUser?.id) return res.status(403).json({ ok: false, typing: false });

    const requestedCity = String(req.query?.city || currentUser.city || "Enumclaw").trim() || "Enumclaw";
    const city = pickAccessibleCity(requestedCity, hasDeveloperAccessRole(req.user?.role || "") ? { role: "developer" } : currentUser, { fallbackCity: currentUser.city || "Enumclaw" });
    const otherUserId = parseInt(String(req.query?.user || ""), 10);
    if (!Number.isInteger(otherUserId) || otherUserId <= 0) {
      return res.json({ ok: true, typing: false });
    }

    const otherUser = await get(
      "SELECT id, city, permissionsJson, displayName, username, email FROM users WHERE id = ? LIMIT 1",
      [otherUserId]
    );
    const isSupportCircleUser = supportCircleUser?.id && Number(supportCircleUser.id) === Number(otherUserId);
    if (!otherUser?.id || (!isSupportCircleUser && !getUserAllowedCities(otherUser, otherUser.city || "Enumclaw").includes(city))) {
      return res.json({ ok: true, typing: false });
    }

    const row = await get(
      `SELECT isTyping, updatedAt
         FROM message_typing_status
        WHERE city = ?
          AND senderUserId = ?
          AND recipientUserId = ?
        LIMIT 1`,
      [city, otherUserId, currentUser.id]
    );
    const updatedMs = Date.parse(String(row?.updatedAt || ""));
    const isFresh = Number.isFinite(updatedMs) && (Date.now() - updatedMs) <= 8000;
    const typing = Number(row?.isTyping || 0) === 1 && isFresh;
    const name = isSupportCircleUser
      ? "Support Circle"
      : String(otherUser.displayName || otherUser.username || otherUser.email || "User");
    return res.json({ ok: true, typing, name });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, typing: false });
  }
});

router.post("/messages/typing", express.json(), async (req, res) => {
  try {
    await ensureMessageSchema();
    await ensureUserProfileSchema();
    const currentUser = await resolveSessionUser(req);
    const supportCircleUser = await resolveSupportCircleUser();
    if (!currentUser?.id) return res.status(403).json({ ok: false });

    const requestedCity = String(req.body?.city || req.query?.city || currentUser.city || "Enumclaw").trim() || "Enumclaw";
    const city = pickAccessibleCity(requestedCity, hasDeveloperAccessRole(req.user?.role || "") ? { role: "developer" } : currentUser, { fallbackCity: currentUser.city || "Enumclaw" });
    const recipientUserId = parseInt(String(req.body?.recipientUserId || ""), 10);
    const active = String(req.body?.active || "0") === "1" ? 1 : 0;
    if (!Number.isInteger(recipientUserId) || recipientUserId <= 0 || recipientUserId === Number(currentUser.id)) {
      return res.status(400).json({ ok: false });
    }

    const recipient = await get(
      "SELECT id, city, permissionsJson FROM users WHERE id = ? LIMIT 1",
      [recipientUserId]
    );
    const isSupportCircleRecipient = supportCircleUser?.id && Number(supportCircleUser.id) === Number(recipientUserId);
    if (!recipient?.id || (!isSupportCircleRecipient && !getUserAllowedCities(recipient, recipient.city || "Enumclaw").includes(city))) {
      return res.status(400).json({ ok: false });
    }

    await run(
      `INSERT INTO message_typing_status (city, senderUserId, recipientUserId, isTyping, updatedAt)
       VALUES (?, ?, ?, ?, datetime('now'))
       ON CONFLICT(city, senderUserId, recipientUserId)
       DO UPDATE SET isTyping = excluded.isTyping, updatedAt = datetime('now')`,
      [city, currentUser.id, recipientUserId, active]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false });
  }
});

// Create invite (developer / area manager)
router.post("/invites", async (req, res) => {
  try {
    const userRole = normalizeRoleValue(req.user?.role || "organizer");
    if (!hasDeveloperAccessRole(userRole)) return res.status(403).send("Forbidden");
    const sessionUser = await resolveSessionUser(req);
    const email = String(req.body?.email || "").trim().toLowerCase() || null;
    const role = normalizeRoleValue(req.body?.role || "organizer");
    const city = String(req.body?.city || req.query.city || "Enumclaw");
    const days = Math.max(1, Math.min(30, parseInt(req.body?.days || "7", 10)));
    if (!isLiveRole(role)) {
      return res.status(400).send("Invalid role.");
    }
    const token = crypto.randomBytes(20).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
    const permissionsJson = role === "organizer"
      ? stringifyOrganizerPermissions({ ...DEFAULT_ORGANIZER_PERMISSIONS, cityAccess: [city] })
      : null;
    await run(
      "INSERT INTO invites (email, tokenHash, role, city, permissionsJson, expiresAt, createdByUserId) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [email, tokenHash, role, city, permissionsJson, expiresAt, sessionUser?.id || null]
    );
    return res.redirect(`/admin/invites?invite=${encodeURIComponent(token)}&city=${encodeURIComponent(city)}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to create invite.");
  }
});

router.post("/preferences", upload.single("profilePhoto"), async (req, res) => {
  try {
    const role = normalizeRoleValue(req.user?.role || "organizer");
    if (!(hasDeveloperAccessRole(role) || role === "organizer")) {
      return res.status(403).send("Forbidden");
    }
    const u = await resolveSessionUser(req);
    if (!u?.id) return res.redirect("/admin/preferences?notice=user_not_found");

    const displayName = String(req.body?.displayName || "").trim().slice(0, 120);
    const phone = String(req.body?.phone || "").trim().slice(0, 40);
    const bio = String(req.body?.bio || "").trim().slice(0, 3000);
    let photoUrl = normalizeHttpUrl(req.body?.photoUrl || "");

    if (req.file) {
      photoUrl = await persistUploadedImage(req.file, req);
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

router.post("/preferences/status", async (req, res) => {
  try {
    const role = normalizeRoleValue(req.user?.role || "organizer");
    if (!(hasDeveloperAccessRole(role) || role === "organizer")) {
      return res.status(403).send("Forbidden");
    }
    const u = await resolveSessionUser(req);
    const redirectTo = safeAdminRedirectPath(req.body?.redirectTo || req.get("referer") || "/admin/preferences", "/admin/preferences");
    if (!u?.id) return res.redirect("/admin/preferences?notice=user_not_found");

    const presenceStatus = normalizePresenceStatus(req.body?.status);
    await run(
      "UPDATE users SET presenceStatus = ?, updatedAt = datetime('now') WHERE id = ?",
      [presenceStatus, u.id]
    );
    const separator = redirectTo.includes("?") ? "&" : "?";
    return res.redirect(`${redirectTo}${separator}notice=status_saved`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to update status.");
  }
});

router.post("/preferences/password", async (req, res) => {
  try {
    const role = normalizeRoleValue(req.user?.role || "organizer");
    if (!(hasDeveloperAccessRole(role) || role === "organizer")) {
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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    if (!hasDeveloperAccessRole(role)) return res.status(403).send("Forbidden");
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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    if (!hasDeveloperAccessRole(role)) return res.status(403).send("Forbidden");
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.redirect("/admin/users");
    const newRole = normalizeRoleValue(req.body?.role || "organizer");
    if (!isLiveRole(newRole)) {
      return res.redirect("/admin/users");
    }
    const requestedCitiesRaw = Array.isArray(req.body?.cities)
      ? req.body.cities
      : (req.body?.cities !== undefined ? [req.body.cities] : []);
    const requestedCities = normalizeCityAccessList(requestedCitiesRaw, req.body?.city || "Enumclaw");
    if (!requestedCities.length) {
      return res.redirect("/admin/users?notice=city_required");
    }
    const newCity = requestedCities[0];
    const emailRaw = String(req.body?.email || "").trim().toLowerCase();
    const newEmail = emailRaw || null;
    if (newEmail) {
      const emailTaken = await get(
        "SELECT id FROM users WHERE lower(COALESCE(email,'')) = lower(?) AND id != ? LIMIT 1",
        [newEmail, id]
      );
      if (emailTaken?.id) {
        return res.redirect("/admin/users?notice=email_taken");
      }
    }
    const existingUser = await get("SELECT id, permissionsJson FROM users WHERE id = ? LIMIT 1", [id]);
    if (!existingUser?.id) {
      return res.redirect("/admin/users");
    }
    const permissionsJson = stringifyOrganizerPermissions({
      ...(parsePermissionsObject(existingUser?.permissionsJson) || {}),
      ...(newRole === "organizer"
        ? {
            ...normalizeOrganizerPermissions(existingUser?.permissionsJson, DEFAULT_ORGANIZER_PERMISSIONS),
            events: isCheckedValue(req.body?.perm_events),
            venues: isCheckedValue(req.body?.perm_venues),
            jobs: isCheckedValue(req.body?.perm_jobs),
            ads: isCheckedValue(req.body?.perm_ads),
            featureEvents: isCheckedValue(req.body?.perm_featureEvents),
          }
        : normalizeOrganizerPermissions(existingUser?.permissionsJson, DEFAULT_ORGANIZER_PERMISSIONS)),
      cityAccess: requestedCities,
    }, DEFAULT_ORGANIZER_PERMISSIONS);
    await run("UPDATE users SET email = ?, role = ?, city = ?, permissionsJson = ?, updatedAt = datetime('now') WHERE id = ?", [newEmail, newRole, newCity, permissionsJson, id]);
    return res.redirect("/admin/users?notice=saved");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to update user.");
  }
});

router.post("/users/:id/delete", async (req, res) => {
  try {
    const role = normalizeRoleValue(req.user?.role || "organizer");
    if (!hasDeveloperAccessRole(role)) return res.status(403).send("Forbidden");
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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    if (!hasDeveloperAccessRole(role)) return res.status(403).send("Forbidden");
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
    try { await sendEmail({ to: u.email, subject, text, html, from: PASSWORD_RESET_FROM, replyTo: PASSWORD_RESET_REPLY_TO }); } catch (_) {}
    return res.redirect("/admin/users");
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to send reset.");
  }
});

router.post("/users/:id/resend-invite", async (req, res) => {
  try {
    const role = normalizeRoleValue(req.user?.role || "organizer");
    if (!hasDeveloperAccessRole(role)) return res.status(403).send("Forbidden");
    const sessionUser = await resolveSessionUser(req);
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.redirect("/admin/users");

    const u = await get("SELECT id, email, role, city, permissionsJson FROM users WHERE id = ?", [id]);
    if (!u || !u.email) return res.redirect("/admin/users?notice=no_email");

    const token = crypto.randomBytes(20).toString("hex");
    const tokenHash = hashToken(token);
    const exp = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const normalizedInviteRole = normalizeRoleValue(u.role || "organizer");
    await run(
      "INSERT INTO invites (email, tokenHash, role, city, permissionsJson, expiresAt, createdByUserId) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [
        u.email,
        tokenHash,
        normalizedInviteRole,
        u.city || "Enumclaw",
        normalizedInviteRole === "organizer"
          ? stringifyOrganizerPermissions({
              ...(parsePermissionsObject(u.permissionsJson) || {}),
              ...normalizeOrganizerPermissions(u.permissionsJson, DEFAULT_ORGANIZER_PERMISSIONS),
              cityAccess: getUserAllowedCities(u, u.city || "Enumclaw"),
            }, DEFAULT_ORGANIZER_PERMISSIONS)
          : null,
        exp,
        sessionUser?.id || null
      ]
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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    const sessionUser = await resolveSessionUser(req);
    const isOrganizerUser = role === "organizer";
    const sectionPermissions = getUserSectionPermissions(sessionUser || { role });
    if (!(hasDeveloperAccessRole(role) || sectionPermissions.venues)) {
      return res.status(403).send("Forbidden");
    }
    await ensureVenueSchema();

    const idRaw = String(req.body?.id || "").trim();
    const id = idRaw ? parseInt(idRaw, 10) : null;
    const isUpdate = Number.isInteger(id) && id > 0;

    const userCity = String(req.user?.city || sessionUser?.city || "Enumclaw");
    const city = pickAccessibleCity(req.body?.city || req.query.city, hasDeveloperAccessRole(role) ? { role: "developer" } : sessionUser, { fallbackCity: userCity });

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
      imageUrl = await persistUploadedImage(primaryFile, req);
    }

    if (galleryFiles.length) {
      const uploaded = [];
      for (const f of galleryFiles.slice(0, 3)) {
        const uploadedUrl = await persistUploadedImage(f, req);
        if (uploadedUrl) uploaded.push(uploadedUrl);
      }
      galleryImages = normalizeGalleryImages([...(galleryImages || []), ...uploaded], 3);
    }

    const galleryJson = JSON.stringify(galleryImages);

    if (!name) return res.status(400).send("Venue name is required.");

    const baseSlug = slugify(name);
    const slug = await ensureUniqueVenueSlug(baseSlug, isUpdate ? id : null);

    if (isUpdate) {
      const existingVenue = await get("SELECT id, createdByUserId FROM venues WHERE id = ? LIMIT 1", [id]);
      if (!existingVenue?.id) return res.status(404).send("Venue not found.");
      if (isOrganizerUser && Number(existingVenue.createdByUserId || 0) !== Number(sessionUser?.id || 0)) {
        return res.status(403).send("Forbidden");
      }
      await run(
        `UPDATE venues
            SET city = ?, slug = ?, name = ?, address = ?, website = ?, phone = ?, imageUrl = ?, galleryJson = ?, categoriesJson = ?, socialJson = ?, hoursJson = ?, seoTitle = ?, metaDescription = ?, focusKeyphrase = ?, imageAlt = ?, description = ?, createdByUserId = COALESCE(createdByUserId, ?), updatedAt = datetime('now')
          WHERE id = ?`,
        [city, slug, name, address || null, website || null, phone || null, imageUrl || null, galleryJson, categoriesJson, socialJson, hoursJson, seoTitle, metaDescription, focusKeyphrase, imageAlt, description || null, sessionUser?.id || null, id]
      );
    } else {
      await run(
        `INSERT INTO venues (city, slug, name, address, website, phone, imageUrl, galleryJson, categoriesJson, socialJson, hoursJson, seoTitle, metaDescription, focusKeyphrase, imageAlt, description, createdByUserId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [city, slug, name, address || null, website || null, phone || null, imageUrl || null, galleryJson, categoriesJson, socialJson, hoursJson, seoTitle, metaDescription, focusKeyphrase, imageAlt, description || null, sessionUser?.id || null]
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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    const sessionUser = await resolveSessionUser(req);
    const isOrganizerUser = role === "organizer";
    const sectionPermissions = getUserSectionPermissions(sessionUser || { role });
    if (!(hasDeveloperAccessRole(role) || sectionPermissions.venues)) {
      return res.status(403).send("Forbidden");
    }
    await ensureVenueSchema();

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    const existingVenue = await get("SELECT id, createdByUserId FROM venues WHERE id = ? LIMIT 1", [id]);
    if (!existingVenue?.id) return res.status(404).send("Venue not found.");
    if (isOrganizerUser && Number(existingVenue.createdByUserId || 0) !== Number(sessionUser?.id || 0)) {
      return res.status(403).send("Forbidden");
    }

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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    const sessionUser = await resolveSessionUser(req);
    const isOrganizerUser = role === "organizer";
    const sectionPermissions = getUserSectionPermissions(sessionUser || { role });
    if (!(hasDeveloperAccessRole(role) || sectionPermissions.jobs)) {
      return res.status(403).send("Forbidden");
    }
    await ensureJobSchema();

    const idRaw = String(req.body?.id || "").trim();
    const id = idRaw ? parseInt(idRaw, 10) : null;
    const isUpdate = Number.isInteger(id) && id > 0;

    const userCity = String(req.user?.city || sessionUser?.city || "Enumclaw");
    const city = pickAccessibleCity(req.body?.city || req.query.city, hasDeveloperAccessRole(role) ? { role: "developer" } : sessionUser, { fallbackCity: userCity });

    const title = String(req.body?.title || "").trim();
    const company = String(req.body?.company || "").trim();
    const location = String(req.body?.location || "").trim();
    const employmentTypesRaw = Array.isArray(req.body?.employmentTypes)
      ? req.body.employmentTypes
      : (req.body?.employmentTypes ? [req.body.employmentTypes] : []);
    const employmentTypes = normalizeJobEmploymentTypes(employmentTypesRaw);
    const employmentType = formatEmploymentTypeDisplay(employmentTypes);
    const employmentTypesJson = JSON.stringify(employmentTypes);
    const salaryRange = String(req.body?.salaryRange || "").trim();
    const applicationMode = normalizeJobApplicationMode(req.body?.applicationMode || "external");
    const applyUrl = normalizeHttpUrl(req.body?.applyUrl || "");
    const description = String(req.body?.description || "").trim();
    const seoTitle = String(req.body?.seoTitle || "").trim();
    const metaDescription = String(req.body?.metaDescription || "").trim();
    const focusKeyphrase = String(req.body?.focusKeyphrase || "").trim();
    const imageAlt = String(req.body?.imageAlt || "").trim();
    const statusRaw = String(req.body?.status || "active").trim().toLowerCase();
    const status = ["active", "paused", "filled"].includes(statusRaw) ? statusRaw : "active";
    const applicationFields = normalizeJobApplicationFields(
      Object.fromEntries(JOB_APPLICATION_FIELDS.map((field) => [field.key, req.body?.[`applicationField_${field.key}`]]))
    );
    const applicationFieldsJson = JSON.stringify(applicationFields);
    let imageUrl = String(req.body?.imageUrl || "").trim();

    if (!title) return res.status(400).send("Job title is required.");
    if (!employmentTypes.length) return res.status(400).send("Select at least one hiring type.");
    if ((applicationMode === "external" || applicationMode === "both") && !applyUrl) {
      return res.status(400).send("Apply URL is required for jobs with an external application link.");
    }

    const imageFile = req.file || null;
    if (imageFile) {
      imageUrl = await persistUploadedImage(imageFile, req);
    }

    const autoSeoFields = buildBasicJobSeoFields({ title, company, location, description });

    const baseSlug = slugify(`${title}-${company}`);
    const slug = await ensureUniqueJobSlug(baseSlug, isUpdate ? id : null);

    if (isUpdate) {
      const existingJob = await get("SELECT id, createdByUserId FROM jobs WHERE id = ? LIMIT 1", [id]);
      if (!existingJob?.id) return res.status(404).send("Job not found.");
      if (isOrganizerUser && Number(existingJob.createdByUserId || 0) !== Number(sessionUser?.id || 0)) {
        return res.status(403).send("Forbidden");
      }
      await run(
        `UPDATE jobs
            SET city = ?, slug = ?, title = ?, company = ?, location = ?, employmentType = ?, employmentTypesJson = ?, salaryRange = ?, applyUrl = ?, imageUrl = ?, description = ?, seoTitle = ?, metaDescription = ?, focusKeyphrase = ?, imageAlt = ?, status = ?, applicationMode = ?, applicationFieldsJson = ?, createdByUserId = COALESCE(createdByUserId, ?), updatedAt = datetime('now')
          WHERE id = ?`,
        [city, slug, title, company || null, location || null, employmentType || null, employmentTypesJson, salaryRange || null, applyUrl || null, imageUrl || null, description || null, resolveSeoFieldValue(seoTitle, autoSeoFields?.seoTitle), resolveSeoFieldValue(metaDescription, autoSeoFields?.metaDescription), resolveSeoFieldValue(focusKeyphrase, autoSeoFields?.focusKeyphrase), resolveSeoFieldValue(imageAlt, autoSeoFields?.imageAlt), status, applicationMode, applicationFieldsJson, sessionUser?.id || null, id]
      );
    } else {
      await run(
        `INSERT INTO jobs (city, slug, title, company, location, employmentType, employmentTypesJson, salaryRange, applyUrl, imageUrl, description, seoTitle, metaDescription, focusKeyphrase, imageAlt, status, applicationMode, applicationFieldsJson, createdByUserId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [city, slug, title, company || null, location || null, employmentType || null, employmentTypesJson, salaryRange || null, applyUrl || null, imageUrl || null, description || null, resolveSeoFieldValue(seoTitle, autoSeoFields?.seoTitle), resolveSeoFieldValue(metaDescription, autoSeoFields?.metaDescription), resolveSeoFieldValue(focusKeyphrase, autoSeoFields?.focusKeyphrase), resolveSeoFieldValue(imageAlt, autoSeoFields?.imageAlt), status, applicationMode, applicationFieldsJson, sessionUser?.id || null]
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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    const sessionUser = await resolveSessionUser(req);
    const isOrganizerUser = role === "organizer";
    const sectionPermissions = getUserSectionPermissions(sessionUser || { role });
    if (!(hasDeveloperAccessRole(role) || sectionPermissions.jobs)) {
      return res.status(403).send("Forbidden");
    }
    await ensureJobSchema();

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");

    const existingJob = await get("SELECT id, createdByUserId FROM jobs WHERE id = ? LIMIT 1", [id]);
    if (!existingJob?.id) return res.status(404).send("Job not found.");
    if (isOrganizerUser && Number(existingJob.createdByUserId || 0) !== Number(sessionUser?.id || 0)) {
      return res.status(403).send("Forbidden");
    }

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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    const sessionUser = await resolveSessionUser(req);
    const sectionPermissions = getUserSectionPermissions(sessionUser || { role });
    if (!(hasDeveloperAccessRole(role) || sectionPermissions.ads)) {
      return res.status(403).send("Forbidden");
    }
    await ensureAdSchema();

    const idRaw = String(req.body?.id || "").trim();
    const id = idRaw ? parseInt(idRaw, 10) : null;
    const isUpdate = Number.isInteger(id) && id > 0;

    const userCity = String(req.user?.city || sessionUser?.city || "Enumclaw");
    const city = pickAccessibleCity(req.body?.city || req.query.city, hasDeveloperAccessRole(role) ? { role: "developer" } : sessionUser, { fallbackCity: userCity });

    const name = String(req.body?.name || "").trim();
    const placements = normalizeAdPlacements(req.body?.placements, String(req.body?.placement || "").trim());
    const placement = placements[0] || "homepage-top";
    const placementsJson = JSON.stringify(placements);
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
      imageUrl = await persistUploadedImage(imageFile, req);
    }

    const baseSlug = slugify(`${name}-${placement}`);
    const slug = await ensureUniqueAdSlug(baseSlug, isUpdate ? id : null);

    if (isUpdate) {
      await run(
        `UPDATE ads
            SET city = ?, slug = ?, name = ?, placement = ?, placementsJson = ?, imageUrl = ?, targetUrl = ?, altText = ?, visibilityPercent = ?, status = ?, startsAt = ?, endsAt = ?, notes = ?, createdByUserId = COALESCE(createdByUserId, ?), updatedAt = datetime('now')
          WHERE id = ?`,
        [city, slug, name, placement, placementsJson, imageUrl || null, targetUrl || null, altText || null, visibilityPercent, status, startsAt, endsAt, notes || null, sessionUser?.id || null, id]
      );
    } else {
      await run(
        `INSERT INTO ads (city, slug, name, placement, placementsJson, imageUrl, targetUrl, altText, visibilityPercent, status, startsAt, endsAt, notes, createdByUserId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [city, slug, name, placement, placementsJson, imageUrl || null, targetUrl || null, altText || null, visibilityPercent, status, startsAt, endsAt, notes || null, sessionUser?.id || null]
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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    const sessionUser = await resolveSessionUser(req);
    const sectionPermissions = getUserSectionPermissions(sessionUser || { role });
    if (!(hasDeveloperAccessRole(role) || sectionPermissions.ads)) {
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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    const sessionUser = await resolveSessionUser(req);
    const sectionPermissions = getUserSectionPermissions(sessionUser || { role });
    if (!(hasDeveloperAccessRole(role) || sectionPermissions.events)) {
      return res.status(403).send("Forbidden");
    }
    await ensurePickSchema();
    const organizerAccessValues = role === "organizer" ? getOrganizerAccessValues(sessionUser, req) : [];
    const organizerPrimaryName = role === "organizer" ? getOrganizerPrimaryName(sessionUser, req) : "";
    if (role === "organizer" && !organizerPrimaryName) {
      return res.status(400).send("Organizer account is missing an organizer identity.");
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

    city = pickAccessibleCity(city || req.query.city, hasDeveloperAccessRole(role) ? { role: "developer" } : sessionUser, { fallbackCity: req.user?.city || sessionUser?.city || "Enumclaw" });

    if (role === "organizer") {
      organizer = organizerPrimaryName;
    }

    // If a file was uploaded, prefer it over the URL field
    if (req.file) {
      imageUrl = await persistUploadedImage(req.file, req);
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
    if (!organizer) missing.push("organizer");
    if (missing.length) {
      return res.status(400).send("Missing required fields: " + missing.join(", "));
    }

    const eventId = id ? parseInt(String(id), 10) : null;
    if (role === "organizer" && Number.isInteger(eventId) && eventId > 0) {
      const existingEvent = await get("SELECT id, organizer FROM events WHERE id = ? LIMIT 1", [eventId]);
      if (!existingEvent?.id || !organizerOwnsEvent(existingEvent, organizerAccessValues)) {
        return res.status(403).send("Forbidden");
      }
    }

    if (ticketUrl && !/^https?:\/\//i.test(ticketUrl)) {
      return res.status(400).send("Ticket link must start with http:// or https://");
    }

    const finalTicketLabel =
      ticketLabel && String(ticketLabel).trim() ? String(ticketLabel).trim() : "Tickets";

    const autoSeoFields = role === "organizer"
      ? buildBasicEventSeoFields({ title, description, location, organizer })
      : null;

    const startMs = Date.parse(startDateTime);
    const endMs = Date.parse(endDateTime);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
      return res.status(400).send("Invalid date/time.");
    }
    if (endMs <= startMs) {
      return res.status(400).send("End time must be after start time.");
    }

    const canFeatureEvents = hasDeveloperAccessRole(role) || !!sectionPermissions.featureEvents;
    const canCurateEventPromotions = hasDeveloperAccessRole(role);
    const featuredFlag = canFeatureEvents ? (String(featured || "") === "1" ? 1 : 0) : 0;
    const eddiesPickFlag = canCurateEventPromotions ? (String(eddiesPick || "") === "1" ? 1 : 0) : 0;

    // Slug
    const rawSlug = String(req.body.slug || "").trim();
    const baseSlug = rawSlug ? slugify(rawSlug) : slugify(title);
    const slug = await ensureUniqueSlug(baseSlug, id ? Number(id) : null);

    // Categories (max 3, from allow-list)
    const cats = normalizeCategories(categories);
    const catsJson = JSON.stringify(cats);

    // ---- Recurrence normalize ----
    const eventTypeChoice = String(req.body?.eventTypeChoice || "").trim().toLowerCase();
    let multiDayScheduleJson = null;
    if (eventTypeChoice === "multi-day") {
      const parsedMultiDaySchedule = normalizeMultiDaySchedule(req.body?.multiDayScheduleJson);
      multiDayScheduleJson = parsedMultiDaySchedule.length ? JSON.stringify(parsedMultiDaySchedule) : null;
    }

    const hasRec = String(hasRecurrence || "") === "1" ? 1 : 0;
    const t = String(recurrenceType || "none").toLowerCase();
    const submittedRecurringStartDate = toDateValue(startDateTime);
    const submittedRecurringEndDate = toDateValue(endDateTime);

    const forceDuplicateSave = String(req.body?.forceDuplicateSave || "") === "1";
    if (!forceDuplicateSave) {
      const duplicateMatches = await findAdminEventDuplicateMatches({
        city,
        title,
        startDateTime,
        endDateTime,
        location,
        organizer,
        ticketUrl,
        eventLink: req.body?.eventLink || "",
        excludeEventId: id ? Number(id) : null,
        excludePendingId: pendingId ? parseInt(String(pendingId), 10) : null,
      });
      if (duplicateMatches.length) {
        return res.status(409).send(buildAdminDuplicateResponse({
          title,
          startDateTime,
          location,
        }, duplicateMatches, {
          ...req.body,
          id,
          pendingId,
          city,
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
          ticketLabel: finalTicketLabel,
          seoTitle: resolveSeoFieldValue(seoTitle, autoSeoFields?.seoTitle),
          metaDescription: resolveSeoFieldValue(metaDescription, autoSeoFields?.metaDescription),
          focusKeyphrase: resolveSeoFieldValue(focusKeyphrase, autoSeoFields?.focusKeyphrase),
          imageAlt: resolveSeoFieldValue(imageAlt, autoSeoFields?.imageAlt),
          categories: Array.isArray(categories) ? categories : normalizeCategories(categories),
          featured: featuredFlag ? "1" : "0",
          eddiesPick: eddiesPickFlag ? "1" : "0",
          hasRecurrence: hasRec ? "1" : "0",
          recurrenceType: t,
          recurrenceInterval,
          weeklyByDay,
          monthlyMode,
          byMonthday,
          setPos,
          monthlyByDay,
          recurrenceStartDate,
          recurrenceUntilDate,
          recurrenceDates,
          multiDayScheduleJson,
          startDateTimeISO: startDateTime,
          endDateTimeISO: endDateTime,
          eventTypeChoice,
        }));
      }
    }

    let recurrenceRule = null;
    let recurrenceDatesJson = null;

    if (hasRec && t !== "none") {
      recurrenceStartDate = submittedRecurringStartDate || recurrenceStartDate;
      recurrenceUntilDate = submittedRecurringEndDate || recurrenceUntilDate;

      const recurringStartParts = parseIsoParts(startDateTime);
      const recurringEndParts = parseIsoParts(endDateTime);
      const recurringStartUtc = Date.parse(startDateTime);
      if (recurringStartParts && recurringEndParts && Number.isFinite(recurringStartUtc)) {
        let occurrenceEndParts = {
          year: recurringStartParts.year,
          month: recurringStartParts.month,
          day: recurringStartParts.day,
          hour: recurringEndParts.hour,
          minute: recurringEndParts.minute,
          second: recurringEndParts.second,
          offset: recurringStartParts.offset,
        };
        let occurrenceEndUtc = partsToUtcMs(occurrenceEndParts);
        if (occurrenceEndUtc <= recurringStartUtc) {
          const rollover = new Date(Date.UTC(
            occurrenceEndParts.year,
            occurrenceEndParts.month - 1,
            occurrenceEndParts.day,
            occurrenceEndParts.hour,
            occurrenceEndParts.minute,
            occurrenceEndParts.second || 0
          ));
          rollover.setUTCDate(rollover.getUTCDate() + 1);
          occurrenceEndParts = {
            ...occurrenceEndParts,
            year: rollover.getUTCFullYear(),
            month: rollover.getUTCMonth() + 1,
            day: rollover.getUTCDate(),
          };
        }
        endDateTime = partsToIso(occurrenceEndParts);
      }

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

    const recurrenceRuleJson = recurrenceRule ? JSON.stringify(recurrenceRule) : null;

    const cols = await getEventsColumns();

    const normYmd = (v) => {
      const s = String(v || "").trim();
      return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
    };

    const recurrenceStartDateClean = normYmd(recurrenceStartDate);
    const recurrenceUntilDateClean = normYmd(recurrenceUntilDate);

    // ---- Build fields ----
    const isUpdate = id !== undefined && id !== null && String(id).trim() !== "";

    const baseFields = [
      ["city", city],
      ["slug", slug],
      ["title", title],
      ["description", description],
      ["eventDetails", eventDetails || ""],
      ["goodToKnow", goodToKnow || ""],
      ["seoTitle", resolveSeoFieldValue(seoTitle, autoSeoFields?.seoTitle)],
      ["metaDescription", resolveSeoFieldValue(metaDescription, autoSeoFields?.metaDescription)],
      ["focusKeyphrase", resolveSeoFieldValue(focusKeyphrase, autoSeoFields?.focusKeyphrase)],
      ["imageAlt", resolveSeoFieldValue(imageAlt, autoSeoFields?.imageAlt)],
      ["startDateTime", startDateTime],
      ["endDateTime", endDateTime],
      ["multiDaySchedule", multiDayScheduleJson],
      ["location", location],
      ["organizer", organizer],
      ["imageUrl", imageUrl || null],
      ["ticketUrl", ticketUrl || null],
      ["ticketLabel", finalTicketLabel],
      ["categories", catsJson],
      ["featured", featuredFlag],
      ["eddiesPick", eddiesPickFlag],
    ];
    if (!isUpdate) {
      baseFields.push(["createdByUserId", sessionUser?.id || null]);
    }

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
if (cols.has("createdByUserId")) {
  await run("UPDATE events SET createdByUserId = COALESCE(createdByUserId, ?) WHERE id = ?", [sessionUser?.id || null, Number(id)]);
}

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

router.post("/events/bulk-import", bulkImportUpload.fields([{ name: "eventsCsv", maxCount: 1 }, { name: "imageZip", maxCount: 1 }]), async (req, res) => {
  try {
    const role = normalizeRoleValue(req.user?.role || "organizer");
    const sessionUser = await resolveSessionUser(req);
    const sectionPermissions = getUserSectionPermissions(sessionUser || { role });
    if (!(hasDeveloperAccessRole(role) || sectionPermissions.events)) {
      return res.status(403).send("Forbidden");
    }
    await ensurePickSchema();
    const organizerPrimaryName = role === "organizer" ? getOrganizerPrimaryName(sessionUser, req) : "";
    if (role === "organizer" && !organizerPrimaryName) {
      return res.status(400).send("Organizer account is missing an organizer identity.");
    }

    const userCity = String(req.user?.city || sessionUser?.city || "Enumclaw");
    const cityFromBody = String(req.body?.city || req.query.city || userCity || "Enumclaw").trim() || "Enumclaw";
    const importCity = pickAccessibleCity(cityFromBody, hasDeveloperAccessRole(role) ? { role: "developer" } : sessionUser, { fallbackCity: userCity });
    const file = req.files?.eventsCsv?.[0] || null;
    const imageZipFile = req.files?.imageZip?.[0] || null;
    if (!file?.buffer) return res.status(400).send("CSV file is required.");

    const rows = parseCsvRows(String(file.buffer.toString("utf8") || "").replace(/^\uFEFF/, ""));
    if (!rows.length) {
      return res.redirect(`/admin/upload-events?city=${encodeURIComponent(importCity)}&bulkImported=0&bulkSkipped=0&bulkErrors=1&bulkNotice=${encodeURIComponent("No CSV rows were found.")}`);
    }

    const cols = await getEventsColumns();
    const imported = [];
    const skipped = [];
    const errors = [];
    let zipAssets = null;

    if (imageZipFile?.buffer) {
      zipAssets = buildZipImageMap(imageZipFile.buffer);
    }

    try {
      for (const row of rows) {
        const rowNumber = Number(row.__rowNumber || 0);
        const city = hasDeveloperAccessRole(role)
          ? (getCsvValue(row, ["city"]) || importCity)
          : importCity;
        const title = getCsvValue(row, ["title", "name"]);
        const description = getCsvValue(row, ["description"]);
        const eventDetails = getCsvValue(row, ["eventDetails", "details"]);
        const goodToKnow = getCsvValue(row, ["goodToKnow"]);
        const startRaw = getCsvValue(row, ["startDateTime", "startDateTimeISO", "start", "startsAt"]);
        const endRaw = getCsvValue(row, ["endDateTime", "endDateTimeISO", "end", "endsAt"]);
        const location = getCsvValue(row, ["location", "venue"]);
        const organizer = role === "organizer"
          ? organizerPrimaryName
          : getCsvValue(row, ["organizer", "host"]);
        let imageUrl = normalizeHttpUrl(getCsvValue(row, ["imageUrl"]));
        const ticketUrl = normalizeHttpUrl(getCsvValue(row, ["ticketUrl", "eventLink", "ticketLink"]));
        const ticketLabel = getCsvValue(row, ["ticketLabel"]) || "Tickets";
        const seoTitle = getCsvValue(row, ["seoTitle"]);
        const metaDescription = getCsvValue(row, ["metaDescription"]);
        const focusKeyphrase = getCsvValue(row, ["focusKeyphrase"]);
        const imageAlt = getCsvValue(row, ["imageAlt"]);
        const categoriesRaw = [
          getCsvValue(row, ["category1"]),
          getCsvValue(row, ["category2"]),
          getCsvValue(row, ["category3"]),
          ...parseCsvListValues(getCsvValue(row, ["categories", "category"]))
        ].filter(Boolean);
        const imageAssetName = normalizeAssetKey(getCsvValue(row, ["imageFile", "imageFilename", "image"]));
        const categories = normalizeCategories(categoriesRaw);
        const featuredFlag = (hasDeveloperAccessRole(role) || !!sectionPermissions.featureEvents)
          ? (parseCsvBoolean(getCsvValue(row, ["featured"])) ? 1 : 0)
          : 0;
        const eddiesPickFlag = hasDeveloperAccessRole(role)
          ? (parseCsvBoolean(getCsvValue(row, ["eddiesPick"])) ? 1 : 0)
          : 0;
        const hasRec = parseCsvBoolean(getCsvValue(row, ["hasRecurrence", "recurring"])) ? 1 : 0;
        const recurrenceType = String(getCsvValue(row, ["recurrenceType"]) || "none").trim().toLowerCase();
        const recurrenceInterval = Math.max(1, parseInt(getCsvValue(row, ["recurrenceInterval"]) || "1", 10) || 1);
        const weeklyByDay = parseCsvListValues(getCsvValue(row, ["weeklyByDay", "byDay"])).map((item) => String(item || "").toUpperCase());
        const monthlyMode = String(getCsvValue(row, ["monthlyMode"]) || "monthday").trim().toLowerCase();
        const byMonthday = Math.max(1, Math.min(31, parseInt(getCsvValue(row, ["byMonthday"]) || "0", 10) || 0));
        const setPos = parseInt(getCsvValue(row, ["setPos"]) || "1", 10) || 1;
        const monthlyByDay = parseCsvListValues(getCsvValue(row, ["monthlyByDay"])).map((item) => String(item || "").toUpperCase());
        const recurrenceStartDate = getCsvValue(row, ["recurrenceStartDate"]);
        const recurrenceUntilDate = getCsvValue(row, ["recurrenceUntilDate"]);
        const recurrenceDates = parseCsvListValues(getCsvValue(row, ["recurrenceDates", "customDates"]));
        const customDates = parseCsvListValues(getCsvValue(row, ["customDate"]));
        const customStarts = parseCsvListValues(getCsvValue(row, ["customStart"]));
        const customEnds = parseCsvListValues(getCsvValue(row, ["customEnd"]));

        if (!title || !description || !startRaw || !location || !organizer) {
          errors.push(`Row ${rowNumber}: missing required fields.`);
          continue;
        }

        if (!imageUrl && zipAssets?.imageMap && imageAssetName) {
          const imagePath = zipAssets.imageMap.get(imageAssetName);
          if (imagePath) {
            imageUrl = await persistImportedImage(imagePath, req);
          } else {
            errors.push(`Row ${rowNumber}: image "${imageAssetName}" was not found in the ZIP.`);
            continue;
          }
        }

        const startDateTime = toLocalISOWithOffset(startRaw);
        let endDateTime = endRaw ? toLocalISOWithOffset(endRaw) : "";
        if (!startDateTime) {
          errors.push(`Row ${rowNumber}: invalid startDateTime.`);
          continue;
        }
        if (!endDateTime) endDateTime = addHoursIso(startDateTime, 1);
        if (!endDateTime) {
          errors.push(`Row ${rowNumber}: invalid endDateTime.`);
          continue;
        }

        const startMs = Date.parse(startDateTime);
        const endMs = Date.parse(endDateTime);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
          errors.push(`Row ${rowNumber}: end time must be after start time.`);
          continue;
        }

        const duplicateMatches = await findAdminEventDuplicateMatches({
          city,
          title,
          startDateTime,
          endDateTime,
          location,
          organizer,
          ticketUrl,
          eventLink: ticketUrl,
        });
        if (duplicateMatches.length) {
          skipped.push(`Row ${rowNumber}: skipped possible duplicate "${title}".`);
          continue;
        }

        let recurrenceRule = null;
        let recurrenceDatesJson = null;
        if (hasRec && recurrenceType !== "none") {
          if (recurrenceType === "custom") {
            const items = [];
            const uniqDates = [];
            const baseStartTime = String(startDateTime || "").slice(11, 16) || "00:00";
            const baseEndTime = String(endDateTime || "").slice(11, 16) || baseStartTime;
            const sourceDates = customDates.length ? customDates : recurrenceDates;
            for (let i = 0; i < sourceDates.length; i++) {
              const date = sourceDates[i];
              if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
              if (!uniqDates.includes(date)) uniqDates.push(date);
              const startTime = customStarts[i] || baseStartTime;
              const endTime = customEnds[i] || baseEndTime;
              items.push({
                date,
                start: toLocalISOWithOffset(`${date}T${startTime}`),
                end: toLocalISOWithOffset(`${date}T${endTime}`),
              });
            }
            if (!uniqDates.length) {
              errors.push(`Row ${rowNumber}: custom recurrence needs customDate or recurrenceDates.`);
              continue;
            }
            recurrenceRule = { type: "custom", items };
            recurrenceDatesJson = JSON.stringify(uniqDates);
          } else if (recurrenceType === "weekly") {
            const allowed = new Set(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
            const uniq = weeklyByDay.filter((day, index) => allowed.has(day) && weeklyByDay.indexOf(day) === index);
            if (!uniq.length) {
              errors.push(`Row ${rowNumber}: weekly recurrence needs weeklyByDay.`);
              continue;
            }
            recurrenceRule = { type: "weekly", interval: recurrenceInterval, byDay: uniq };
          } else if (recurrenceType === "monthly") {
            if (monthlyMode === "nthweekday") {
              const allowed = new Set(["SU", "MO", "TU", "WE", "TH", "FR", "SA"]);
              const uniq = monthlyByDay.filter((day, index) => allowed.has(day) && monthlyByDay.indexOf(day) === index);
              if (!uniq.length) {
                errors.push(`Row ${rowNumber}: monthly nth weekday recurrence needs monthlyByDay.`);
                continue;
              }
              recurrenceRule = { type: "monthly", interval: recurrenceInterval, mode: "nthweekday", setPos, byDay: uniq };
            } else {
              if (!byMonthday) {
                errors.push(`Row ${rowNumber}: monthly recurrence needs byMonthday.`);
                continue;
              }
              recurrenceRule = { type: "monthly", interval: recurrenceInterval, mode: "monthday", byMonthday };
            }
          } else {
            errors.push(`Row ${rowNumber}: unsupported recurrenceType "${recurrenceType}".`);
            continue;
          }
        }

        const slug = await ensureUniqueSlug(slugify(title), null);
        const autoSeoFields = role === "organizer"
          ? buildBasicEventSeoFields({ title, description, location, organizer })
          : null;
        const catsJson = JSON.stringify(categories);
        const fields = [
          ["city", city],
          ["slug", slug],
          ["title", title],
          ["description", description],
          ["eventDetails", eventDetails || ""],
          ["goodToKnow", goodToKnow || ""],
          ["seoTitle", resolveSeoFieldValue(seoTitle, autoSeoFields?.seoTitle)],
          ["metaDescription", resolveSeoFieldValue(metaDescription, autoSeoFields?.metaDescription)],
          ["focusKeyphrase", resolveSeoFieldValue(focusKeyphrase, autoSeoFields?.focusKeyphrase)],
          ["imageAlt", resolveSeoFieldValue(imageAlt, autoSeoFields?.imageAlt)],
          ["startDateTime", startDateTime],
          ["endDateTime", endDateTime],
          ["location", location],
          ["organizer", organizer],
          ["imageUrl", imageUrl || null],
          ["ticketUrl", ticketUrl || null],
          ["ticketLabel", ticketLabel],
          ["categories", catsJson],
          ["featured", featuredFlag],
          ["eddiesPick", eddiesPickFlag],
        ];

        const recurrenceRuleJson = recurrenceRule ? JSON.stringify(recurrenceRule) : null;
        const recurrenceStartDateClean = /^\d{4}-\d{2}-\d{2}$/.test(recurrenceStartDate) ? recurrenceStartDate : null;
        const recurrenceUntilDateClean = /^\d{4}-\d{2}-\d{2}$/.test(recurrenceUntilDate) ? recurrenceUntilDate : null;
        const hasRecCols =
          cols.has("hasRecurrence") &&
          cols.has("recurrenceRule") &&
          cols.has("recurrenceDates") &&
          cols.has("recurrenceStartDate") &&
          cols.has("recurrenceUntilDate");
        if (hasRecCols) {
          fields.push(
            ["hasRecurrence", hasRec],
            ["recurrenceRule", recurrenceRuleJson],
            ["recurrenceDates", recurrenceDatesJson],
            ["recurrenceStartDate", recurrenceStartDateClean],
            ["recurrenceUntilDate", recurrenceUntilDateClean]
          );
        }

        const insertCols = [];
        const placeholders = [];
        const insertVals = [];
        for (const [key, value] of fields) {
          if (!cols.size || cols.has(key)) {
            insertCols.push(key);
            placeholders.push("?");
            insertVals.push(value);
          }
        }

        const insertResult = await run(
          `INSERT INTO events (${insertCols.join(", ")}) VALUES (${placeholders.join(", ")})`,
          insertVals
        );
        imported.push({ id: Number(insertResult?.lastID || 0), title });
      }
    } finally {
      if (zipAssets?.cleanup) zipAssets.cleanup();
    }

    const noticeParts = [];
    if (skipped.length) noticeParts.push(skipped.slice(0, 3).join(" "));
    if (errors.length) noticeParts.push(errors.slice(0, 3).join(" "));
    if (skipped.length > 3) noticeParts.push(`${skipped.length - 3} more skipped row(s).`);
    if (errors.length > 3) noticeParts.push(`${errors.length - 3} more error row(s).`);

    const sp = new URLSearchParams({
      city: importCity,
      bulkImported: String(imported.length),
      bulkSkipped: String(skipped.length),
      bulkErrors: String(errors.length),
    });
    const importedIds = imported.map((item) => Number(item.id || 0)).filter((id) => id > 0).slice(0, 20);
    if (importedIds.length) sp.set("importedIds", importedIds.join(","));
    if (skipped.length) sp.set("bulkSkippedItems", JSON.stringify(skipped.slice(0, 10)));
    if (errors.length) sp.set("bulkErrorItems", JSON.stringify(errors.slice(0, 10)));
    if (noticeParts.length) sp.set("bulkNotice", noticeParts.join(" "));
    return res.redirect(`/admin/upload-events?${sp.toString()}`);
  } catch (err) {
    console.error(err);
    return res.status(500).send("Failed to import CSV.");
  }
});

// Approve pending submission (create event)
router.post("/approve-events/:id/approve", async (req, res) => {
  try {
    const role = normalizeRoleValue(req.user?.role || "organizer");
    if (!hasDeveloperAccessRole(role)) return res.status(403).send("Forbidden");
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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    if (!hasDeveloperAccessRole(role)) return res.status(403).send("Forbidden");
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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    const sessionUser = await resolveSessionUser(req);
    const sectionPermissions = getUserSectionPermissions(sessionUser || { role });
    if (!(hasDeveloperAccessRole(role) || sectionPermissions.events)) {
      return res.status(403).send("Forbidden");
    }
    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");
    if (role === "organizer") {
      const organizerAccessValues = getOrganizerAccessValues(sessionUser, req);
      const ownedEvent = await get("SELECT id, organizer FROM events WHERE id = ? LIMIT 1", [id]);
      if (!ownedEvent?.id || !organizerOwnsEvent(ownedEvent, organizerAccessValues)) {
        return res.status(403).send("Forbidden");
      }
    }

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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    const sessionUser = await resolveSessionUser(req);
    const sectionPermissions = getUserSectionPermissions(sessionUser || { role });
    if (!(hasDeveloperAccessRole(role) || sectionPermissions.events)) {
      return res.status(403).send("Forbidden");
    }
    await ensureArchiveSchema();

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");
    if (role === "organizer") {
      const organizerAccessValues = getOrganizerAccessValues(sessionUser, req);
      const ownedEvent = await get("SELECT id, organizer FROM events WHERE id = ? LIMIT 1", [id]);
      if (!ownedEvent?.id || !organizerOwnsEvent(ownedEvent, organizerAccessValues)) {
        return res.status(403).send("Forbidden");
      }
    }

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
    const role = normalizeRoleValue(req.user?.role || "organizer");
    const sessionUser = await resolveSessionUser(req);
    const sectionPermissions = getUserSectionPermissions(sessionUser || { role });
    if (!(hasDeveloperAccessRole(role) || sectionPermissions.events)) {
      return res.status(403).send("Forbidden");
    }
    await ensureArchiveSchema();

    const id = parseInt(req.params.id, 10);
    if (Number.isNaN(id)) return res.status(400).send("Invalid ID.");
    if (role === "organizer") {
      const organizerAccessValues = getOrganizerAccessValues(sessionUser, req);
      const ownedEvent = await get("SELECT id, organizer FROM events WHERE id = ? LIMIT 1", [id]);
      if (!ownedEvent?.id || !organizerOwnsEvent(ownedEvent, organizerAccessValues)) {
        return res.status(403).send("Forbidden");
      }
    }

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
