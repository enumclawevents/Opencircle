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
        .card{background:#111827; padding:28px; border-radius:12px; width:360px; box-shadow:0 10px 30px rgba(0,0,0,.3);}
        .logo{display:block; width:160px; max-width:100%; margin:0 0 14px;}
        .title{font-size:22px; font-weight:700; margin:0 0 6px; color:#e5e7eb;}
        .subtitle{font-size:13px; color:#9ca3af; margin:0 0 18px;}
        label{font-size:12px; color:#9ca3af;}
        input{width:100%; box-sizing:border-box; margin:6px 0 14px; padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:#0f172a; color:#e5e7eb;}
        .row-between{display:flex; align-items:center; justify-content:space-between; margin:6px 0 14px;}
        button{width:100%; height:40px; border-radius:8px; border:0; background:#00c08b; color:#fff; font-weight:600; cursor:pointer;}
        .remember{display:flex; align-items:center; gap:8px; font-size:12px; color:#9ca3af; white-space:nowrap;}
        .forgot{font-size:12px; color:#a5b4fc; text-decoration:none;}
        .forgot:hover{color:#c7d2fe;}
        .remember input{
          -webkit-appearance: none;
          appearance: none;
          width:18px;
          height:18px;
          margin:0;
          border-radius:0;
          border:2px solid #dbe2ea;
          background:#0f172a;
          display:inline-block;
          position:relative;
          box-shadow: 0 0 0 3px rgba(14,165,233,0);
        }
        .remember input:checked{
          border-color:#0ea5e9;
          box-shadow: 0 0 0 3px rgba(14,165,233,.35);
        }
        .remember input:checked::after{
          content:"";
          position:absolute;
          inset:3px;
          background:#10b981;
        }
        .remember input:focus-visible{
          outline:2px solid rgba(14,165,233,.7);
          outline-offset:2px;
        }
        .below-link{display:block; margin-top:14px; font-size:12px; color:#9ca3af; text-align:center;}
        .below-link a{color:#a5b4fc; text-decoration:none;}
        .below-link a:hover{color:#c7d2fe;}
      </style>
    </head>
    <body>
      <form class="card" method="POST" action="/login">
        <img class="logo" src="/assets/brand/oc-logo.svg" alt="OpenCircle" />
        <div class="title">Welcome back</div>
        <div class="subtitle">Welcome back! Please enter your details.</div>
        <label>Username</label>
        <input name="username" type="text" placeholder="Enter your username" required />
        <label>Password</label>
        <input name="password" type="password" required />
        <div class="row-between">
          <label class="remember">
            <input type="checkbox" id="rememberUser" />
            Remember for 30 days
          </label>
          <a class="forgot" href="/forgot">Forgot password</a>
        </div>
        <button type="submit">Sign in</button>
        <div class="below-link">Don’t have an account? <a href="/signup">Sign up</a></div>
      </form>
      <script>
        (function(){
          var userInput = document.querySelector('input[name=\"username\"]');
          var remember = document.getElementById('rememberUser');
          try{
            var saved = localStorage.getItem('oc_saved_user');
            if(saved && userInput) { userInput.value = saved; remember.checked = true; }
          }catch(e){}
          var form = document.querySelector('form');
          if(form){
            form.addEventListener('submit', function(){
              try{
                if(remember && remember.checked){
                  localStorage.setItem('oc_saved_user', userInput.value || '');
                }else{
                  localStorage.removeItem('oc_saved_user');
                }
              }catch(e){}
            });
          }
        })();
      </script>
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
