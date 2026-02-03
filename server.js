"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");

const { initDB, archiveExpiredEvents } = require("./db");

initDB()
  .then(async () => {
    // run once on boot
    await archiveExpiredEvents();

    // run every 15 minutes
    setInterval(() => {
      archiveExpiredEvents().catch((e) => console.error("[ARCHIVE JOB]", e));
    }, 15 * 60 * 1000);

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`OpenCircle API running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[BOOT] DB init failed:", err);
    process.exit(1);
  });

const eventsRouter = require("./routes/events");
const adminRouter = require("./routes/admin");

const app = express();

// If behind Render proxy, this helps req.protocol be correct
app.set("trust proxy", 1);

// --------------------
// Persistent uploads
// --------------------
const UPLOADS_DIR =
  process.env.UPLOADS_DIR ||
  (process.env.RENDER_DISK_PATH
    ? path.join(process.env.RENDER_DISK_PATH, "uploads")
    : path.join(process.cwd(), "uploads"));

fs.mkdirSync(UPLOADS_DIR, { recursive: true });
console.log("[UPLOADS] Using folder:", UPLOADS_DIR);

// Host uploads publicly
app.use("/uploads", express.static(UPLOADS_DIR));

// Static assets
app.use("/assets", express.static(path.join(__dirname, "public")));

// Middleware
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// --------------------
// Basic Auth for /admin
// --------------------
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
  } catch (_) {
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

app.get("/health", (req, res) => res.status(200).send("ok"));
app.use(express.json());
app.use(express.text({ type: "text/plain" })); // for sendBeacon payloads

// Routes
app.use("/events", eventsRouter);
app.use("/admin", requireAdmin, adminRouter);

// Global error handler (so 500s are logged)
app.use((err, req, res, next) => {
  console.error("[EXPRESS] Unhandled error:", err);
  res.status(500).json({ error: "Server error" });
});

// Start only AFTER DB init (prevents random 500s)
const PORT = Number(process.env.PORT) || 3000;

initDB()
  .then(() => {
    app.listen(PORT, "0.0.0.0", () => {
      console.log(`OpenCircle API running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[BOOT] DB init failed:", err);
    process.exit(1);
  });

// Export for routers if needed
module.exports = { UPLOADS_DIR };
