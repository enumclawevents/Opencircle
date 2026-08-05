"use strict";

const { safeParseJson } = require("./json");

const JOB_APPLICATION_FIELDS = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "coverLetter", label: "Cover letter" },
  { key: "resume", label: "Resume upload" },
];

const JOB_EMPLOYMENT_TYPE_OPTIONS = ["Part-Time", "Full-Time"];

function normalizeEmploymentTypeLabel(input) {
  const value = String(input || "").trim().toLowerCase();
  if (!value) return "";
  if (value === "part-time" || value === "part time" || value === "parttime") return "Part-Time";
  if (value === "full-time" || value === "full time" || value === "fulltime") return "Full-Time";
  return "";
}

function collectEmploymentTypeCandidates(input) {
  if (Array.isArray(input)) {
    return input.flatMap((item) => collectEmploymentTypeCandidates(item));
  }
  if (input && typeof input === "object") {
    const out = [];
    if (input.partTime === true || String(input.partTime || "").trim() === "1" || String(input.partTime || "").trim().toLowerCase() === "true") {
      out.push("Part-Time");
    }
    if (input.fullTime === true || String(input.fullTime || "").trim() === "1" || String(input.fullTime || "").trim().toLowerCase() === "true") {
      out.push("Full-Time");
    }
    if (Array.isArray(input.employmentTypes)) out.push(...collectEmploymentTypeCandidates(input.employmentTypes));
    if (input.employmentType) out.push(...collectEmploymentTypeCandidates(input.employmentType));
    return out;
  }
  const raw = String(input || "").trim();
  if (!raw) return [];
  return raw.split(/[\/,|&]+/g).map((part) => part.trim()).filter(Boolean);
}

function normalizeJobEmploymentTypes(input) {
  const arr = collectEmploymentTypeCandidates(input);
  const out = [];
  for (const item of arr) {
    const label = normalizeEmploymentTypeLabel(item);
    if (!label || out.includes(label)) continue;
    out.push(label);
  }
  return out;
}

function getJobEmploymentTypesForEdit(job) {
  const parsed = safeParseJson(job?.employmentTypesJson, null);
  const normalized = normalizeJobEmploymentTypes({
    employmentTypes: parsed,
    employmentType: job?.employmentType || "",
    partTime: job?.partTime,
    fullTime: job?.fullTime,
  });
  return normalized.length ? normalized : ["Full-Time"];
}

function formatEmploymentTypeDisplay(employmentTypes, fallback = "") {
  const normalized = normalizeJobEmploymentTypes(employmentTypes);
  if (normalized.length === 2) return "Part-Time / Full-Time";
  if (normalized.length === 1) return normalized[0];
  return String(fallback || "").trim();
}

function defaultJobApplicationFields() {
  return {
    firstName: "required",
    lastName: "required",
    email: "required",
    phone: "optional",
    coverLetter: "optional",
    resume: "optional",
  };
}

function normalizeJobApplicationMode(input) {
  const mode = String(input || "external").trim().toLowerCase();
  return ["external", "website", "both"].includes(mode) ? mode : "external";
}

function normalizeJobApplicationFields(input) {
  const defaults = defaultJobApplicationFields();
  const raw = (input && typeof input === "object") ? input : {};
  const out = {};
  for (const field of JOB_APPLICATION_FIELDS) {
    const value = String(raw[field.key] || defaults[field.key] || "optional").trim().toLowerCase();
    out[field.key] = ["off", "optional", "required"].includes(value) ? value : defaults[field.key];
  }
  return out;
}

module.exports = {
  JOB_APPLICATION_FIELDS,
  JOB_EMPLOYMENT_TYPE_OPTIONS,
  defaultJobApplicationFields,
  formatEmploymentTypeDisplay,
  getJobEmploymentTypesForEdit,
  normalizeEmploymentTypeLabel,
  normalizeJobApplicationFields,
  normalizeJobApplicationMode,
  normalizeJobEmploymentTypes,
};
