"use strict";

const crypto = require("crypto");
const { clientIp, createRateLimiter } = require("./public-rate-limit");
const limit = createRateLimiter({ windowMs: 60000, max: 120, maxKeys: 4096 });
const visitorLimit = createRateLimiter({ windowMs: 60000, max: 60, maxKeys: 4096 });
let identityConfigurationWarning = false;
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;

async function ensureOccurrenceEngagementSchema(run) {
  await run(`CREATE TABLE IF NOT EXISTS occurrence_engagement (
    eventId INTEGER NOT NULL,
    occurrenceStart TEXT NOT NULL,
    visitorHash TEXT NOT NULL,
    selection TEXT NOT NULL CHECK (selection IN ('going', 'interested')),
    updatedAt TEXT NOT NULL,
    PRIMARY KEY (eventId, occurrenceStart, visitorHash)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS occurrence_engagement_nonces (
    credentialId TEXT NOT NULL, nonce TEXT NOT NULL, expiresAt INTEGER NOT NULL,
    PRIMARY KEY (credentialId, nonce)
  )`);
}

function credentials() {
  try {
    const values = JSON.parse(process.env.OCCURRENCE_ENGAGEMENT_CREDENTIALS || "{}");
    if (!values || Array.isArray(values) || typeof values !== "object") return {};
    return values;
  } catch { return {}; }
}

function canonicalOccurrence(value, eventId) {
  if (typeof value !== "string" || value.length > 100) return null;
  const prefix = `e${eventId}_`;
  if (!value.startsWith(prefix)) return null;
  const instant = value.slice(prefix.length);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(instant)) return null;
  const day = instant.slice(0, 10);
  const date = new Date(day + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== day) return null;
  const ms = Date.parse(instant);
  if (!Number.isFinite(ms)) return null;
  return { ms, start: new Date(ms).toISOString(), id: prefix + new Date(ms).toISOString() };
}

function createOccurrenceEngagementHandler({ transaction, generateOccurrences, normalizeRowTimes, availableEventSql }) {
  return async function occurrenceEngagement(req, res) {
    res.set("Cache-Control", "private, no-store");
    if (!limit.consume(clientIp(req))) {
      res.set("Retry-After", "60");
      return res.status(429).json({ error: "Too many engagement requests. Please try again later." });
    }
    const fail = (status, error) => res.status(status).json({ error });
    const body = req.body;
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        !["occurrence_read", "occurrence_set"].includes(body.mode) ||
        Object.keys(body).some(key => !["mode", "occurrenceId", "visitorToken", "selection"].includes(key)) ||
        typeof body.visitorToken !== "string" || !tokenPattern.test(body.visitorToken) ||
        Buffer.from(body.visitorToken, "base64url").toString("base64url") !== body.visitorToken ||
        (body.mode === "occurrence_set" && !["going", "interested", null].includes(body.selection)) ||
        (body.mode === "occurrence_read" && body.selection !== undefined)) {
      return fail(400, "Invalid occurrence engagement request.");
    }
    const keyId = req.get("X-OC-Key-Id") || "";
    const timestamp = req.get("X-OC-Timestamp") || "";
    const nonce = req.get("X-OC-Nonce") || "";
    const signature = req.get("X-OC-Signature") || "";
    const config = credentials();
    const credential = Object.hasOwn(config, keyId) ? config[keyId] : null;
    if (!credential || typeof credential.secret !== "string" || credential.secret.length < 32 ||
        typeof credential.city !== "string" || !credential.city.trim()) return fail(401, "Unauthorized engagement request.");
    if (!/^\d{10}$/.test(timestamp) || Math.abs(Date.now() - Number(timestamp) * 1000) > 300000 ||
        !/^[A-Za-z0-9_-]{22,64}$/.test(nonce) || !/^[a-f0-9]{64}$/.test(signature)) return fail(401, "Unauthorized engagement request.");
    const digest = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const expected = crypto.createHmac("sha256", credential.secret)
      .update([req.method, req.originalUrl, timestamp, nonce, digest].join("\n")).digest("hex");
    if (!crypto.timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) return fail(401, "Unauthorized engagement request.");

    const identityKey = process.env.OCCURRENCE_ENGAGEMENT_IDENTITY_KEY || "";
    if (!/^[a-fA-F0-9]{64}$/.test(identityKey)) {
      if (!identityConfigurationWarning) {
        console.error("[occurrence engagement] Configure OCCURRENCE_ENGAGEMENT_IDENTITY_KEY as a persistent random 32-byte hexadecimal key.");
        identityConfigurationWarning = true;
      }
      return fail(503, "Occurrence engagement identity is not configured.");
    }
    identityConfigurationWarning = false;

    const raw = req.params.idOrSlug;
    const isId = /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(Number(raw));
    if (typeof raw !== "string" || raw.length > 200) return fail(400, "Invalid event.");
    try {
      const result = await transaction(async tx => {
        const event = await tx.get(
          `SELECT e.* FROM events e WHERE ${isId ? "e.id" : "e.slug"} = ? AND e.city = ? COLLATE NOCASE AND ${availableEventSql("e")}`,
          [isId ? Number(raw) : raw, credential.city]
        );
        if (!event) return { status: 404, error: "Event unavailable." };
        if (Number(event.hasRecurrence) !== 1) return { status: 400, error: "Occurrence engagement requires a recurring event." };
        const occurrence = canonicalOccurrence(body.occurrenceId, event.id);
        if (!occurrence) return { status: 400, error: "Invalid occurrence identifier." };
        const hash = crypto.createHmac("sha256", Buffer.from(identityKey, "hex"))
          .update(JSON.stringify([event.city, event.id, body.visitorToken])).digest("hex");
        if (!visitorLimit.consume(hash)) return { status: 429, error: "Too many engagement requests. Please try again later." };
        await tx.run("DELETE FROM occurrence_engagement_nonces WHERE expiresAt < ?", [Date.now()]);
        const claimed = await tx.run(
          "INSERT OR IGNORE INTO occurrence_engagement_nonces VALUES (?, ?, ?)",
          [keyId, nonce, Date.now() + 600000]
        );
        if (!claimed.changes) return { status: 409, error: "Request already used. Retry with a new nonce." };
        const generated = generateOccurrences(normalizeRowTimes(event), occurrence.ms - 172800000, occurrence.ms + 172800000);
        const selected = generated.find(item => Date.parse(item.startDateTime) === occurrence.ms);
        const state = String(event.lifecycleState || "scheduled").toLowerCase();
        const available = !!selected && !["cancelled", "postponed"].includes(state) &&
          Date.parse(selected.endDateTime || selected.startDateTime) >= Date.now();
        if (body.mode === "occurrence_set" && !available) return { status: 409, error: "Occurrence unavailable for new engagement." };
        if (!selected && body.mode === "occurrence_read") {
          const historical = await tx.get(
            "SELECT 1 AS found FROM occurrence_engagement WHERE eventId = ? AND occurrenceStart = ? LIMIT 1",
            [event.id, occurrence.start]
          );
          if (!historical) return { status: 404, error: "Occurrence unavailable." };
        }
        if (body.mode === "occurrence_set") {
          if (body.selection === null) {
            await tx.run("DELETE FROM occurrence_engagement WHERE eventId = ? AND occurrenceStart = ? AND visitorHash = ?", [event.id, occurrence.start, hash]);
          } else {
            await tx.run(`INSERT INTO occurrence_engagement VALUES (?, ?, ?, ?, ?)
              ON CONFLICT(eventId, occurrenceStart, visitorHash)
              DO UPDATE SET selection = excluded.selection, updatedAt = excluded.updatedAt`,
            [event.id, occurrence.start, hash, body.selection, new Date().toISOString()]);
          }
        }
        const counts = await tx.get(`SELECT COALESCE(sum(selection = 'going'), 0) AS goingCount,
          COALESCE(sum(selection = 'interested'), 0) AS interestedCount
          FROM occurrence_engagement WHERE eventId = ? AND occurrenceStart = ?`, [event.id, occurrence.start]);
        const visitor = await tx.get("SELECT selection FROM occurrence_engagement WHERE eventId = ? AND occurrenceStart = ? AND visitorHash = ?", [event.id, occurrence.start, hash]);
        return { data: { ok: true, id: event.id, occurrenceId: occurrence.id, occurrenceStart: occurrence.start,
          available, ...counts, selection: visitor?.selection || null } };
      });
      if (result.status === 429) res.set("Retry-After", "60");
      return result.error ? fail(result.status, result.error) : res.json(result.data);
    } catch {
      return fail(500, "Unable to update occurrence engagement.");
    }
  };
}

module.exports = { ensureOccurrenceEngagementSchema, createOccurrenceEngagementHandler, canonicalOccurrence };
