// server.js
"use strict";

const path = require("path");
const express = require("express");
const cors = require("cors");
const fs = require("fs");

const eventsRouter = require("./routes/events");
const adminRouter = require("./routes/admin");

const app = express();

// If behind Render proxy, this helps req.protocol be correct
app.set("trust proxy", 1);

// Serve static assets from /public at /assets/*
app.use("/assets", express.static(path.join(__dirname, "public")));

/**
 * UPLOADS DIR
 * Use Render disk mount so uploads persist across deploys.
 */
const UPLOADS_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.RENDER_DISK_PATH
    ? path.join(process.env.RENDER_DISK_PATH, "uploads")
    : path.join(__dirname, "uploads"));

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
console.log("[UPLOADS] Using folder:", UPLOADS_DIR);

// Host uploads publicly
app.use("/uploads", express.static(UPLOADS_DIR));

// Allows other websites/apps to call this API
app.use(cors());

// Body parsers (JSON + form posts)
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- Simple Admin Password (Basic Auth) ---
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "opencircle";

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const [type, token] = header.split(" ");

  if (type !== "Basic" || !token) {
    res.setHeader("WWW-Authenticate", 'Basic realm="OpenCircle Admin"');
    return res.status(401).send("Authentication required.");
  }

  let decoded = "";
  try {
    decoded = Buffer.from(token, "base64").toString("utf8");
  } catch (e) {
    res.setHeader("WWW-Authenticate", 'Basic realm="OpenCircle Admin"');
    return res.status(401).send("Invalid authorization header.");
  }

  const idx = decoded.indexOf(":");
  const user = idx >= 0 ? decoded.slice(0, idx) : "";
  const pass = idx >= 0 ? decoded.slice(idx + 1) : "";

  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();

  res.setHeader("WWW-Authenticate", 'Basic realm="OpenCircle Admin"');
  return res.status(401).send("Invalid credentials.");
}

// Home test route
app.get("/", (req, res) => {
  res.json({
    name: "OpenCircle API",
    status: "ok",
    endpoints: ["/events", "/events/:id", "/admin", "/uploads/*", "/assets/brand/*"],
  });
});

// Health check endpoint
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// Public API
app.use("/events", eventsRouter);

// Admin (protected)
app.use("/admin", requireAdmin, adminRouter);

// --- Static uploads ---

const UPLOAD_DIR =
  process.env.UPLOAD_DIR ||
  (process.env.RENDER_DISK_PATH
    ? path.join(process.env.RENDER_DISK_PATH, "uploads")
    : path.join(__dirname, "uploads"));

app.use("/uploads", express.static(UPLOAD_DIR));


// Start server
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenCircle API running on port ${PORT}`);
});

// Export for admin router to reuse uploads dir if desired
module.exports = { UPLOADS_DIR };
