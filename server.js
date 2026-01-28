// server.js
"use strict";

const express = require("express");
const cors = require("cors");
const path = require("path");

const eventsRouter = require("./routes/events");
const adminRouter = require("./routes/admin");

const app = express();

// Serve static assets from /public at /assets/*
app.use("/assets", express.static(path.join(__dirname, "public")));

// Allows other websites/apps to call this API
app.use(cors());

// Body parsers (JSON + form posts)
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true, limit: "2mb" }));

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
    endpoints: ["/events", "/events/:id", "/admin", "/assets/brand/*"]
  });
});

// Optional health check endpoint (useful on Render)
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// Public API
app.use("/events", eventsRouter);

// Admin (protected)
app.use("/admin", requireAdmin, adminRouter);

// Start server
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenCircle API running on port ${PORT}`);
});
