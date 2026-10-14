"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { normalizeStoredRole } = require("../lib/roles");

test("startup role normalization preserves Admin, Developer, and Organizer", () => {
  assert.equal(normalizeStoredRole("admin"), "admin");
  assert.equal(normalizeStoredRole("developer"), "developer");
  assert.equal(normalizeStoredRole("organizer"), "organizer");
});

test("startup role normalization maps only the retired role spelling", () => {
  assert.equal(normalizeStoredRole("area_manager"), "developer");
  assert.equal(normalizeStoredRole("unknown legacy role"), "organizer");
  assert.equal(normalizeStoredRole(""), "organizer");
});
