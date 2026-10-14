"use strict";

const OPEN_CIRCLE_ROLES = Object.freeze(["admin", "developer", "organizer"]);

// Startup migrations must preserve every valid role. `area_manager` is the
// one retired spelling that maps to the current Developer role.
function normalizeStoredRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (role === "admin" || role === "developer" || role === "organizer") return role;
  if (role === "area_manager") return "developer";
  return "organizer";
}

module.exports = { OPEN_CIRCLE_ROLES, normalizeStoredRole };
