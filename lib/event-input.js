"use strict";

// Shared, intentionally small event-input primitives.  Entry points retain
// their own authorization, moderation, recurrence, and response behaviour;
// this module only keeps their common baseline data handling from drifting.
const { DateTime } = require("luxon");
const { DEFAULT_TZ } = require("./admin-constants");

function toLocalISOWithOffset(value, timeZone = DEFAULT_TZ) {
  const raw = String(value || "").trim();
  if (!raw) return null;

  for (const format of ["yyyy-MM-dd'T'HH:mm", "yyyy-MM-dd'T'HH:mm:ss"]) {
    const local = DateTime.fromFormat(raw, format, { zone: timeZone });
    if (local.isValid) return local.toISO({ suppressMilliseconds: true, includeOffset: true });
  }

  const parsed = DateTime.fromISO(raw, { setZone: true });
  return parsed.isValid ? parsed.toISO({ suppressMilliseconds: true, includeOffset: true }) : null;
}

function addHoursIso(iso, hours) {
  const parsed = DateTime.fromISO(String(iso || ""), { setZone: true });
  if (!parsed.isValid) return iso;
  return parsed.plus({ hours: Number(hours) || 0 }).toUTC().toISO({ suppressMilliseconds: true, includeOffset: true });
}

function normalizeEventDateTimes({ startDateTime, endDateTime, defaultEndHours = 1, timeZone = DEFAULT_TZ } = {}) {
  const rawEnd = String(endDateTime || "").trim();
  const start = toLocalISOWithOffset(startDateTime, timeZone);
  let end = rawEnd ? toLocalISOWithOffset(rawEnd, timeZone) : null;
  // Preserve the established distinction between a missing end time (default
  // it) and an invalid supplied end time (surface validation instead).
  if (!rawEnd && start && defaultEndHours !== null) end = addHoursIso(start, defaultEndHours);
  return { startDateTime: start, endDateTime: end };
}

function requiredEventFields(input, required = ["title", "description", "startDateTime", "endDateTime", "location", "organizer"]) {
  return required.filter((field) => !String(input?.[field] || "").trim());
}

function hasValidEventDateRange(startDateTime, endDateTime) {
  const start = Date.parse(String(startDateTime || ""));
  const end = Date.parse(String(endDateTime || ""));
  return Number.isFinite(start) && Number.isFinite(end) && end > start;
}

function normalizeCategoryInput(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  return source.map((item) => String(item || "").trim()).filter(Boolean);
}

function normalizeMultiDaySchedule(value, { sort = false } = {}) {
  let items = value;
  if (typeof items === "string") {
    try { items = JSON.parse(items); } catch { items = []; }
  }
  if (!Array.isArray(items)) return [];
  const normalized = items
    .map((item) => {
      const date = String(item?.date || "").trim();
      const startTime = String(item?.startTime || "").trim();
      const endTime = String(item?.endTime || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(startTime) || !/^\d{2}:\d{2}$/.test(endTime)) return null;
      return { date, startTime, endTime };
    })
    .filter(Boolean);
  return sort ? normalized.sort((a, b) => a.date.localeCompare(b.date)) : normalized;
}

module.exports = {
  addHoursIso,
  hasValidEventDateRange,
  normalizeCategoryInput,
  normalizeEventDateTimes,
  normalizeMultiDaySchedule,
  requiredEventFields,
  toLocalISOWithOffset,
};
