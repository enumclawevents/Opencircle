"use strict";

const { all, transaction } = require("../db");

const LIFECYCLE_STATES = Object.freeze(["scheduled", "cancelled", "postponed", "rescheduled", "archived"]);
const CHANGE_TYPES = Object.freeze(["created", "updated", "lifecycle", "archived", "restored", "deleted"]);
const TRANSITIONS = Object.freeze({
  scheduled: new Set(["scheduled", "cancelled", "postponed", "rescheduled", "archived"]),
  cancelled: new Set(["cancelled", "scheduled", "archived"]),
  postponed: new Set(["postponed", "scheduled", "cancelled", "rescheduled", "archived"]),
  rescheduled: new Set(["rescheduled", "scheduled", "cancelled", "postponed", "archived"]),
  archived: new Set(["archived", "scheduled"]),
});

function normalizeLifecycleState(value, fallback = "scheduled") {
  const state = String(value || "").trim().toLowerCase();
  return LIFECYCLE_STATES.includes(state) ? state : fallback;
}

function effectiveLifecycleState(event) {
  if (Number(event?.archived || 0) === 1) return "archived";
  return normalizeLifecycleState(event?.lifecycleState, "scheduled");
}

function canTransitionLifecycle(from, to) {
  return !!TRANSITIONS[normalizeLifecycleState(from)]?.has(normalizeLifecycleState(to));
}

function publicLifecycle(event) {
  const state = effectiveLifecycleState(event);
  return {
    state,
    revision: Math.max(1, Number(event?.revision || 1)),
    updatedAt: event?.lifecycleUpdatedAt || event?.updatedAt || null,
    reason: event?.lifecycleReason || null,
    replacementEventId: event?.replacementEventId == null ? null : Number(event.replacementEventId),
  };
}

function equalValue(left, right) {
  const normalize = (value) => value === undefined || value === null ? null : String(value);
  return normalize(left) === normalize(right);
}

async function eventColumns() {
  const rows = await all("PRAGMA table_info(events)");
  return new Set((rows || []).map((row) => String(row.name)));
}

async function appendChange(tx, { eventId, city, revision, changeType, actorUserId = null }) {
  if (!CHANGE_TYPES.includes(changeType)) throw new Error("Unsupported event change type.");
  await tx.run(
    `INSERT INTO event_changes (eventId, city, revision, changeType, occurredAt, actorUserId, publicPayloadVersion)
     VALUES (?, ?, ?, ?, datetime('now'), ?, 1)`,
    [eventId, city, revision, changeType, actorUserId || null]
  );
}

async function createEventWithChange({ fields, actorUserId = null, changeType = "created" }) {
  const cols = await eventColumns();
  return transaction(async (tx) => {
    const payload = new Map((fields || []).filter(([key]) => cols.has(key)));
    if (cols.has("lifecycleState") && !payload.has("lifecycleState")) payload.set("lifecycleState", "scheduled");
    if (cols.has("revision") && !payload.has("revision")) payload.set("revision", 1);
    if (cols.has("publishedAt") && !payload.has("publishedAt")) payload.set("publishedAt", new Date().toISOString());
    const names = [...payload.keys()];
    const values = [...payload.values()];
    const inserted = await tx.run(
      `INSERT INTO events (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`,
      values
    );
    const event = await tx.get("SELECT id, city, revision FROM events WHERE id = ?", [inserted.lastID]);
    await appendChange(tx, { eventId: event.id, city: event.city, revision: Number(event.revision || 1), changeType, actorUserId });
    return { changed: true, event };
  });
}

async function updateEventWithChange({ eventId, fields, actorUserId = null, changeType = "updated" }) {
  const cols = await eventColumns();
  return transaction(async (tx) => {
    const current = await tx.get("SELECT * FROM events WHERE id = ?", [eventId]);
    if (!current) return { changed: false, event: null };
    const changedFields = (fields || []).filter(([key, value]) => cols.has(key) && !equalValue(current[key], value));
    if (!changedFields.length) return { changed: false, event: current };

    const sets = changedFields.map(([key]) => `${key} = ?`);
    const values = changedFields.map(([, value]) => value);
    if (cols.has("revision")) sets.push("revision = COALESCE(revision, 1) + 1");
    if (cols.has("updatedAt")) sets.push("updatedAt = datetime('now')");
    await tx.run(`UPDATE events SET ${sets.join(", ")} WHERE id = ?`, [...values, eventId]);
    const event = await tx.get("SELECT id, city, revision FROM events WHERE id = ?", [eventId]);
    await appendChange(tx, { eventId: event.id, city: event.city, revision: Number(event.revision || 1), changeType, actorUserId });
    return { changed: true, event };
  });
}

async function deleteEventWithChange({ eventId, actorUserId = null }) {
  return transaction(async (tx) => {
    const event = await tx.get("SELECT id, city, revision FROM events WHERE id = ?", [eventId]);
    if (!event) return { changed: false, event: null };
    const revision = Math.max(1, Number(event.revision || 1)) + 1;
    await appendChange(tx, { eventId: event.id, city: event.city, revision, changeType: "deleted", actorUserId });
    await tx.run("DELETE FROM events WHERE id = ?", [eventId]);
    return { changed: true, event: { ...event, revision } };
  });
}

module.exports = {
  LIFECYCLE_STATES,
  canTransitionLifecycle,
  createEventWithChange,
  deleteEventWithChange,
  effectiveLifecycleState,
  normalizeLifecycleState,
  publicLifecycle,
  updateEventWithChange,
};
