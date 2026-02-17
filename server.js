"use strict";

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");

const { initDB, archiveExpiredEvents } = require("./db");

const eventsRouter = require("./routes/events");
const adminRouter = require("./routes/admin");

const app = express();
app.locals.reqTimes = [];

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
const allowedOrigins = [
  "https://enumclawevents.org",
  "https://www.enumclawevents.org",
  "https://api.opencircleapi.com",
].filter(Boolean);

const envAllow = String(process.env.CORS_ALLOWLIST || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use((req, _res, next) => {
  const now = Date.now();
  const arr = app.locals.reqTimes || [];
  arr.push(now);
  const cutoff = now - 5 * 60 * 1000;
  while (arr.length && arr[0] < cutoff) arr.shift();
  app.locals.reqTimes = arr;
  next();
});

app.use(
  cors({
    origin: (origin, cb) => {
      // allow server-to-server / curl with no origin
      if (!origin) return cb(null, true);

      // allow explicit allowlist
      if (allowedOrigins.includes(origin)) return cb(null, true);
      if (envAllow.includes(origin)) return cb(null, true);

      return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  })
);
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// --------------------
// Login (session cookie)
// --------------------
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "opencircle";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const sessions = new Map();

function parseCookies(cookieHeader) {
  const out = {};
  String(cookieHeader || "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const idx = pair.indexOf("=");
      if (idx < 0) return;
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
      out[k] = decodeURIComponent(v);
    });
  return out;
}

function createSession(user) {
  const token = crypto.randomUUID();
  sessions.set(token, { user, exp: Date.now() + SESSION_TTL_MS });
  return token;
}

function getSession(token) {
  if (!token) return null;
  const sess = sessions.get(token);
  if (!sess) return null;
  if (Date.now() > sess.exp) {
    sessions.delete(token);
    return null;
  }
  return sess;
}

function requireLogin(req, res, next) {
  // allow login + public endpoints
  if (
    req.path === "/login" ||
    req.path === "/health" ||
    (req.path.startsWith("/events") && !req.path.startsWith("/events/submit")) ||
    req.path.startsWith("/uploads") ||
    req.path.startsWith("/assets")
  ) {
    return next();
  }

  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.oc_auth;
  const sess = getSession(token);
  if (sess) return next();

  const wantsHtml = (req.headers.accept || "").includes("text/html");
  if (wantsHtml) return res.redirect("/login");
  return res.status(401).json({ error: "Unauthorized" });
}

app.get("/login", (req, res) => {
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>Login</title>
      <style>
        body{font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0b1220; color:#e5e7eb; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;}
        .card{background:#111827; padding:24px; border-radius:12px; width:320px; box-shadow:0 10px 30px rgba(0,0,0,.3);}
        .logo{display:block; width:180px; max-width:100%; margin:0 auto 16px;}
        label{font-size:12px; color:#9ca3af;}
        input{width:100%; box-sizing:border-box; margin:6px 0 14px; padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:#0f172a; color:#e5e7eb;}
        button{width:100%; height:40px; border-radius:8px; border:0; background:#00c08b; color:#fff; font-weight:600; cursor:pointer;}
      </style>
    </head>
    <body>
      <form class="card" method="POST" action="/login">
        <img class="logo" src="/assets/brand/oc-logo.svg" alt="OpenCircle" />
        <label>Username</label>
        <input name="username" required />
        <label>Password</label>
        <input name="password" type="password" required />
        <button type="submit">Sign in</button>
      </form>
    </body>
  </html>`;
  res.send(html);
});

app.post("/login", (req, res) => {
  const user = String(req.body?.username || "");
  const pass = String(req.body?.password || "");
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = createSession(user);
    res.cookie("oc_auth", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: String(process.env.NODE_ENV || "").toLowerCase() === "production",
      maxAge: SESSION_TTL_MS,
      path: "/",
    });
    return res.redirect("/admin");
  }
  return res.status(401).send("Invalid credentials");
});

app.post("/logout", (req, res) => {
  res.setHeader("Set-Cookie", "oc_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  return res.redirect("/login");
});

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
app.use(requireLogin);
app.use("/events", eventsRouter);
app.use("/admin", adminRouter);

// Global error handler (so 500s are logged)
app.use((err, req, res, next) => {
  console.error("[EXPRESS] Unhandled error:", err);
  res.status(500).json({ error: "Server error" });
});

// Start only AFTER DB init (prevents random 500s)
const PORT = Number(process.env.PORT) || 3000;

initDB()
  .then(async () => {
    // Run once on boot
    try {
      const r = await archiveExpiredEvents();
      if (r?.archived) console.log("[ARCHIVE] Archived on boot:", r.archived);
    } catch (e) {
      console.error("[ARCHIVE] Boot run failed:", e);
    }

    // Run every 15 minutes
    setInterval(() => {
      archiveExpiredEvents()
        .then((r) => {
          if (r?.archived) console.log("[ARCHIVE] Archived:", r.archived);
        })
        .catch((e) => console.error("[ARCHIVE] Interval failed:", e));
    }, 15 * 60 * 1000);

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
