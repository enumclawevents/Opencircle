\
"use strict";

const express = require("express");
const path = require("path");
const fs = require("fs");
const cors = require("cors");

const { initDB } = require("./db");

const adminRoutes = require("./routes/admin");
const eventsRoutes = require("./routes/events");

const app = express();

// ---------- middleware ----------
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// ---------- persistent uploads (Render disk or local) ----------
// IMPORTANT: this MUST match the UPLOAD_DIR logic used in routes/admin.js
const UPLOAD_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.RENDER_DISK_PATH
    ? path.join(process.env.RENDER_DISK_PATH, "uploads")
    : path.join(process.cwd(), "uploads"));

fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// Serve uploaded images
app.use("/uploads", express.static(UPLOAD_DIR));

// Serve your public assets (logo/favicon/etc.)
app.use("/assets", express.static(path.join(__dirname, "public", "assets")));

// ---------- routes ----------
app.get("/", (req, res) => res.send("OpenCircle API is running."));
app.use("/admin", adminRoutes);
app.use("/events", eventsRoutes);

// ---------- boot ----------
const port = process.env.PORT || 3000;

// CRITICAL: ensure tables/migrations exist before serving requests
initDB()
  .then(() => {
    app.listen(port, () => {
      console.log(`OpenCircle API listening on port ${port}`);
      console.log(`Uploads dir: ${UPLOAD_DIR}`);
    });
  })
  .catch((err) => {
    console.error("DB init failed:", err);
    process.exit(1);
  });

module.exports = app;
