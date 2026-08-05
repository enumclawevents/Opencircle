"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");

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

const TEMP_UPLOAD_DIR = path.join(os.tmpdir(), "opencircle-upload-tmp");

if (!useR2) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}
fs.mkdirSync(TEMP_UPLOAD_DIR, { recursive: true });

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

function buildUploadBaseName(inputName, fallback = "image") {
  const ext = path.extname(inputName || "").toLowerCase();
  const base = path
    .basename(inputName || fallback, ext)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return base || fallback;
}

function buildTempUploadKey(file) {
  const base = buildUploadBaseName(file?.originalname || "", "upload");
  return `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function buildStoredImageKey(inputName, fallback = "image") {
  const base = buildUploadBaseName(inputName, fallback);
  return `${base}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.webp`;
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, TEMP_UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, buildTempUploadKey(file)),
});

function imageFileFilter(_req, file, cb) {
  const ok = /^image\//i.test(file.mimetype || "");
  cb(ok ? null : new Error("Only image files are allowed."), ok);
}

const upload = multer({
  storage,
  fileFilter: imageFileFilter,
});

const bulkImportUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (_req, file, cb) => {
    const name = String(file.originalname || "").toLowerCase();
    const mime = String(file.mimetype || "").toLowerCase();
    let ok = false;
    if (file.fieldname === "eventsCsv") {
      ok = name.endsWith(".csv") || mime === "text/csv" || mime === "application/vnd.ms-excel";
    } else if (file.fieldname === "imageZip") {
      ok = name.endsWith(".zip") || mime === "application/zip" || mime === "application/x-zip-compressed" || mime === "multipart/x-zip";
    }
    cb(ok ? null : new Error("Only CSV files are allowed."), ok);
  },
  limits: { fileSize: 25 * 1024 * 1024 },
});

function buildLocalUploadUrl(fileName, req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}/uploads/${fileName}`;
}

async function processAndPersistImage(inputPath, sourceName, req) {
  const outputKey = buildStoredImageKey(sourceName, "image");
  const imageBuffer = await sharp(inputPath)
    .rotate()
    .resize(1920, 1080, {
      fit: "contain",
      position: "centre",
      background: { r: 229, g: 231, b: 235, alpha: 1 },
    })
    .withMetadata({ density: 72 })
    .webp({ quality: 85 })
    .toBuffer();

  if (useR2) {
    await r2Client.send(new PutObjectCommand({
      Bucket: R2_BUCKET,
      Key: outputKey,
      Body: imageBuffer,
      ContentType: "image/webp",
      CacheControl: "public, max-age=31536000, immutable",
    }));
    const base = String(R2_PUBLIC_URL || "").replace(/\/$/, "");
    return `${base}/${outputKey}`;
  }

  const destPath = path.join(UPLOAD_DIR, outputKey);
  fs.writeFileSync(destPath, imageBuffer);
  return buildLocalUploadUrl(outputKey, req);
}

async function persistUploadedImage(file, req) {
  if (!file?.path) return "";
  try {
    return await processAndPersistImage(file.path, file.originalname || file.filename || "image", req);
  } finally {
    try {
      fs.rmSync(file.path, { force: true });
    } catch (_) {}
  }
}

async function persistImportedImage(localPath, req) {
  if (!localPath || !fs.existsSync(localPath)) return "";
  return processAndPersistImage(localPath, path.basename(localPath), req);
}

module.exports = {
  UPLOAD_DIR,
  TEMP_UPLOAD_DIR,
  bulkImportUpload,
  persistImportedImage,
  persistUploadedImage,
  processAndPersistImage,
  upload,
  useR2,
};
