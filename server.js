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

// Allow cross-origin requests
app.use(cors());

// Body parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ---- Simple Admin Auth (Basic Auth) ----
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "opencircle";

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || "";
  const parts = header.split(" ");

  if (parts.length !== 2 || parts[0] !== "Basic") {
    res.setHeader("WWW-Authenticate", 'Basic realm="OpenCircle Admin"');
    return res.status(401).send("Authentication required.");
  }

  let decoded;
  try {
    decoded = Buffer.from(parts[1], "base64").toString("utf8");
  } catch {
    return res.status(401).send("Invalid authorization header.");
  }

  const idx = decoded.indexOf(":");
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);

  if (user === ADMIN_USER && pass === ADMIN_PASS) return next();

  res.setHeader("WWW-Authenticate", 'Basic realm="OpenCircle Admin"');
  return res.status(401).send("Invalid credentials.");
}

// Root
app.get("/", (req, res) => {
  res.json({
    name: "OpenCircle API",
    status: "ok",
    endpoints: ["/events", "/events/:id", "/admin"]
  });
});

// Health check (Render-friendly)
app.get("/health", (req, res) => {
  res.status(200).send("ok");
});

// Routes
app.use("/events", eventsRouter);
app.use("/admin", requireAdmin, adminRouter);

// Start server
const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenCircle API running on port ${PORT}`);
});
