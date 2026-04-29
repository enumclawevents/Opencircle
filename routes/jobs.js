"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { S3Client } = require("@aws-sdk/client-s3");
const multerS3 = require("multer-s3");
const { all, get, run } = require("../db");
const { safeParseJson } = require("../lib/json");
const {
  JOB_APPLICATION_FIELDS,
  formatEmploymentTypeDisplay,
  normalizeJobApplicationFields,
  normalizeJobApplicationMode,
  normalizeJobEmploymentTypes,
} = require("../lib/job-utils");

const router = express.Router();

function getCanonicalEmploymentTypes(row) {
  const parsed = safeParseJson(row?.employmentTypesJson, null);
  return normalizeJobEmploymentTypes({
    employmentTypes: parsed,
    employmentType: row?.employmentType || "",
    partTime: row?.partTime,
    fullTime: row?.fullTime,
  });
}

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
  const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
  const base = path
    .basename(file.originalname || "resume", ext)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return `${base || "resume"}-${Date.now()}${ext}`;
}

const resumeUpload = multer({
  storage: useR2
    ? multerS3({
        s3: r2Client,
        bucket: R2_BUCKET,
        contentType: multerS3.AUTO_CONTENT_TYPE,
        key: (_req, file, cb) => cb(null, buildUploadKey(file)),
      })
    : multer.diskStorage({
        destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
        filename: (_req, file, cb) => cb(null, buildUploadKey(file)),
      }),
  fileFilter: (_req, file, cb) => {
    const ok = /^(application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|text\/plain)$/i.test(file.mimetype || "");
    cb(ok ? null : new Error("Only PDF, DOC, DOCX, and TXT files are allowed."), ok);
  },
  limits: { fileSize: 8 * 1024 * 1024 },
});

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

function getBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

function buildJobPayload(row, req) {
  if (!row) return null;

  const baseUrl = getBaseUrl(req);
  const applicationMode = normalizeJobApplicationMode(row.applicationMode || "external");
  const applicationFields = normalizeJobApplicationFields(safeParseJson(row.applicationFieldsJson, null));
  const employmentTypes = getCanonicalEmploymentTypes(row);
  const jobKey = encodeURIComponent(row.slug || row.id);

  return {
    id: Number(row.id),
    city: String(row.city || ""),
    slug: String(row.slug || ""),
    title: String(row.title || ""),
    company: String(row.company || ""),
    location: String(row.location || ""),
    employmentTypes,
    employmentType: formatEmploymentTypeDisplay(employmentTypes, row.employmentType || ""),
    salaryRange: String(row.salaryRange || ""),
    applyUrl: normalizeHttpUrl(row.applyUrl || ""),
    imageUrl: normalizeHttpUrl(row.imageUrl || ""),
    description: String(row.description || ""),
    status: String(row.status || "active"),
    applicationMode,
    applicationFields,
    acceptsWebsiteApplications: applicationMode === "website" || applicationMode === "both",
    applicationUrl: applicationMode === "website" || applicationMode === "both"
      ? `${baseUrl}/jobs/${jobKey}/apply`
      : "",
    viewCount: Number(row.viewCount || 0),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    jsonUrl: `${baseUrl}/jobs/${jobKey}`
  };
}

async function ensureTableColumn(table, name, sql) {
  const cols = await all(`PRAGMA table_info(${table})`);
  const names = new Set((cols || []).map((row) => String(row.name)));
  if (!names.has(name)) await run(sql);
}

async function ensureJobSchema() {
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
    partTime INTEGER,
    fullTime INTEGER,
    salaryRange TEXT,
      applyUrl TEXT,
      imageUrl TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      applicationMode TEXT NOT NULL DEFAULT 'external',
      applicationFieldsJson TEXT,
      viewCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);

  await ensureTableColumn("jobs", "company", `ALTER TABLE jobs ADD COLUMN company TEXT`);
  await ensureTableColumn("jobs", "location", `ALTER TABLE jobs ADD COLUMN location TEXT`);
  await ensureTableColumn("jobs", "employmentType", `ALTER TABLE jobs ADD COLUMN employmentType TEXT`);
  await ensureTableColumn("jobs", "employmentTypesJson", `ALTER TABLE jobs ADD COLUMN employmentTypesJson TEXT`);
  await ensureTableColumn("jobs", "partTime", `ALTER TABLE jobs ADD COLUMN partTime INTEGER`);
  await ensureTableColumn("jobs", "fullTime", `ALTER TABLE jobs ADD COLUMN fullTime INTEGER`);
  await ensureTableColumn("jobs", "salaryRange", `ALTER TABLE jobs ADD COLUMN salaryRange TEXT`);
  await ensureTableColumn("jobs", "applyUrl", `ALTER TABLE jobs ADD COLUMN applyUrl TEXT`);
  await ensureTableColumn("jobs", "imageUrl", `ALTER TABLE jobs ADD COLUMN imageUrl TEXT`);
  await ensureTableColumn("jobs", "description", `ALTER TABLE jobs ADD COLUMN description TEXT`);
  await ensureTableColumn("jobs", "status", `ALTER TABLE jobs ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  await ensureTableColumn("jobs", "applicationMode", `ALTER TABLE jobs ADD COLUMN applicationMode TEXT NOT NULL DEFAULT 'external'`);
  await ensureTableColumn("jobs", "applicationFieldsJson", `ALTER TABLE jobs ADD COLUMN applicationFieldsJson TEXT`);
  await ensureTableColumn("jobs", "viewCount", `ALTER TABLE jobs ADD COLUMN viewCount INTEGER NOT NULL DEFAULT 0`);
  await ensureTableColumn("jobs", "createdAt", `ALTER TABLE jobs ADD COLUMN createdAt TEXT DEFAULT (datetime('now'))`);
  await ensureTableColumn("jobs", "updatedAt", `ALTER TABLE jobs ADD COLUMN updatedAt TEXT DEFAULT (datetime('now'))`);

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_jobs_city ON jobs(city)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_jobs_slug ON jobs(slug)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status)`);
  } catch (_) {}
}

async function ensureJobApplicantSchema() {
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

  await ensureTableColumn("job_applicants", "resumeUrl", `ALTER TABLE job_applicants ADD COLUMN resumeUrl TEXT`);
  await ensureTableColumn("job_applicants", "coverLetter", `ALTER TABLE job_applicants ADD COLUMN coverLetter TEXT`);
  await ensureTableColumn("job_applicants", "fieldsJson", `ALTER TABLE job_applicants ADD COLUMN fieldsJson TEXT`);
  await ensureTableColumn("job_applicants", "status", `ALTER TABLE job_applicants ADD COLUMN status TEXT NOT NULL DEFAULT 'new'`);
  await ensureTableColumn("job_applicants", "source", `ALTER TABLE job_applicants ADD COLUMN source TEXT`);
  await ensureTableColumn("job_applicants", "createdAt", `ALTER TABLE job_applicants ADD COLUMN createdAt TEXT DEFAULT (datetime('now'))`);
  await ensureTableColumn("job_applicants", "updatedAt", `ALTER TABLE job_applicants ADD COLUMN updatedAt TEXT DEFAULT (datetime('now'))`);

  try {
    await run(`CREATE INDEX IF NOT EXISTS idx_job_applicants_jobId ON job_applicants(jobId)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_job_applicants_status ON job_applicants(status)`);
    await run(`CREATE INDEX IF NOT EXISTS idx_job_applicants_createdAt ON job_applicants(createdAt)`);
  } catch (_) {}
}

async function loadActiveJob(idOrSlug) {
  const raw = String(idOrSlug || "").trim();
  const isNumericId = /^\d+$/.test(raw);
  return isNumericId
    ? get(
        `SELECT id, city, slug, title, company, location, employmentType, employmentTypesJson, partTime, fullTime, salaryRange, applyUrl, imageUrl, description, status, applicationMode, applicationFieldsJson, viewCount, createdAt, updatedAt
         FROM jobs WHERE id = ? AND LOWER(COALESCE(status, 'active')) = 'active' LIMIT 1`,
        [Number(raw)]
      )
    : get(
        `SELECT id, city, slug, title, company, location, employmentType, employmentTypesJson, partTime, fullTime, salaryRange, applyUrl, imageUrl, description, status, applicationMode, applicationFieldsJson, viewCount, createdAt, updatedAt
         FROM jobs WHERE slug = ? AND LOWER(COALESCE(status, 'active')) = 'active' LIMIT 1`,
        [raw]
      );
}

function trimBodyField(body, key, lower = false) {
  const value = String(body?.[key] || "").trim();
  return lower ? value.toLowerCase() : value;
}

function getResumeUrl(file, req) {
  if (!file) return "";
  if (useR2) {
    const base = String(R2_PUBLIC_URL || "").replace(/\/$/, "");
    const key = file.key || file.filename || "";
    return base && key ? `${base}/${key}` : "";
  }
  if (file.filename) {
    return `${getBaseUrl(req)}/uploads/${file.filename}`;
  }
  return "";
}

router.get("/", async (req, res) => {
  try {
    await ensureJobSchema();

    const city = String(req.query.city || "").trim();
    const q = String(req.query.q || "").trim();
    const includeAllStatuses = String(req.query.includeAllStatuses || "").trim() === "1";
    const page = Math.max(1, parseInt(String(req.query.page || req.query.pg || "1"), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20));
    const offset = (page - 1) * limit;

    const where = [];
    const params = [];

    if (!includeAllStatuses) {
      where.push("LOWER(COALESCE(status, 'active')) = 'active'");
    }
    if (city) {
      where.push("city = ?");
      params.push(city);
    }
    if (q) {
      const like = `%${q}%`;
      where.push("(title LIKE ? OR company LIKE ? OR location LIKE ? OR employmentType LIKE ? OR employmentTypesJson LIKE ? OR slug LIKE ?)");
      params.push(like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countRow = await get(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`, params);
    const total = Number(countRow?.n || 0);
    const rows = await all(
      `SELECT id, city, slug, title, company, location, employmentType, employmentTypesJson, partTime, fullTime, salaryRange, applyUrl, imageUrl, description, status, applicationMode, applicationFieldsJson, viewCount, createdAt, updatedAt
       FROM jobs ${whereSql}
       ORDER BY datetime(createdAt) DESC, id DESC
       LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    return res.json({
      ok: true,
      data: rows.map((row) => buildJobPayload(row, req)),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit))
      },
      filters: {
        city: city || null,
        q: q || null,
        includeAllStatuses
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to load jobs." });
  }
});

router.get("/:idOrSlug", async (req, res) => {
  try {
    await ensureJobSchema();

    const row = await loadActiveJob(req.params.idOrSlug);
    if (!row) return res.status(404).json({ ok: false, error: "Job not found." });

    await run("UPDATE jobs SET viewCount = COALESCE(viewCount, 0) + 1, updatedAt = datetime('now') WHERE id = ?", [row.id]);
    row.viewCount = Number(row.viewCount || 0) + 1;
    row.updatedAt = new Date().toISOString();

    return res.json({ ok: true, data: buildJobPayload(row, req) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to load job." });
  }
});

router.post("/:idOrSlug/apply", resumeUpload.single("resumeFile"), async (req, res) => {
  try {
    await ensureJobSchema();
    await ensureJobApplicantSchema();

    const job = await loadActiveJob(req.params.idOrSlug);
    if (!job) return res.status(404).json({ ok: false, error: "Job not found." });

    const applicationMode = normalizeJobApplicationMode(job.applicationMode || "external");
    if (!(applicationMode === "website" || applicationMode === "both")) {
      return res.status(400).json({ ok: false, error: "This job does not accept website applications." });
    }

    const fieldConfig = normalizeJobApplicationFields(safeParseJson(job.applicationFieldsJson, null));
    const fields = {
      firstName: trimBodyField(req.body, "firstName"),
      lastName: trimBodyField(req.body, "lastName"),
      email: trimBodyField(req.body, "email", true),
      phone: trimBodyField(req.body, "phone"),
      coverLetter: trimBodyField(req.body, "coverLetter"),
    };
    const resumeUrl = getResumeUrl(req.file, req);

    const errors = [];
    for (const field of JOB_APPLICATION_FIELDS) {
      if (fieldConfig[field.key] !== "required") continue;
      if (field.key === "resume") {
        if (!resumeUrl) errors.push("Resume upload is required.");
        continue;
      }
      if (!fields[field.key]) errors.push(`${field.label} is required.`);
    }
    if (fieldConfig.email !== "off" && fields.email) {
      const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(fields.email);
      if (!isEmail) errors.push("Email must be valid.");
    }

    if (errors.length) {
      return res.status(400).json({ ok: false, error: errors[0], errors });
    }

    const submittedFields = {};
    for (const field of JOB_APPLICATION_FIELDS) {
      if (fieldConfig[field.key] === "off") continue;
      submittedFields[field.key] = field.key === "resume" ? Boolean(resumeUrl) : fields[field.key] || "";
    }

    await run(
      `INSERT INTO job_applicants (jobId, firstName, lastName, email, phone, resumeUrl, coverLetter, fieldsJson, status, source, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'new', ?, datetime('now'), datetime('now'))`,
      [
        job.id,
        fieldConfig.firstName === "off" ? null : (fields.firstName || null),
        fieldConfig.lastName === "off" ? null : (fields.lastName || null),
        fieldConfig.email === "off" ? null : (fields.email || null),
        fieldConfig.phone === "off" ? null : (fields.phone || null),
        fieldConfig.resume === "off" ? null : (resumeUrl || null),
        fieldConfig.coverLetter === "off" ? null : (fields.coverLetter || null),
        JSON.stringify(submittedFields),
        trimBodyField(req.body, "source") || "website"
      ]
    );

    return res.status(201).json({
      ok: true,
      message: "Application submitted successfully.",
      data: {
        jobId: Number(job.id),
        jobSlug: String(job.slug || ""),
        applicationMode,
      }
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to submit application." });
  }
});

module.exports = router;
