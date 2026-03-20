"use strict";

const express = require("express");
const { all, get, run } = require("../db");

const router = express.Router();

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

function buildJobPayload(row, req) {
  if (!row) return null;

  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  const baseUrl = `${proto}://${host}`;

  return {
    id: Number(row.id),
    city: String(row.city || ""),
    slug: String(row.slug || ""),
    title: String(row.title || ""),
    company: String(row.company || ""),
    location: String(row.location || ""),
    employmentType: String(row.employmentType || ""),
    salaryRange: String(row.salaryRange || ""),
    applyUrl: normalizeHttpUrl(row.applyUrl || ""),
    imageUrl: normalizeHttpUrl(row.imageUrl || ""),
    description: String(row.description || ""),
    status: String(row.status || "active"),
    viewCount: Number(row.viewCount || 0),
    createdAt: row.createdAt || null,
    updatedAt: row.updatedAt || null,
    jsonUrl: `${baseUrl}/jobs/${encodeURIComponent(row.slug || row.id)}`
  };
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
      salaryRange TEXT,
      applyUrl TEXT,
      imageUrl TEXT,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      viewCount INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);
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
      where.push("(title LIKE ? OR company LIKE ? OR location LIKE ? OR employmentType LIKE ? OR slug LIKE ?)");
      params.push(like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const countRow = await get(`SELECT COUNT(*) AS n FROM jobs ${whereSql}`, params);
    const total = Number(countRow?.n || 0);
    const rows = await all(
      `SELECT id, city, slug, title, company, location, employmentType, salaryRange, applyUrl, imageUrl, description, status, viewCount, createdAt, updatedAt
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

    const raw = String(req.params.idOrSlug || "").trim();
    const isNumericId = /^\d+$/.test(raw);
    const row = isNumericId
      ? await get(
        `SELECT id, city, slug, title, company, location, employmentType, salaryRange, applyUrl, imageUrl, description, status, viewCount, createdAt, updatedAt
         FROM jobs WHERE id = ? AND LOWER(COALESCE(status, 'active')) = 'active' LIMIT 1`,
        [Number(raw)]
      )
      : await get(
        `SELECT id, city, slug, title, company, location, employmentType, salaryRange, applyUrl, imageUrl, description, status, viewCount, createdAt, updatedAt
         FROM jobs WHERE slug = ? AND LOWER(COALESCE(status, 'active')) = 'active' LIMIT 1`,
        [raw]
      );

    if (!row) return res.status(404).json({ ok: false, error: "Job not found." });

    await run("UPDATE jobs SET viewCount = COALESCE(viewCount, 0) + 1, updatedAt = COALESCE(updatedAt, datetime('now')) WHERE id = ?", [row.id]);
    row.viewCount = Number(row.viewCount || 0) + 1;

    return res.json({ ok: true, data: buildJobPayload(row, req) });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: "Failed to load job." });
  }
});

module.exports = router;
