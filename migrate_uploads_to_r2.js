"use strict";

// One-time migration: local /uploads -> R2, then update imageUrl in SQLite.
// Usage:
//   node migrate_uploads_to_r2.js [--dry-run] [--limit=100]

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { DB_PATH } = require("./db");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Math.max(1, parseInt(limitArg.split("=")[1], 10) || 0) : 0;

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || "";
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID || "";
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY || "";
const R2_BUCKET = process.env.R2_BUCKET || "";
const R2_PUBLIC_URL = process.env.R2_PUBLIC_URL || "";

const useR2 =
  R2_ACCOUNT_ID && R2_ACCESS_KEY_ID && R2_SECRET_ACCESS_KEY && R2_BUCKET && R2_PUBLIC_URL;

if (!useR2) {
  console.error("Missing R2 env vars. Set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET, R2_PUBLIC_URL.");
  process.exit(1);
}

const UPLOAD_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.RENDER_DISK_PATH
    ? path.join(process.env.RENDER_DISK_PATH, "uploads")
    : path.join(process.cwd(), "uploads"));

const r2 = new S3Client({
  region: "auto",
  endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: R2_ACCESS_KEY_ID,
    secretAccessKey: R2_SECRET_ACCESS_KEY,
  },
  forcePathStyle: true,
});

function contentTypeFor(file) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".png") return "image/png";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

function openDb() {
  return new sqlite3.Database(DB_PATH);
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

async function main() {
  const db = openDb();

  const rows = await all(
    db,
    `SELECT id, imageUrl
     FROM events
     WHERE imageUrl LIKE '%/uploads/%'`
  );

  const targets = limit ? rows.slice(0, limit) : rows;
  console.log(`Found ${rows.length} events with /uploads/ images. Processing ${targets.length}.`);

  let updated = 0;
  let skipped = 0;

  for (const row of targets) {
    const url = String(row.imageUrl || "");
    const match = url.match(/\/uploads\/([^/?#]+)/);
    if (!match) {
      skipped++;
      continue;
    }
    const filename = match[1];
    const localPath = path.join(UPLOAD_DIR, filename);

    if (!fs.existsSync(localPath)) {
      console.warn(`Missing file: ${localPath} (event ${row.id})`);
      skipped++;
      continue;
    }

    const key = filename;
    const publicBase = String(R2_PUBLIC_URL).replace(/\/$/, "");
    const newUrl = `${publicBase}/${key}`;

    if (!dryRun) {
      const body = fs.createReadStream(localPath);
      await r2.send(
        new PutObjectCommand({
          Bucket: R2_BUCKET,
          Key: key,
          Body: body,
          ContentType: contentTypeFor(filename),
        })
      );

      await run(db, `UPDATE events SET imageUrl = ? WHERE id = ?`, [newUrl, row.id]);
    }

    updated++;
    console.log(`${dryRun ? "[DRY]" : "[OK]"} event ${row.id} -> ${newUrl}`);
  }

  console.log(`Done. Updated: ${updated}, Skipped: ${skipped}`);
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
