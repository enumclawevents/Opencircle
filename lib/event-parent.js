"use strict";

const PARENT_UNAVAILABLE = "Choose an available published parent event.";
const PARENT_CYCLE = "An event cannot be its own parent or link to one of its descendants.";

function parseEventId(value) {
  if (!["string", "number"].includes(typeof value)) return null;
  if (!/^[1-9]\d*$/.test(String(value))) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) ? id : null;
}

function readParentEventId(body) {
  const value = body?.parentEventId;
  if (value === undefined || value === null || value === "") return value === undefined ? undefined : null;
  const id = parseEventId(value);
  if (id === null) {
    const error = new Error("parentEventId must be a positive event ID or null.");
    error.code = "INVALID_PARENT_EVENT_ID";
    throw error;
  }
  return id;
}

function parentEventError(error) {
  if (error?.code === "INVALID_PARENT_EVENT_ID") return error.message;
  if (error?.code !== "SQLITE_CONSTRAINT") return null;
  return [PARENT_UNAVAILABLE, PARENT_CYCLE].find(message => error.message.endsWith(message)) || null;
}

// Pending submissions live in a separate table. Legacy published events may
// have no publishedAt timestamp, and past events still have public pages.
function availableEventSql(alias) {
  return `LOWER(TRIM(COALESCE(${alias}.archived, '0'))) NOT IN ('1', 'true', 'yes', 'on')
      AND LOWER(TRIM(COALESCE(${alias}.lifecycleState, 'scheduled'))) <> 'archived'`;
}

async function installParentEventConstraints(run) {
  await run("CREATE INDEX IF NOT EXISTS idx_events_parent_event ON events(parentEventId)");
  await run("CREATE INDEX IF NOT EXISTS idx_pending_events_parent_event ON pending_events(parentEventId)");

  const validateTarget = `
    SELECT RAISE(ABORT, '${PARENT_UNAVAILABLE}')
     WHERE NOT EXISTS (SELECT 1 FROM events p WHERE p.id = NEW.parentEventId AND ${availableEventSql("p")});`;
  // SQLite serializes writes. Checking the chain inside the same statement
  // prevents two concurrent edits from creating reciprocal links.
  for (const table of ["events", "pending_events"]) {
    const validateCycle = table === "events" ? `
      SELECT RAISE(ABORT, '${PARENT_CYCLE}')
       WHERE NEW.id = NEW.parentEventId OR EXISTS (
         WITH RECURSIVE ancestors(id) AS (
           SELECT NEW.parentEventId
           UNION
           SELECT e.parentEventId FROM events e JOIN ancestors a ON e.id = a.id
            WHERE e.parentEventId IS NOT NULL
         )
         SELECT 1 FROM ancestors WHERE id = NEW.id
       );` : "";
    for (const operation of ["INSERT", "UPDATE"]) {
      const change = operation === "UPDATE" ? " AND NEW.parentEventId IS NOT OLD.parentEventId" : "";
      await run(`CREATE TRIGGER IF NOT EXISTS ${table}_validate_parent_${operation.toLowerCase()}
        AFTER ${operation === "UPDATE" ? "UPDATE OF parentEventId" : "INSERT"} ON ${table}
        WHEN NEW.parentEventId IS NOT NULL${change}
        BEGIN
          ${validateCycle}
          ${validateTarget}
        END`);
    }
  }

  await run(`CREATE TRIGGER IF NOT EXISTS events_clear_deleted_parent
    AFTER DELETE ON events
    BEGIN
      UPDATE events SET parentEventId = NULL WHERE parentEventId = OLD.id;
      UPDATE pending_events SET parentEventId = NULL WHERE parentEventId = OLD.id;
    END`);
}

module.exports = {
  availableEventSql,
  installParentEventConstraints,
  parentEventError,
  parseEventId,
  readParentEventId,
};
