"use strict";

const path = require("path");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { sendEmail, PASSWORD_RESET_FROM, PASSWORD_RESET_REPLY_TO } = require("./mailer");
const { hashPassword, hashToken, verifyPassword } = require("./lib/auth");
const { esc } = require("./lib/html");
const { UPLOAD_DIR } = require("./lib/uploads");

const { initDB, archiveExpiredEvents, get, run } = require("./db");

const eventsRouter = require("./routes/events");
const adminRouter = require("./routes/admin");
const venuesRouter = require("./routes/venues");
const adsRouter = require("./routes/ads");
const jobsRouter = require("./routes/jobs");

const app = express();
app.locals.reqTimes = [];

// If behind Render proxy, this helps req.protocol be correct
app.set("trust proxy", 1);

console.log("[UPLOADS] Using folder:", UPLOAD_DIR);

// Host uploads publicly
app.use("/uploads", express.static(UPLOAD_DIR));

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
let lastSessionPruneAt = 0;
const INVITE_TTL_HOURS = 7 * 24;
const RESET_TTL_HOURS = 1;
const PUBLIC_PATHS = new Set(["/login", "/signup", "/invite", "/forgot", "/health"]);
const PUBLIC_PREFIXES = [
  "/events/submit",
  "/events/feature",
  "/events",
  "/venues",
  "/ads",
  "/jobs",
  "/uploads",
  "/assets",
];


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

async function createSession(user, role = "organizer", city = "Enumclaw") {
  const token = crypto.randomUUID();
  const exp = Date.now() + SESSION_TTL_MS;
  const session = { user, role, city, exp };
  sessions.set(token, session);
  await run(
    "INSERT OR REPLACE INTO auth_sessions (tokenHash, user, role, city, exp, createdAt) VALUES (?, ?, ?, ?, ?, datetime('now'))",
    [hashToken(token), user, role, city, exp]
  );
  return token;
}

async function pruneExpiredSessions(now = Date.now()) {
  for (const [token, sess] of sessions.entries()) {
    if (!sess || !Number.isFinite(sess.exp) || now > sess.exp) {
      sessions.delete(token);
    }
  }
  try {
    await run("DELETE FROM auth_sessions WHERE exp IS NULL OR exp <= ?", [now]);
  } catch (_) {}
  lastSessionPruneAt = now;
}

async function getSession(token) {
  if (!token) return null;
  const sess = sessions.get(token);
  const now = Date.now();
  if (sess && now <= sess.exp) {
    return sess;
  }
  if (sess) {
    sessions.delete(token);
  }
  const row = await get(
    "SELECT user, role, city, exp FROM auth_sessions WHERE tokenHash = ? LIMIT 1",
    [hashToken(token)]
  );
  if (!row) return null;
  if (!Number.isFinite(row.exp) || now > row.exp) {
    try {
      await run("DELETE FROM auth_sessions WHERE tokenHash = ?", [hashToken(token)]);
    } catch (_) {}
    return null;
  }
  const restored = {
    user: row.user,
    role: row.role || "organizer",
    city: row.city || "Enumclaw",
    exp: row.exp,
  };
  sessions.set(token, restored);
  return restored;
}

async function destroySession(token) {
  if (!token) return;
  sessions.delete(token);
  try {
    await run("DELETE FROM auth_sessions WHERE tokenHash = ?", [hashToken(token)]);
  } catch (_) {}
}

function isPublicPath(pathname) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

async function requireLogin(req, res, next) {
  const now = Date.now();
  if ((now - lastSessionPruneAt) > (30 * 60 * 1000)) {
    await pruneExpiredSessions(now);
  }
  // Parse session first so public endpoints can still see req.user when logged in.
  const cookies = parseCookies(req.headers.cookie || "");
  const token = cookies.oc_auth;
  const sess = await getSession(token);
  if (sess) {
    req.user = sess;
    const sessionKey = String(sess.user || "").trim();
    if (sessionKey) {
      run(
        "UPDATE users SET lastSeenAt = datetime('now') WHERE lower(COALESCE(username,'')) = lower(?) OR lower(COALESCE(email,'')) = lower(?)",
        [sessionKey, sessionKey]
      ).catch(() => {});
    }
  }

  // allow login + public endpoints
  if (isPublicPath(req.path)) {
    return next();
  }

  if (sess) {
    return next();
  }

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
      <link rel="icon" href="/assets/brand/favicon.ico" />
      <title>Login</title>
      <style>
        body{font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0b1220; color:#e5e7eb; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;}
        .card{background:#111827; padding:28px; border-radius:12px; width:360px; box-shadow:0 10px 30px rgba(0,0,0,.3);}
        .logo{display:block; width:160px; max-width:100%; margin:0 auto 30px;}
        .title{font-size:22px; font-weight:700; margin:0 0 6px; color:#e5e7eb; text-align:center;}
        .subtitle{font-size:13px; color:#9ca3af; margin:0 0 30px; text-align:center;}
        label{font-size:12px; color:#9ca3af;}
        input{width:100%; box-sizing:border-box; margin:6px 0 18px; padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:#0f172a; color:#e5e7eb;}
        .row-between{display:flex; align-items:center; justify-content:space-between; margin:10px 0 18px;}
        button{width:100%; height:40px; border-radius:8px; border:0; background:#00c08b; color:#fff; font-weight:600; cursor:pointer;}
        .remember{display:flex; align-items:center; gap:8px; font-size:12px; color:#9ca3af; white-space:nowrap;}
        .forgot{font-size:12px; color:#a5b4fc; text-decoration:none;}
        .forgot:hover{color:#c7d2fe;}
        .remember input{width:auto; margin:0;}
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
        <label>Email</label>
        <input name="username" type="email" placeholder="Enter your email" required />
        <label>Password</label>
        <input name="password" type="password" placeholder="Enter your password" required />
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
            var raw = localStorage.getItem('oc_saved_user_v2');
            if(raw){
              var data = JSON.parse(raw);
              if(data && data.value && data.exp && Date.now() < data.exp && userInput){
                userInput.value = data.value;
                remember.checked = true;
              } else {
                localStorage.removeItem('oc_saved_user_v2');
              }
            }
          }catch(e){}
          var form = document.querySelector('form');
          if(form){
            form.addEventListener('submit', function(){
              try{
                if(remember && remember.checked){
                  localStorage.setItem('oc_saved_user_v2', JSON.stringify({
                    value: userInput.value || '',
                    exp: Date.now() + (30 * 24 * 60 * 60 * 1000)
                  }));
                }else{
                  localStorage.removeItem('oc_saved_user_v2');
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

app.post("/login", async (req, res) => {
  const user = String(req.body?.username || "");
  const pass = String(req.body?.password || "");

  if (user && pass) {
    const row = await get(
      "SELECT id, username, email, passwordHash, role, city, permissionsJson FROM users WHERE username = ? OR email = ? LIMIT 1",
      [user, user]
    );
    if (row && verifyPassword(pass, row.passwordHash)) {
      const token = await createSession(row.username || row.email || "user", row.role || "organizer", row.city || "Enumclaw");
      res.cookie("oc_auth", token, {
        httpOnly: true,
        sameSite: "lax",
        secure: String(process.env.NODE_ENV || "").toLowerCase() === "production",
        maxAge: SESSION_TTL_MS,
        path: "/",
      });
      return res.redirect("/admin");
    }
  }

  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = await createSession(user, "developer", "Enumclaw");
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

app.get("/", (_req, res) => {
  return res.redirect("/admin");
});

app.get("/signup", (req, res) => {
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href="/assets/brand/favicon.ico" />
      <title>Sign up</title>
      <style>
        body{font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0b1220; color:#e5e7eb; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;}
        .card{background:#111827; padding:28px; border-radius:12px; width:360px; box-shadow:0 10px 30px rgba(0,0,0,.3);}
        .title{font-size:22px; font-weight:700; margin:0 0 6px; color:#e5e7eb; text-align:center;}
        .subtitle{font-size:13px; color:#9ca3af; margin:0 0 22px; text-align:center;}
        label{font-size:12px; color:#9ca3af;}
        input{width:100%; box-sizing:border-box; margin:6px 0 20px; padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:#0f172a; color:#e5e7eb;}
        button{width:100%; height:40px; border-radius:8px; border:0; background:#00c08b; color:#fff; font-weight:600; cursor:pointer;}
        .below-link{display:block; margin-top:14px; font-size:12px; color:#9ca3af; text-align:center;}
        .below-link a{color:#a5b4fc; text-decoration:none;}
        .below-link a:hover{color:#c7d2fe;}
      </style>
    </head>
    <body>
      <form class="card" method="POST" action="/signup">
        <div class="title">Inquire about pricing and plans</div>
        <div class="subtitle">Enter your email and we’ll follow up with details.</div>
        <label>Email</label>
        <input name="email" type="email" required />
        <button type="submit">Submit</button>
        <div class="below-link">Already have an account? <a href="/login">Sign in</a></div>
      </form>
    </body>
  </html>`;
  res.send(html);
});

app.post("/signup", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.status(400).send("Email is required.");

  const subject = "OpenCircle pricing inquiry";
  const text = `New pricing inquiry: ${email}`;
  const html = `<p>New pricing inquiry: <strong>${email}</strong></p>`;
  try {
    await sendEmail({ to: process.env.SMTP_FROM || "no-reply@opencircleapi.com", subject, text, html });
  } catch (e) {
    console.error("[MAIL] inquiry failed", e);
  }

  return res.send("Thanks! We’ll follow up by email shortly.");
});

app.get("/invite", async (req, res) => {
  const token = String(req.query.invite || "").trim();
  if (!token) return res.status(400).send("Missing invite token.");

  const invite = await get(
    "SELECT id, email, role, city, permissionsJson, expiresAt, usedAt FROM invites WHERE tokenHash = ? LIMIT 1",
    [hashToken(token)]
  );
  if (!invite) return res.status(404).send("Invite not found.");
  if (invite.usedAt) return res.status(410).send("Invite already used.");
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    return res.status(410).send("Invite expired.");
  }

  const presetEmail = invite.email ? String(invite.email) : "";

  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href="/assets/brand/favicon.ico" />
      <title>Accept invite</title>
      <style>
        body{font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0b1220; color:#e5e7eb; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;}
        .card{background:#111827; padding:28px; border-radius:12px; width:360px; box-shadow:0 10px 30px rgba(0,0,0,.3);}
        .title{font-size:22px; font-weight:700; margin:0 0 6px; color:#e5e7eb; text-align:center;}
        .subtitle{font-size:13px; color:#9ca3af; margin:0 0 22px; text-align:center;}
        label{font-size:12px; color:#9ca3af;}
        input{width:100%; box-sizing:border-box; margin:6px 0 20px; padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:#0f172a; color:#e5e7eb;}
        button{width:100%; height:40px; border-radius:8px; border:0; background:#00c08b; color:#fff; font-weight:600; cursor:pointer;}
      </style>
    </head>
    <body>
      <form class="card" method="POST" action="/invite">
        <div class="title">Accept invite</div>
        <div class="subtitle">Create your account to continue.</div>
        <input type="hidden" name="invite" value="${esc(token)}" />
        <label>Email</label>
        <input name="email" type="email" value="${esc(presetEmail)}" ${presetEmail ? "readonly" : "required"} />
        <label>Username</label>
        <input name="username" type="text" required />
        <label>Password</label>
        <input name="password" type="password" required />
        <button type="submit">Create account</button>
      </form>
    </body>
  </html>`;
  res.send(html);
});

app.post("/invite", async (req, res) => {
  const token = String(req.body?.invite || "").trim();
  if (!token) return res.status(400).send("Missing invite token.");

  const invite = await get(
    "SELECT id, email, role, city, permissionsJson, expiresAt, usedAt FROM invites WHERE tokenHash = ? LIMIT 1",
    [hashToken(token)]
  );
  if (!invite) return res.status(404).send("Invite not found.");
  if (invite.usedAt) return res.status(410).send("Invite already used.");
  if (invite.expiresAt && new Date(invite.expiresAt) < new Date()) {
    return res.status(410).send("Invite expired.");
  }

  const email = String(req.body?.email || "").trim().toLowerCase();
  const username = String(req.body?.username || "").trim();
  const password = String(req.body?.password || "");
  if (!email || !username || !password) return res.status(400).send("All fields are required.");
  if (invite.email && invite.email.toLowerCase() !== email) {
    return res.status(400).send("Invite email does not match.");
  }

  const existing = await get(
    "SELECT id FROM users WHERE email = ? OR username = ? LIMIT 1",
    [email, username]
  );
  if (existing) return res.status(400).send("Email or username already in use.");

  const passwordHash = hashPassword(password);
  await run(
    "INSERT INTO users (email, username, passwordHash, role, city, permissionsJson, createdAt) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))",
    [
      email,
      username,
      passwordHash,
      invite.role || "organizer",
      invite.city || "Enumclaw",
      invite.permissionsJson ||
        JSON.stringify({ events: true, venues: false, jobs: false, ads: false }),
    ]
  );
  await run("UPDATE invites SET usedAt = datetime('now') WHERE id = ?", [invite.id]);

  return res.redirect("/login");
});

app.get("/forgot", (_req, res) => {
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href="/assets/brand/favicon.ico" />
      <title>Forgot password</title>
      <style>
        body{font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0b1220; color:#e5e7eb; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;}
        .card{background:#111827; padding:28px; border-radius:12px; width:360px; box-shadow:0 10px 30px rgba(0,0,0,.3);}
        .title{font-size:22px; font-weight:700; margin:0 0 6px; color:#e5e7eb; text-align:center;}
        .subtitle{font-size:13px; color:#9ca3af; margin:0 0 22px; text-align:center;}
        label{font-size:12px; color:#9ca3af;}
        input{width:100%; box-sizing:border-box; margin:6px 0 20px; padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:#0f172a; color:#e5e7eb;}
        button{width:100%; height:40px; border-radius:8px; border:0; background:#00c08b; color:#fff; font-weight:600; cursor:pointer;}
        .below-link{display:block; margin-top:14px; font-size:12px; color:#9ca3af; text-align:center;}
        .below-link a{color:#a5b4fc; text-decoration:none;}
        .below-link a:hover{color:#c7d2fe;}
      </style>
    </head>
    <body>
      <form class="card" method="POST" action="/forgot">
        <div class="title">Reset password</div>
        <div class="subtitle">We’ll email you a reset link.</div>
        <label>Email</label>
        <input name="email" type="email" required />
        <button type="submit">Send reset link</button>
        <div class="below-link"><a href="/login">Back to sign in</a></div>
      </form>
    </body>
  </html>`;
  res.send(html);
});

app.post("/forgot", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  if (!email) return res.redirect("/forgot");

  const user = await get("SELECT id, email, username FROM users WHERE email = ? LIMIT 1", [email]);
  if (user) {
    const token = crypto.randomBytes(24).toString("hex");
    const tokenHash = hashToken(token);
    const exp = new Date(Date.now() + RESET_TTL_HOURS * 60 * 60 * 1000).toISOString();
    await run(
      "INSERT INTO password_resets (userId, tokenHash, expiresAt) VALUES (?, ?, ?)",
      [user.id, tokenHash, exp]
    );

    const baseUrl = `${req.protocol}://${req.get("host")}`;
    const link = `${baseUrl}/reset?token=${encodeURIComponent(token)}`;
    const subject = "Reset your OpenCircle password";
    const text = `Reset your password: ${link}`;
    const html = `<p>Reset your password:</p><p><a href="${link}">${link}</a></p>`;
    try { await sendEmail({ to: user.email, subject, text, html, from: PASSWORD_RESET_FROM, replyTo: PASSWORD_RESET_REPLY_TO }); } catch (e) { console.error("[MAIL] reset failed", e); }
  }

  return res.send("If the email exists, a reset link has been sent.");
});

app.get("/reset", async (req, res) => {
  const token = String(req.query.token || "");
  const tokenHash = token ? hashToken(token) : "";
  let valid = false;
  if (tokenHash) {
    const row = await get(
      "SELECT id, expiresAt, usedAt FROM password_resets WHERE tokenHash = ? LIMIT 1",
      [tokenHash]
    );
    if (row && !row.usedAt && (!row.expiresAt || new Date(row.expiresAt).getTime() > Date.now())) {
      valid = true;
    }
  }
  const html = `<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href="/assets/brand/favicon.ico" />
      <title>Reset password</title>
      <style>
        body{font-family:system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background:#0b1220; color:#e5e7eb; display:flex; align-items:center; justify-content:center; height:100vh; margin:0;}
        .card{background:#111827; padding:28px; border-radius:12px; width:360px; box-shadow:0 10px 30px rgba(0,0,0,.3);}
        .title{font-size:22px; font-weight:700; margin:0 0 6px; color:#e5e7eb; text-align:center;}
        .subtitle{font-size:13px; color:#9ca3af; margin:0 0 22px; text-align:center;}
        label{font-size:12px; color:#9ca3af;}
        input{width:100%; box-sizing:border-box; margin:6px 0 20px; padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:#0f172a; color:#e5e7eb;}
        button{width:100%; height:40px; border-radius:8px; border:0; background:#00c08b; color:#fff; font-weight:600; cursor:pointer;}
        .below-link{display:block; margin-top:14px; font-size:12px; color:#9ca3af; text-align:center;}
        .below-link a{color:#a5b4fc; text-decoration:none;}
        .below-link a:hover{color:#c7d2fe;}
      </style>
    </head>
    <body>
      <div class="card">
        <div class="title">Reset password</div>
        <div class="subtitle">Enter a new password.</div>
        ${valid ? `
          <form method="POST" action="/reset">
            <input type="hidden" name="token" value="${esc(token)}" />
            <label>New password</label>
            <input name="password" type="password" required />
            <button type="submit">Update password</button>
          </form>
        ` : `<div style="text-align:center;color:#fca5a5;">Invalid or expired reset link.</div>`}
        <div class="below-link"><a href="/login">Back to sign in</a></div>
      </div>
    </body>
  </html>`;
  res.send(html);
});

app.post("/reset", async (req, res) => {
  const token = String(req.body?.token || "");
  const password = String(req.body?.password || "");
  if (!token || !password || password.length < 8) return res.status(400).send("Invalid request");

  const tokenHash = hashToken(token);
  const row = await get(
    "SELECT id, userId, expiresAt, usedAt FROM password_resets WHERE tokenHash = ? LIMIT 1",
    [tokenHash]
  );
  if (!row || row.usedAt || (row.expiresAt && new Date(row.expiresAt).getTime() < Date.now())) {
    return res.status(400).send("Invalid or expired token");
  }

  const newHash = hashPassword(password);
  await run("UPDATE users SET passwordHash = ? WHERE id = ?", [newHash, row.userId]);
  await run("UPDATE password_resets SET usedAt = datetime('now') WHERE id = ?", [row.id]);
  return res.redirect("/login");
});

async function clearAuthAndRedirect(req, res) {
  const cookies = parseCookies(req.headers.cookie || "");
  await destroySession(cookies.oc_auth);
  const secure = String(process.env.NODE_ENV || "").toLowerCase() === "production";
  res.setHeader(
    "Set-Cookie",
    `oc_auth=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}`
  );
  return res.redirect("/login");
}

app.post("/logout", (req, res) => clearAuthAndRedirect(req, res));
app.get("/logout", (req, res) => clearAuthAndRedirect(req, res));

app.get("/health", (req, res) => res.status(200).send("ok"));
app.get("/robots.txt", (req, res) => {
  const base = String(
    process.env.PUBLIC_SITE_URL ||
    process.env.EVENTS_SITE_URL ||
    process.env.PUBLIC_BASE_URL ||
    `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.get("host")}`
  ).replace(/\/$/, "");

  const body = [
    "User-agent: *",
    "Allow: /",
    "Disallow: /admin",
    "Disallow: /login",
    "Disallow: /signup",
    "Disallow: /invite",
    "Disallow: /forgot",
    "Disallow: /reset",
    "",
    `Sitemap: ${base}/sitemap.xml`,
    "",
  ].join("\n");

  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  return res.status(200).send(body);
});
app.get("/sitemap.xml", (req, res) => {
  const base = String(
    process.env.PUBLIC_SITE_URL ||
    process.env.EVENTS_SITE_URL ||
    process.env.PUBLIC_BASE_URL ||
    `${req.headers["x-forwarded-proto"] || req.protocol}://${req.headers["x-forwarded-host"] || req.get("host")}`
  ).replace(/\/$/, "");

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${base}/events/sitemap.xml</loc></sitemap>
  <sitemap><loc>${base}/events/sitemap-past.xml</loc></sitemap>
  <sitemap><loc>${base}/venues/sitemap.xml</loc></sitemap>
  <sitemap><loc>${base}/jobs/sitemap.xml</loc></sitemap>
</sitemapindex>`;

  res.setHeader("Content-Type", "application/xml");
  return res.status(200).send(xml);
});
app.use(express.text({ type: "text/plain" })); // for sendBeacon payloads

// Routes
app.use(requireLogin);
app.use("/events", eventsRouter);
app.use("/venues", venuesRouter);
app.use("/ads", adsRouter);
app.use("/jobs", jobsRouter);
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

    setInterval(() => {
      pruneExpiredSessions().catch(() => {});
    }, 30 * 60 * 1000);

    const runNewsletterScheduler = () => {
      if (typeof adminRouter.processScheduledNewsletters !== "function") return;
      adminRouter.processScheduledNewsletters()
        .then((result) => {
          if (result && (result.sent || result.failed)) {
            console.log("[NEWSLETTER] Scheduler result:", result);
          }
        })
        .catch((err) => console.error("[NEWSLETTER] Scheduler failed:", err));
    };

    runNewsletterScheduler();
    setInterval(runNewsletterScheduler, 5 * 60 * 1000);

    app.listen(PORT, "0.0.0.0", () => {
      console.log(`OpenCircle API running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("[BOOT] DB init failed:", err);
    process.exit(1);
  });

// Export for routers if needed
module.exports = { UPLOADS_DIR: UPLOAD_DIR };
