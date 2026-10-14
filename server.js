"use strict";

const path = require("path");
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const { sendEmail, PASSWORD_RESET_FROM, PASSWORD_RESET_REPLY_TO } = require("./mailer");
const { hashPassword, hashToken, verifyPassword } = require("./lib/auth");
const { esc } = require("./lib/html");
const { UPLOAD_DIR } = require("./lib/uploads");

const { initDB, archiveExpiredEvents, get, all, run } = require("./db");

const eventsRouter = require("./routes/events");
const updatesRouter = require("./routes/updates");
const { ensureUpdatesSchema, publishDueUpdates } = require("./lib/updates");
const adminRouter = require("./routes/admin");
const venuesRouter = require("./routes/venues");
const adsRouter = require("./routes/ads");
const jobsRouter = require("./routes/jobs");

const app = express();
app.locals.reqTimes = [];
const NEWSLETTER_PUBLIC_CITIES = Object.freeze([
  "Enumclaw",
  "Buckley",
  "Wilkeson",
  "Carbonado",
  "South Prairie",
  "Plateau Regional",
]);
let publicNewsletterSchemaEnsured = false;

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
const PUBLIC_PATHS = new Set(["/login", "/signup", "/invite", "/forgot", "/terms-of-service", "/privacy-policy", "/health"]);
const PUBLIC_PREFIXES = [
  "/events/submit",
  "/events/feature",
  "/events",
  "/updates",
  "/venues",
  "/newsletter/click",
  "/newsletter/open",
  "/newsletter/subscribe",
  "/ads",
  "/jobs",
  "/uploads",
  "/assets",
];

async function ensurePublicNewsletterSchema() {
  if (publicNewsletterSchemaEnsured) return;
  await run(`
    CREATE TABLE IF NOT EXISTS newsletter_audience (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL,
      email TEXT NOT NULL,
      createdByUserId INTEGER,
      createdAt TEXT DEFAULT (datetime('now'))
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS newsletter_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      city TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'scheduled',
      subject TEXT,
      previewText TEXT,
      totalRecipients INTEGER NOT NULL DEFAULT 0,
      sentCount INTEGER NOT NULL DEFAULT 0,
      failedCount INTEGER NOT NULL DEFAULT 0,
      openCount INTEGER NOT NULL DEFAULT 0,
      uniqueOpenCount INTEGER NOT NULL DEFAULT 0,
      clickCount INTEGER NOT NULL DEFAULT 0,
      uniqueClickCount INTEGER NOT NULL DEFAULT 0,
      createdByUserId INTEGER,
      sentAt TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);
  await run(`
    CREATE TABLE IF NOT EXISTS newsletter_recipients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaignId INTEGER NOT NULL,
      city TEXT NOT NULL,
      email TEXT NOT NULL,
      deliveryStatus TEXT NOT NULL DEFAULT 'pending',
      openToken TEXT UNIQUE,
      openCount INTEGER NOT NULL DEFAULT 0,
      clickCount INTEGER NOT NULL DEFAULT 0,
      firstOpenedAt TEXT,
      lastOpenedAt TEXT,
      firstClickedAt TEXT,
      lastClickedAt TEXT,
      sentAt TEXT,
      errorText TEXT,
      createdAt TEXT DEFAULT (datetime('now')),
      updatedAt TEXT DEFAULT (datetime('now'))
    )
  `);
  try {
    const campaignCols = new Set((await all("PRAGMA table_info(newsletter_campaigns)")).map((row) => String(row.name || "")));
    if (!campaignCols.has("clickCount")) await run("ALTER TABLE newsletter_campaigns ADD COLUMN clickCount INTEGER NOT NULL DEFAULT 0");
    if (!campaignCols.has("uniqueClickCount")) await run("ALTER TABLE newsletter_campaigns ADD COLUMN uniqueClickCount INTEGER NOT NULL DEFAULT 0");
  } catch (_) {}
  try {
    const recipientCols = new Set((await all("PRAGMA table_info(newsletter_recipients)")).map((row) => String(row.name || "")));
    if (!recipientCols.has("clickCount")) await run("ALTER TABLE newsletter_recipients ADD COLUMN clickCount INTEGER NOT NULL DEFAULT 0");
    if (!recipientCols.has("firstClickedAt")) await run("ALTER TABLE newsletter_recipients ADD COLUMN firstClickedAt TEXT");
    if (!recipientCols.has("lastClickedAt")) await run("ALTER TABLE newsletter_recipients ADD COLUMN lastClickedAt TEXT");
  } catch (_) {}
  try {
    await run("CREATE INDEX IF NOT EXISTS idx_newsletter_audience_city ON newsletter_audience(city, createdAt DESC)");
  } catch (_) {}
  try {
    await run("CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_audience_city_email ON newsletter_audience(city, email)");
  } catch (_) {}
  try {
    await run("CREATE INDEX IF NOT EXISTS idx_newsletter_recipients_campaignId ON newsletter_recipients(campaignId, id DESC)");
  } catch (_) {}
  try {
    await run("CREATE INDEX IF NOT EXISTS idx_newsletter_recipients_city_sentAt ON newsletter_recipients(city, sentAt DESC, id DESC)");
  } catch (_) {}
  try {
    await run("CREATE UNIQUE INDEX IF NOT EXISTS idx_newsletter_recipients_openToken ON newsletter_recipients(openToken)");
  } catch (_) {}
  publicNewsletterSchemaEnsured = true;
}

function normalizeNewsletterSignupCity(input) {
  const raw = String(input || "").trim();
  if (!raw) return "Enumclaw";
  // Older WordPress shortcode releases used this display label. Accept it so
  // existing published forms continue to reach the shared audience.
  if (raw.toLowerCase() === "plateau area") return "Plateau Regional";
  const match = NEWSLETTER_PUBLIC_CITIES.find((city) => city.toLowerCase() === raw.toLowerCase());
  return match || null;
}

function normalizeNewsletterSignupEmail(input) {
  return String(input || "").trim().toLowerCase();
}

function isValidNewsletterSignupEmail(input) {
  const email = normalizeNewsletterSignupEmail(input);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}


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

const TERMS_OF_SERVICE_CONTENT = `
  <p><strong>Effective Date:</strong> October 13, 2026<br><strong>Last Updated:</strong> October 13, 2026<br><strong>Operated by:</strong> Omedia LLC<br><strong>Contact:</strong> <a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a></p>
  <h2>1. Acceptance of Terms</h2>
  <p>Welcome to OpenCircle, a community-focused digital platform owned and operated by Omedia LLC ("Omedia," "OpenCircle," "we," "us," or "our").</p>
  <p>OpenCircle provides software and services designed to help communities discover, publish, organize, and promote local information, including events, venues, businesses, employment opportunities, community updates, newsletters, and related activities.</p>
  <p>These Terms of Use ("Terms") govern your access to and use of OpenCircle's websites, administrative dashboard, application programming interfaces (APIs), hosted community websites, and associated services (collectively, the "Services").</p>
  <p>By accessing or using the Services, you agree to these Terms and our <a href="/privacy-policy">Privacy Policy</a>.</p>
  <p>If you use OpenCircle on behalf of an organization, you represent that you have authority to act on its behalf and bind that organization to the applicable agreement.</p>
  <p>If you do not agree to these Terms, you should not use the Services.</p>
  <h2>2. About OpenCircle</h2>
  <p>OpenCircle provides technology that enables communities and local organizations to manage their own digital presence.</p>
  <p>Our platform is designed around a community-first approach, allowing participating organizations to publish information, connect with residents, support local businesses, and promote community activities.</p>
  <p>OpenCircle provides the underlying technology, while participating organizations generally control the information and activities associated with their communities.</p>
  <p>Unless expressly stated otherwise, OpenCircle does not organize, sponsor, operate, or endorse events, businesses, organizations, or services listed through the platform.</p>
  <h2>3. Eligibility and User Accounts</h2>
  <p>Certain features require users to create an account.</p>
  <p>When registering for an account, you agree to:</p>
  <ul><li>Provide accurate and current information.</li><li>Maintain the confidentiality of your login credentials.</li><li>Use only accounts you are authorized to access.</li><li>Notify OpenCircle of suspected unauthorized account activity.</li><li>Follow the permissions assigned to your account.</li></ul>
  <p>Users must be at least 13 years old to create an account. Users under 18 must have permission from a parent or legal guardian.</p>
  <p>OpenCircle may require additional eligibility or authorization for administrative or commercial accounts.</p>
  <p>We reserve the right to suspend or restrict accounts that violate these Terms, create security risks, or interfere with the Services.</p>
  <h2>4. Community Administration and Permissions</h2>
  <p>OpenCircle supports multiple communities through a shared software platform.</p>
  <p>Authorized community administrators may be able to:</p>
  <ul><li>Create, edit, approve, and manage events.</li><li>Manage venue and business information.</li><li>Publish community updates and announcements.</li><li>Manage job listings.</li><li>Create and distribute newsletters.</li><li>Manage advertising and promotional placements.</li><li>Review analytics and engagement reports.</li><li>Manage authorized users and organizational permissions.</li></ul>
  <p>Access to these features is determined by assigned roles and community permissions.</p>
  <p>Community administrators are responsible for using their permissions appropriately and ensuring that content published through their organization complies with applicable laws and these Terms.</p>
  <p>OpenCircle may provide content moderation tools but does not guarantee that every submission will be independently reviewed by Omedia LLC.</p>
  <h2>5. User-Submitted Content</h2>
  <p>Users may submit events, descriptions, articles, photographs, graphics, venue information, job listings, announcements, and other materials ("User Content").</p>
  <p>By submitting User Content, you represent that:</p>
  <ol><li>You have the necessary rights or authorization to submit the content.</li><li>The information is accurate to the best of your knowledge.</li><li>The content does not violate applicable laws.</li><li>The content does not infringe another party's intellectual property or privacy rights.</li><li>You have obtained any required permissions for images, graphics, or other included materials.</li></ol>
  <p>You retain ownership of your original User Content.</p>
  <p>By submitting User Content, you grant Omedia LLC and the relevant participating community a nonexclusive, worldwide, royalty-free license to host, store, reproduce, display, distribute, format, and technically adapt the content as reasonably necessary to operate the Services, display community listings, and promote the content through authorized community channels.</p>
  <p>This license does not transfer ownership of your content.</p>
  <p>The license generally ends when the content is removed from the Services, except where continued retention is reasonably necessary for backups, legal compliance, or previously authorized distribution.</p>
  <h2>6. Content Moderation</h2>
  <p>OpenCircle and authorized community administrators may review, edit, reject, remove, or restrict User Content.</p>
  <p>Reasons for moderation may include:</p>
  <ul><li>Inaccurate or misleading information.</li><li>Duplicate submissions.</li><li>Spam or irrelevant promotional material.</li><li>Fraudulent activity.</li><li>Harassment, threats, or abusive content.</li><li>Copyright or trademark concerns.</li><li>Unlawful content.</li><li>Violations of community publishing guidelines.</li><li>Content unrelated to the relevant community.</li></ul>
  <p>Submission does not guarantee publication.</p>
  <p>OpenCircle may provide tools for users to report incorrect information or request corrections.</p>
  <p>We reserve the right to remove content when reasonably necessary to protect the platform, its users, or participating communities.</p>
  <h2>7. Events and Community Listings</h2>
  <p>OpenCircle allows communities and organizers to publish information about local events and activities.</p>
  <p>Event information may include dates, times, locations, admission details, ticket links, organizer information, and other relevant details.</p>
  <p>Although we aim to support accurate community information, OpenCircle cannot guarantee that every listing is complete, accurate, or current.</p>
  <p>Event details may change without notice.</p>
  <p>Users should confirm important information directly with the event organizer before attending.</p>
  <p>Unless expressly stated otherwise, OpenCircle is not responsible for:</p>
  <ul><li>Event cancellations or postponements.</li><li>Ticket availability or pricing.</li><li>Event safety or accessibility.</li><li>Organizer conduct.</li><li>Venue conditions.</li><li>Third-party purchases or transactions.</li><li>The quality or outcome of listed activities.</li></ul>
  <p>Participation in events is at the user's own discretion and subject to applicable legal rights.</p>
  <h2>8. Venues, Businesses, and Job Listings</h2>
  <p>OpenCircle may display information about local businesses, venues, organizations, employment opportunities, and other services.</p>
  <p>Such information may be supplied by independent third parties.</p>
  <p>OpenCircle does not independently guarantee business qualifications, licensing, employment availability, compensation, venue conditions, or the accuracy of third-party representations.</p>
  <p>Users should verify important information before entering agreements, submitting applications, making purchases, or attending activities.</p>
  <p>Employers and applicants are responsible for their own communications and compliance with applicable employment laws.</p>
  <h2>9. Community Updates and Published Articles</h2>
  <p>Authorized users may publish community announcements, news, articles, guides, and other written content through OpenCircle.</p>
  <p>The submitting user or participating organization is responsible for the accuracy, legality, and rights associated with published material.</p>
  <p>Views or opinions expressed in community articles belong to their respective authors and do not necessarily represent the views of Omedia LLC.</p>
  <p>OpenCircle may remove or restrict content that violates these Terms.</p>
  <h2>10. Advertising and Promotional Content</h2>
  <p>Participating communities may offer advertising, featured events, sponsored listings, and other promotional opportunities.</p>
  <p>Unless otherwise agreed in writing, these activities are managed by the participating organization.</p>
  <p>Advertising and sponsored content must comply with applicable laws and must not be materially misleading.</p>
  <p>Paid promotional placement does not constitute endorsement by OpenCircle.</p>
  <p>Omedia LLC does not automatically receive a percentage of advertising revenue, event ticket sales, sponsorships, featured placements, or other community-generated income.</p>
  <p>Any separate financial arrangement must be expressly agreed upon.</p>
  <h2>11. Community Subscriptions and Billing</h2>
  <p>Certain OpenCircle features and services are available to participating organizations through paid monthly subscriptions.</p>
  <p>Subscription pricing is disclosed before purchase and may also appear in an applicable order, invoice, or subscription agreement.</p>
  <p>Unless otherwise agreed in writing:</p>
  <ul><li>Subscriptions are billed monthly in advance.</li><li>Subscriptions automatically renew each month until canceled.</li><li>The subscribing organization authorizes recurring charges through the selected payment method.</li><li>Access continues for the applicable paid subscription period, subject to these Terms.</li><li>Subscription fees provide access to OpenCircle software and do not transfer ownership of the platform.</li></ul>
  <p>Any applicable taxes or additional charges will be disclosed as required by law.</p>
  <h3>11.1 Cancellation</h3>
  <p>Subscribers may cancel their subscription at any time by emailing <a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a> or through an available account cancellation feature.</p>
  <p>Cancellation will stop future renewals once processed.</p><p>Unless otherwise required by law or separately agreed, access continues until the end of the current paid billing period.</p><p>OpenCircle will provide confirmation of cancellation.</p>
  <h3>11.2 Refunds</h3>
  <p>Monthly subscription fees are generally nonrefundable after the applicable billing period begins.</p><p>Prorated refunds are not ordinarily provided for unused portions of a subscription period.</p>
  <p>Refunds may be issued for:</p><ul><li>Duplicate charges.</li><li>Billing errors attributable to Omedia LLC.</li><li>Circumstances where refunds are required by applicable law.</li><li>Other situations approved by Omedia LLC at its discretion.</li></ul>
  <p>Refund requests may be submitted to <a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a>.</p><p>Approved refunds will generally be issued through the original payment method.</p>
  <h3>11.3 Failed Payments</h3>
  <p>If a subscription payment fails, OpenCircle may notify the subscriber and request updated billing information.</p><p>Continued nonpayment may result in temporary suspension or termination of paid services after reasonable notice.</p>
  <h3>11.4 Pricing Changes</h3>
  <p>Any changes to an existing subscription price will be communicated in advance, as required by applicable law or agreement.</p><p>Subscribers may cancel before a price change takes effect.</p>
  <h2>12. Community Revenue and Ownership</h2>
  <p>OpenCircle operates primarily as a software subscription service.</p><p>Unless separately agreed in writing, Omedia LLC does not claim a percentage of revenue generated by participating communities through:</p>
  <ul><li>Advertising.</li><li>Featured event placements.</li><li>Venue listings.</li><li>Sponsorships.</li><li>Ticket sales.</li><li>Other locally managed commercial activities.</li></ul>
  <p>Participating organizations retain their applicable rights to revenue they generate, subject to agreements with advertisers, payment processors, organizers, and other third parties.</p><p>OpenCircle does not guarantee any particular amount of revenue, audience engagement, or business growth.</p>
  <h2>13. Intellectual Property</h2>
  <p>The OpenCircle name, software, source code, platform architecture, interface designs, documentation, branding, and original platform materials are owned by Omedia LLC or its licensors.</p><p>Users may access and use the Services only as permitted by these Terms and applicable subscription agreements.</p>
  <p>Without authorization, users may not:</p><ul><li>Copy or redistribute proprietary OpenCircle software.</li><li>Attempt unauthorized access to platform systems.</li><li>Remove proprietary notices.</li><li>Misrepresent ownership of OpenCircle technology.</li><li>Use OpenCircle branding in a misleading manner.</li><li>Reverse engineer protected components except where permitted by law.</li></ul>
  <p>Participating communities retain ownership of their original names, logos, trademarks, photographs, and other community-owned materials.</p><p>Use of OpenCircle does not transfer ownership of community branding to Omedia LLC.</p>
  <h2>14. Acceptable Use</h2>
  <p>Users agree not to use OpenCircle to:</p><ul><li>Commit fraud or impersonate another person or organization.</li><li>Submit knowingly false or misleading information.</li><li>Publish unlawful, threatening, or harassing material.</li><li>Infringe intellectual property rights.</li><li>Upload malware or harmful code.</li><li>Attempt unauthorized access to accounts or data.</li><li>Circumvent security controls or API restrictions.</li><li>Scrape or collect private information without authorization.</li><li>Send unlawful or unsolicited commercial communications.</li><li>Manipulate page views, advertising clicks, votes, or engagement metrics.</li><li>Interfere with the reliability or availability of the platform.</li></ul><p>OpenCircle may investigate suspected misuse and take appropriate action.</p>
  <h2>15. API Access and Integrations</h2>
  <p>OpenCircle may provide APIs that allow authorized applications and websites to access community information.</p><p>API users must comply with applicable authentication requirements, access restrictions, usage limits, and documentation.</p><p>Users may not use the API to access unpublished or private information without authorization.</p><p>OpenCircle may modify, limit, or revoke API access when necessary for security, reliability, legal compliance, or prevention of abuse.</p><p>Additional terms may apply to specific developer integrations.</p>
  <h2>16. Analytics and Reporting</h2>
  <p>OpenCircle provides analytics to help participating communities understand how visitors interact with content.</p><p>Analytics may include:</p><ul><li>Event views.</li><li>Venue views.</li><li>Ticket link interactions.</li><li>Advertising impressions and clicks.</li><li>Newsletter engagement.</li><li>Job listing interactions.</li><li>Community update views.</li><li>Other measurable activity.</li></ul><p>Analytics are provided for informational purposes.</p><p>Unless explicitly identified otherwise, analytics do not necessarily represent unique individuals, confirmed attendance, completed purchases, or actual revenue.</p><p>Metrics may be affected by technical limitations, automated traffic filtering, browser settings, and third-party systems.</p><p>OpenCircle does not guarantee that analytics will be completely accurate or uninterrupted.</p><p>Users may not intentionally manipulate engagement measurements.</p>
  <h2>17. Community Recognition and Awards</h2>
  <p>Participating communities may use OpenCircle to recognize local events, organizers, businesses, volunteers, and community contributions.</p><p>Recognition programs may use engagement data, community voting, administrator selections, or other published criteria.</p><p>Award eligibility, selection methods, and results may vary by community.</p><p>Unless expressly stated, awards do not constitute a certification, professional endorsement, or guarantee of quality by Omedia LLC.</p><p>Paid advertising or promotional placement does not automatically provide preferential treatment in awards or recognition programs.</p><p>Any awards program should publish its eligibility and selection criteria and identify the organization administering it.</p>
  <h2>18. Newsletters and Communications</h2>
  <p>OpenCircle may provide tools for participating communities to manage newsletters and other communications.</p><p>Users who subscribe to optional marketing communications may unsubscribe using the methods provided.</p><p>Participating organizations are responsible for obtaining any legally required consent and complying with applicable email marketing laws.</p><p>OpenCircle may send essential administrative, billing, security, and account-related communications when necessary to operate the Services.</p>
  <h2>19. Privacy and Personal Information</h2>
  <p>Use of OpenCircle is subject to our <a href="/privacy-policy">Privacy Policy</a>.</p><p>Omedia LLC may collect and process information necessary to operate the Services, manage accounts, provide analytics, deliver communications, and maintain security.</p><p>Participating organizations may independently determine how certain community-specific information is collected, used, or published.</p><p>Those organizations are responsible for complying with applicable privacy obligations relating to information they control.</p><p>Users should not submit sensitive personal information through public content fields unless the relevant feature expressly supports it.</p>
  <h2>20. Third-Party Services and External Links</h2>
  <p>OpenCircle may integrate with or link to third-party services, including ticketing providers, payment processors, email services, mapping platforms, and social networks.</p><p>These services may operate under separate terms and privacy policies.</p><p>OpenCircle does not control third-party services and is not responsible for their independent content, availability, or practices except where required by law.</p><p>Users are responsible for reviewing applicable third-party terms before using those services.</p>
  <h2>21. Service Availability and Maintenance</h2>
  <p>OpenCircle makes reasonable efforts to maintain reliable and secure Services.</p><p>However, uninterrupted access cannot be guaranteed.</p><p>Temporary interruptions may occur due to:</p><ul><li>Scheduled maintenance.</li><li>Software updates.</li><li>Infrastructure issues.</li><li>Security incidents.</li><li>Third-party outages.</li><li>Events outside reasonable control.</li></ul><p>OpenCircle may modify or improve features over time.</p><p>Material changes affecting paid services will be communicated as required by law or applicable agreements.</p>
  <h2>22. Support and Custom Services</h2>
  <p>OpenCircle subscriptions include reasonable support for ordinary platform functionality and technical issues.</p><p>Custom development, extensive content entry, specialized integrations, website redesigns, and other services outside standard platform functionality may require a separate agreement.</p><p>Requests for support may be sent to <a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a>.</p>
  <h2>23. Data Ownership, Export, and Retention</h2>
  <p>Participating organizations retain ownership of their original community content.</p><p>Upon subscription cancellation, an authorized organization may request an export of its reasonably available community-owned content and associated records within 30 days after the end of its paid subscription.</p><p>OpenCircle will make reasonable efforts to provide the export in a commonly usable format, subject to technical feasibility, privacy obligations, and third-party rights.</p><p>After the applicable retention period, OpenCircle may delete or anonymize information in accordance with its Privacy Policy, legal requirements, and backup retention practices.</p><p>Omedia LLC is not required to provide proprietary software, source code, internal infrastructure, or confidential platform information as part of a data export.</p>
  <h2>24. Account Suspension and Termination</h2>
  <p>OpenCircle may suspend or terminate access for:</p><ul><li>Material violations of these Terms.</li><li>Fraudulent or unlawful activity.</li><li>Serious security threats.</li><li>Unauthorized system access.</li><li>Continued nonpayment.</li><li>Other lawful reasons.</li></ul><p>Where reasonable, OpenCircle will provide notice and an opportunity to resolve the issue.</p><p>Users may stop using the Services at any time.</p><p>Paid subscription cancellation is governed by Section 11.</p><p>Termination does not eliminate obligations or rights that arose before termination.</p>
  <h2>25. Disclaimer of Warranties</h2>
  <p>To the maximum extent permitted by applicable law, OpenCircle is provided on an "as is" and "as available" basis.</p><p>Omedia LLC makes no guarantee that the Services will be uninterrupted, error-free, completely secure, or suitable for every particular purpose.</p><p>OpenCircle does not independently guarantee the accuracy, legality, safety, availability, or quality of third-party events, businesses, venues, employment opportunities, or other submitted information.</p><p>Nothing in these Terms excludes warranties or rights that cannot lawfully be excluded.</p>
  <h2>26. Limitation of Liability</h2>
  <p>To the maximum extent permitted by applicable law, Omedia LLC will not be liable for indirect, incidental, special, consequential, or punitive damages arising from use of the Services, including lost profits, lost business opportunities, or loss of data.</p><p>For paid subscribers, Omedia LLC's aggregate liability arising from the Services will not exceed the total subscription fees paid to Omedia LLC during the twelve months immediately preceding the event giving rise to the claim.</p><p>For users who do not pay Omedia LLC directly, aggregate liability will not exceed $100.</p><p>These limitations do not apply where prohibited by law, including liability that cannot lawfully be limited.</p>
  <h2>27. Indemnification</h2>
  <p>To the extent permitted by applicable law, organizations using OpenCircle for commercial or administrative purposes agree to defend and indemnify Omedia LLC against third-party claims, damages, and reasonable expenses arising from:</p><ul><li>Content they publish without the necessary rights.</li><li>Their unlawful use of the Services.</li><li>Their material violation of these Terms.</li><li>Their independent event, advertising, or business operations.</li></ul><p>This obligation does not apply to claims caused by Omedia LLC's own unlawful conduct or to the extent otherwise prohibited by law.</p>
  <h2>28. Copyright and Intellectual Property Complaints</h2>
  <p>OpenCircle respects intellectual property rights.</p><p>If you believe content published through the Services infringes your copyright or other intellectual property rights, contact:</p><p><strong><a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a></strong></p><p>Please provide sufficient information to identify the content, explain the claimed infringement, and allow us to investigate.</p><p>OpenCircle may remove or restrict access to disputed material when appropriate.</p><p>Formal notices under the Digital Millennium Copyright Act (DMCA) may be subject to additional statutory requirements and designated-agent procedures.</p>
  <h2>29. Governing Law and Disputes</h2>
  <p>These Terms are governed by the laws of the State of Washington, United States, without regard to conflict-of-law principles, except where applicable law requires otherwise.</p><p>Disputes will be handled in courts with appropriate jurisdiction unless the parties agree to another lawful resolution method.</p><p>Nothing in these Terms prevents users from exercising rights or remedies that cannot legally be waived.</p>
  <h2>30. Changes to These Terms</h2>
  <p>OpenCircle may update these Terms to reflect changes in the Services, legal requirements, or business operations.</p><p>The latest version will be published with an updated effective date.</p><p>Where required, material changes will be communicated through the Services or another appropriate method.</p><p>Continued use after updated Terms take effect may constitute acceptance to the extent permitted by law. Where affirmative consent is legally required, it will be requested separately.</p>
  <h2>31. Severability</h2><p>If any provision of these Terms is found unenforceable, the remaining provisions will continue in effect to the extent permitted by law.</p>
  <h2>32. Entire Agreement</h2><p>These Terms, together with the Privacy Policy, applicable Community Subscription Terms, and any separately executed written agreement, govern the relevant use of OpenCircle.</p><p>Where a separately signed agreement expressly conflicts with these Terms, the signed agreement will control for the subject matter addressed.</p>
  <h2>33. Contact Information</h2><p>For questions regarding these Terms, subscriptions, billing, privacy, content, or platform support, contact:</p><p><strong>Omedia LLC<br>OpenCircle<br>Email: <a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a></strong></p>
  <hr><p><strong>OpenCircle — For the community, by the community.</strong></p>`;

const PRIVACY_POLICY_CONTENT = `
  <p><strong>Effective Date:</strong> October 13, 2026<br><strong>Last Updated:</strong> October 13, 2026<br><strong>Operated by:</strong> Omedia LLC<br><strong>Contact:</strong> <a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a></p>
  <h2>1. Introduction</h2>
  <p>OpenCircle is a community-focused digital platform owned and operated by Omedia LLC ("Omedia," "OpenCircle," "we," "us," or "our").</p><p>We believe community technology should be useful, accessible, and respectful of the people who use it.</p><p>This Privacy Policy explains how we collect, use, store, share, and protect personal information when individuals interact with OpenCircle and its associated services.</p><p>These services may include:</p>
  <ul><li>OpenCircle websites and hosted community websites.</li><li>The OpenCircle administrative dashboard.</li><li>Community event listings and submissions.</li><li>Venue and business directories.</li><li>Local employment listings.</li><li>Community updates and announcements.</li><li>Newsletters and email communications.</li><li>Advertising and promotional features.</li><li>Analytics and reporting tools.</li><li>OpenCircle APIs and integrations.</li><li>Subscription and account management.</li></ul><p>By using OpenCircle, you acknowledge the information practices described in this Privacy Policy.</p>
  <h2>2. Information We Collect</h2><p>The information we collect depends on how you interact with OpenCircle.</p>
  <h3>2.1 Account Information</h3><p>When you create an account or receive an invitation to use OpenCircle, we may collect:</p><ul><li>Your name.</li><li>Email address.</li><li>Account credentials.</li><li>Organization or community affiliation.</li><li>Assigned roles and permissions.</li><li>Account preferences.</li><li>Account creation and activity timestamps.</li></ul><p>Passwords and other authentication credentials are handled through the platform's security mechanisms.</p>
  <h3>2.2 Community Submissions</h3><p>When you submit an event, venue, business listing, job opportunity, article, or other content, we may collect:</p><ul><li>Names and contact information.</li><li>Event or business details.</li><li>Locations and addresses.</li><li>Dates and times.</li><li>Descriptions and other submitted text.</li><li>Images and uploaded files.</li><li>Website and social media links.</li><li>Organizer or business affiliations.</li><li>Information voluntarily included in submissions.</li></ul><p>Some submitted information is intended for public display.</p><p>Users should avoid including sensitive personal information in public submissions.</p>
  <h3>2.3 Newsletter Information</h3><p>When you subscribe to a community newsletter or other optional communications, we may collect:</p><ul><li>Email address.</li><li>Subscription preferences.</li><li>Subscription and unsubscribe timestamps.</li><li>Email delivery status.</li><li>Email opens and link interactions, where supported.</li></ul><p>This information is used to deliver communications and help participating communities understand newsletter performance.</p>
  <h3>2.4 Analytics and Usage Information</h3><p>OpenCircle may collect information about how visitors interact with community websites and platform content.</p><p>This may include:</p><ul><li>Page views.</li><li>Event listing views.</li><li>Venue listing views.</li><li>Job listing views.</li><li>Community update views.</li><li>Advertising impressions and clicks.</li><li>Ticket link interactions.</li><li>Referral sources.</li><li>General browser and device information.</li><li>Request timestamps.</li><li>Technical information used to identify automated or abusive traffic.</li></ul><p>Analytics help participating communities understand which information is useful to their audiences.</p><p>OpenCircle does not represent page views as confirmed attendance, purchases, or unique individuals unless those measurements are specifically supported.</p>
  <h3>2.5 Technical and Security Information</h3><p>When you access OpenCircle, we may automatically receive:</p><ul><li>IP addresses.</li><li>Browser type.</li><li>Device information.</li><li>Operating system information.</li><li>Request logs.</li><li>Session information.</li><li>Cookies or similar identifiers.</li><li>Error and diagnostic information.</li></ul><p>This information may be used to maintain platform functionality, investigate technical problems, prevent abuse, and protect account security.</p>
  <h3>2.6 Subscription and Billing Information</h3><p>When an organization purchases an OpenCircle subscription, we may collect:</p><ul><li>Organization name.</li><li>Billing contact information.</li><li>Subscription plan and price.</li><li>Billing dates.</li><li>Payment status.</li><li>Transaction records.</li><li>Invoice information.</li></ul><p>Payments may be processed by third-party payment providers.</p><p>OpenCircle does not require users to submit payment card information through public event or community submission forms.</p><p>Payment providers may independently collect and process payment information according to their own privacy policies.</p>
  <h3>2.7 Support and Communications</h3><p>When you contact OpenCircle, we may collect your name, email address, message content, and information necessary to respond to your request.</p><p>We may retain support communications to resolve issues, maintain service records, and improve the platform.</p>
  <h2>3. How We Use Information</h2><p>We use personal information for purposes including:</p><ul><li>Providing and maintaining OpenCircle services.</li><li>Creating and managing user accounts.</li><li>Authenticating users and enforcing permissions.</li><li>Processing and publishing community submissions.</li><li>Delivering newsletters and requested communications.</li><li>Managing subscriptions and billing.</li><li>Providing analytics and performance reporting.</li><li>Preventing spam, fraud, and unauthorized activity.</li><li>Diagnosing technical issues.</li><li>Responding to support requests.</li><li>Improving platform functionality and accessibility.</li><li>Complying with applicable legal obligations.</li></ul><p>We aim to collect and use information reasonably necessary for these purposes.</p>
  <h2>4. Community-Controlled Information</h2><p>OpenCircle serves multiple independent communities and organizations through shared technology.</p><p>Participating organizations may manage their own:</p><ul><li>Community content.</li><li>Event submissions.</li><li>Organizer information.</li><li>Venue listings.</li><li>Newsletter subscribers.</li><li>Advertising information.</li><li>Community communications.</li><li>Authorized administrative users.</li></ul><p>Depending on the circumstances, Omedia LLC may process this information on behalf of a participating organization.</p><p>The participating organization may determine how certain information is collected, published, and used within its community.</p><p>Community administrators are responsible for using their access appropriately and complying with applicable privacy and communications laws.</p><p>Omedia LLC provides the underlying technology and may assist with privacy-related requests when appropriate.</p>
  <h2>5. Public Information</h2><p>Certain information submitted to OpenCircle is intended to be publicly accessible.</p><p>Examples include:</p><ul><li>Published event listings.</li><li>Venue and business information.</li><li>Public organizer names.</li><li>Community articles and announcements.</li><li>Published job opportunities.</li><li>Publicly displayed images.</li><li>Website and ticketing links.</li></ul><p>Published information may appear on community websites, search engines, newsletters, and authorized integrations using the OpenCircle API.</p><p>Users should only submit information for public publication when they have the necessary authorization.</p><p>Removing content from OpenCircle may not immediately remove copies already indexed by search engines or distributed through third-party services.</p>
  <h2>6. How We Share Information</h2><p>OpenCircle may share information in the following circumstances.</p><h3>6.1 Participating Communities</h3><p>Authorized administrators may access information associated with the communities they manage.</p><p>Access is controlled through platform permissions and community associations.</p><h3>6.2 Service Providers</h3><p>We may use third-party providers for services such as:</p><ul><li>Website and application hosting.</li><li>Data storage.</li><li>Email delivery.</li><li>Payment processing.</li><li>Security and technical infrastructure.</li><li>Error monitoring and diagnostics.</li></ul><p>These providers may process information as necessary to perform services on our behalf.</p><h3>6.3 User-Authorized Integrations</h3><p>Information may be shared with third-party services when an authorized user or administrator enables an integration or requests an action involving that service.</p><h3>6.4 Legal Requirements</h3><p>We may disclose information when reasonably necessary to:</p><ul><li>Comply with applicable law.</li><li>Respond to valid legal requests.</li><li>Protect the security of the Services.</li><li>Investigate suspected fraud or abuse.</li><li>Protect the rights and safety of users, communities, or others.</li></ul><h3>6.5 Business Transfers</h3><p>If Omedia LLC undergoes a merger, acquisition, restructuring, or sale involving OpenCircle, relevant information may be transferred as part of that transaction, subject to applicable law and appropriate protections.</p>
  <h2>7. Sale of Personal Information</h2><p>Omedia LLC does not sell personal information to data brokers.</p><p>We do not use personal information collected through OpenCircle for third-party targeted advertising unless that practice is separately disclosed and applicable legal requirements are satisfied.</p><p>Advertising features within OpenCircle may measure impressions and interactions to provide reporting to participating communities and advertisers.</p><p>We do not provide advertisers with unrestricted access to private user accounts or community subscriber databases.</p>
  <h2>8. Cookies and Similar Technologies</h2><p>OpenCircle may use cookies and similar technologies to:</p><ul><li>Maintain authenticated sessions.</li><li>Remember account preferences.</li><li>Support platform security.</li><li>Prevent fraudulent activity.</li><li>Measure usage and engagement.</li><li>Improve website functionality.</li></ul><p>Some cookies are necessary for the Services to operate.</p><p>Where required by applicable law, we will provide appropriate notices, choices, or consent mechanisms for nonessential technologies.</p><p>Users may be able to manage cookies through their browser settings.</p><p>Disabling certain cookies may affect account access or platform functionality.</p>
  <h2>9. Analytics and Community Reporting</h2><p>OpenCircle provides analytics intended to help participating communities understand engagement with local information.</p><p>Analytics may include:</p><ul><li>Content views.</li><li>Referral information.</li><li>Event engagement.</li><li>Advertising performance.</li><li>Newsletter activity.</li><li>Job listing interactions.</li><li>Other measurable platform activity.</li></ul><p>Where practical, OpenCircle may filter automated traffic, prefetch requests, and repeated activity to improve reporting quality.</p><p>Analytics may be aggregated or summarized for reporting purposes.</p><p>OpenCircle does not guarantee that analytics identify individual visitors or measure actual event attendance.</p><p>Participating organizations are responsible for using analytics appropriately and in accordance with applicable laws.</p>
  <h2>10. Email and Newsletter Privacy</h2><p>Users may subscribe to community newsletters or other optional communications.</p><p>Newsletter subscriber information may be accessible to authorized administrators of the relevant community.</p><p>OpenCircle may use third-party email delivery services to distribute newsletters and related communications.</p><p>Subscribers can opt out of optional marketing emails using the unsubscribe methods provided.</p><p>Unsubscribing from a newsletter does not necessarily prevent essential account, security, billing, or service-related messages.</p><p>Participating organizations are responsible for obtaining legally required consent before sending marketing communications.</p>
  <h2>11. Data Security</h2><p>We take reasonable administrative, technical, and organizational measures intended to protect information against unauthorized access, alteration, disclosure, or destruction.</p><p>Security measures may include:</p><ul><li>Account authentication.</li><li>Role-based permissions.</li><li>Community-specific access controls.</li><li>Protected administrative interfaces.</li><li>Secure handling of uploaded files.</li><li>Monitoring and prevention of suspicious activity.</li><li>Appropriate infrastructure and storage protections.</li></ul><p>No internet-based service can guarantee complete security.</p><p>Users are responsible for maintaining the confidentiality of their credentials and notifying OpenCircle of suspected unauthorized account activity.</p><p>Security concerns may be reported to <a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a>.</p>
  <h2>12. Data Retention</h2><p>OpenCircle retains information for as long as reasonably necessary to:</p><ul><li>Provide the Services.</li><li>Maintain user accounts.</li><li>Support participating communities.</li><li>Preserve legitimate business records.</li><li>Meet legal and regulatory requirements.</li><li>Resolve disputes.</li><li>Protect platform security.</li></ul><p>Retention periods may vary depending on the type of information and the purpose for which it was collected.</p><p>When information is no longer reasonably necessary, we may delete, anonymize, or otherwise securely dispose of it, subject to applicable law and technical limitations.</p><p>Certain information may remain temporarily in backups or records maintained for legitimate legal and security purposes.</p>
  <h2>13. Your Privacy Rights and Choices</h2><p>Depending on applicable law and your relationship with OpenCircle, you may have the right to:</p><ul><li>Request access to personal information.</li><li>Request correction of inaccurate information.</li><li>Request deletion of eligible personal information.</li><li>Withdraw consent where processing is based on consent.</li><li>Opt out of optional marketing communications.</li><li>Request information about how your data is used.</li><li>Exercise additional privacy rights provided by applicable law.</li></ul><p>Requests may be submitted to <a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a>.</p><p>We may need to verify your identity before fulfilling certain requests.</p><p>Some requests may be subject to legal exceptions or retention requirements.</p><p>Where information is controlled by a participating community, we may refer the request to the appropriate organization or assist it in responding.</p><p>We will respond within timeframes required by applicable law.</p><p>We will not unlawfully discriminate against individuals for exercising applicable privacy rights.</p>
  <h2>14. Children's Privacy</h2><p>OpenCircle is intended for general community information and is not designed for children under 13 to independently register accounts or submit personal information.</p><p>We do not knowingly collect personal information directly from children under 13 without legally appropriate authorization.</p><p>If we learn that personal information has been collected from a child in violation of applicable law, we will take appropriate steps to address it.</p><p>Parents or guardians may contact <a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a> regarding concerns about children's information.</p><p>Community event listings may include family-friendly or children's activities, but that does not mean OpenCircle is specifically directed toward children.</p>
  <h2>15. Third-Party Websites and Services</h2><p>OpenCircle may contain links to external websites and services, including:</p><ul><li>Event ticketing platforms.</li><li>Business websites.</li><li>Social media pages.</li><li>Payment processors.</li><li>Mapping services.</li><li>External registration forms.</li></ul><p>These services may collect information independently.</p><p>Their privacy practices are governed by their own policies.</p><p>OpenCircle is not responsible for the independent privacy practices of third-party services.</p><p>We encourage users to review relevant privacy policies before submitting information to external websites.</p>
  <h2>16. International Data Processing</h2><p>OpenCircle is operated by Omedia LLC in the United States.</p><p>Information may be processed or stored in the United States or other locations where authorized service providers operate.</p><p>If OpenCircle becomes subject to additional international data protection requirements, we will implement appropriate measures as required by applicable law.</p>
  <h2>17. Account Deletion and Community Data</h2><p>Users may request account closure or deletion of eligible personal information by contacting <a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a>.</p><p>Participating organizations may request exports of their community-owned content in accordance with their subscription agreement.</p><p>Deletion requests may be subject to legitimate retention requirements, including billing records, security records, legal obligations, and backup procedures.</p><p>Closing an account does not automatically remove all public content previously submitted through the platform.</p><p>Requests concerning published community content may require review by the relevant community administrator.</p>
  <h2>18. Data Breaches and Security Incidents</h2><p>If OpenCircle identifies a security incident involving personal information, Omedia LLC will investigate and take appropriate steps to contain and address the issue.</p><p>Where required by applicable law, we will notify affected individuals, participating organizations, or relevant authorities.</p><p>Notification timing and methods will depend on the nature of the incident and applicable legal requirements.</p>
  <h2>19. Changes to This Privacy Policy</h2><p>We may update this Privacy Policy as OpenCircle evolves or as legal requirements change.</p><p>The latest version will be published with an updated effective date.</p><p>When changes materially affect how personal information is handled, we will provide additional notice or obtain consent where required by law.</p>
  <h2>20. Contact Information</h2><p>For questions, privacy requests, account concerns, or information about this Privacy Policy, contact:</p><p><strong>Omedia LLC<br>OpenCircle<br>Email: <a href="mailto:admin@opencircleapi.com">admin@opencircleapi.com</a></strong></p>
  <hr><p><strong>OpenCircle — For the community, by the community.</strong></p>`;

function renderLegalDocument(res, title, content) {
  return res.send(`<!doctype html>
  <html>
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <link rel="icon" href="/assets/brand/favicon.ico" />
      <title>${title} | OpenCircle</title>
      <style>
        body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f8fafc;color:#0f172a;margin:0;line-height:1.55;}
        main{max-width:780px;margin:0 auto;padding:56px 24px 80px;}
        h1{margin:0 0 10px;font-size:34px;line-height:1.2;}
        .updated{margin:0 0 34px;color:#64748b;font-size:14px;}
        .notice{padding:20px 22px;border:1px solid #cbd5e1;border-radius:12px;background:#fff;color:#475569;}
        h2{margin:34px 0 12px;font-size:22px;line-height:1.3;}
        h3{margin:26px 0 10px;font-size:18px;line-height:1.35;}
        p{margin:0 0 16px;}
        ul,ol{margin:0 0 16px;padding-left:24px;}
        li{margin:5px 0;}
        hr{margin:32px 0;border:0;border-top:1px solid #cbd5e1;}
        a{color:#0876d1;}
      </style>
    </head>
    <body>
      <main>
        <h1>${title}</h1>
        ${content}
      </main>
    </body>
  </html>`);
}

app.get("/terms-of-service", (_req, res) => renderLegalDocument(res, "Terms of Service", TERMS_OF_SERVICE_CONTENT));
app.get("/privacy-policy", (_req, res) => renderLegalDocument(res, "Privacy Policy", PRIVACY_POLICY_CONTENT));

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
  const isOrganizerInvite = String(invite.role || "organizer").trim().toLowerCase() === "organizer";
  const accountNameLabel = isOrganizerInvite
    ? `Organizer name <span class="help" tabindex="0" aria-label="Organizer name help">?<span class="help-text" role="tooltip">This name will be used as the organizer for every event submitted from this account and cannot be changed. Example: Enumclaw Rotary Club.</span></span>`
    : "Username";

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
        .help{position:relative; display:inline-flex; align-items:center; justify-content:center; width:15px; height:15px; margin-left:4px; border:1px solid #9ca3af; border-radius:50%; color:#cbd5e1; font-size:10px; font-weight:700; line-height:1; cursor:help; vertical-align:middle;}
        .help-text{position:absolute; z-index:2; left:50%; bottom:calc(100% + 8px); width:240px; padding:9px 10px; border-radius:8px; background:#020617; color:#e5e7eb; box-shadow:0 8px 20px rgba(0,0,0,.35); font-size:12px; font-weight:400; line-height:1.4; opacity:0; pointer-events:none; transform:translate(-50%, 4px); transition:opacity .15s ease, transform .15s ease;}
        .help:hover .help-text,.help:focus .help-text{opacity:1; transform:translate(-50%, 0);}
        input{width:100%; box-sizing:border-box; margin:6px 0 20px; padding:10px 12px; border-radius:8px; border:1px solid rgba(255,255,255,.12); background:#0f172a; color:#e5e7eb;}
        .strength-label{font-size:12px; color:#9ca3af;}
        .strength-label strong{font-weight:500; color:#94a3b8;}
        .password-requirements{display:grid; gap:5px; margin:7px 0 18px; padding:0; list-style:none; color:#9ca3af; font-size:12px;}
        .password-requirement{display:flex; align-items:center; gap:8px;}
        .password-requirement::before{content:""; width:9px; height:9px; flex:0 0 auto; border-radius:50%; background:#64748b; transition:background .15s ease;}
        .password-requirement.met{color:#86efac;}
        .password-requirement.met::before{background:#22c55e;}
        .terms{display:flex; align-items:flex-start; gap:8px; margin:2px 0 20px; color:#cbd5e1; font-size:12px; line-height:1.4;}
        .terms input{width:15px; height:15px; flex:0 0 auto; margin:1px 0 0; padding:0;}
        .terms a{color:#60a5fa; font-weight:600; text-decoration:none;}
        .terms a:hover,.terms a:focus{text-decoration:underline;}
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
        <label>${accountNameLabel}</label>
        <input name="username" type="text" autocomplete="username" required />
        <label>Password</label>
        <input id="password" name="password" type="password" autocomplete="new-password" minlength="8" required />
        <label>Confirm password</label>
        <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="8" required />
        <div class="strength-label" aria-live="polite">Password strength: <strong id="passwordStrengthLabel">Not entered</strong></div>
        <ul class="password-requirements" aria-label="Password recommendations">
          <li class="password-requirement" data-password-rule="length">At least 8 characters</li>
          <li class="password-requirement" data-password-rule="letterCase">Uppercase and lowercase character</li>
          <li class="password-requirement" data-password-rule="special">One special character</li>
          <li class="password-requirement" data-password-rule="number">One number</li>
        </ul>
        <label class="terms"><input name="agreeToTerms" type="checkbox" value="yes" required /> <span>I agree to the <a href="/terms-of-service" target="_blank" rel="noopener noreferrer">Terms of Service</a> and <a href="/privacy-policy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>.</span></label>
        <button type="submit">+ Create account</button>
      </form>
      <script>
        (function () {
          var password = document.getElementById("password");
          var confirmation = document.getElementById("confirmPassword");
          var label = document.getElementById("passwordStrengthLabel");
          var requirements = {
            length: document.querySelector('[data-password-rule="length"]'),
            letterCase: document.querySelector('[data-password-rule="letterCase"]'),
            special: document.querySelector('[data-password-rule="special"]'),
            number: document.querySelector('[data-password-rule="number"]')
          };
          function updatePasswordStatus() {
            var value = password.value;
            var met = {
              length: value.length >= 8,
              letterCase: /[a-z]/.test(value) && /[A-Z]/.test(value),
              special: /[^A-Za-z0-9]/.test(value),
              number: /\\d/.test(value)
            };
            var score = Object.keys(met).filter(function (key) { return met[key]; }).length;
            Object.keys(met).forEach(function (key) {
              requirements[key].classList.toggle("met", met[key]);
            });
            var state = !value ? "Not entered" : (score <= 1 ? "Weak" : score === 2 ? "Fair" : score === 3 ? "Good" : value.length >= 12 ? "Strong" : "Good");
            var colors = { "Not entered": "#94a3b8", Weak: "#f87171", Fair: "#fb923c", Good: "#facc15", Strong: "#86efac" };
            label.textContent = state;
            label.style.color = colors[state];
            confirmation.setCustomValidity(confirmation.value && confirmation.value !== value ? "Passwords do not match." : "");
          }
          password.addEventListener("input", updatePasswordStatus);
          confirmation.addEventListener("input", updatePasswordStatus);
        })();
      </script>
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
  const confirmPassword = String(req.body?.confirmPassword || "");
  const agreedToTerms = String(req.body?.agreeToTerms || "").toLowerCase() === "yes";
  if (!email || !username || !password || !confirmPassword) return res.status(400).send("All fields are required.");
  if (password.length < 8) return res.status(400).send("Password must be at least 8 characters.");
  if (password !== confirmPassword) return res.status(400).send("Passwords do not match.");
  if (!agreedToTerms) return res.status(400).send("You must agree to the Terms of Use.");
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
  <sitemap><loc>${base}/updates/sitemap.xml</loc></sitemap>
</sitemapindex>`;

  res.setHeader("Content-Type", "application/xml");
  return res.status(200).send(xml);
});
app.use(express.text({ type: "text/plain" })); // for sendBeacon payloads
app.post("/newsletter/subscribe", async (req, res) => {
  try {
    await ensurePublicNewsletterSchema();
    const email = normalizeNewsletterSignupEmail(req.body?.email);
    const city = normalizeNewsletterSignupCity(req.body?.city);

    if (!city) {
      return res.status(400).json({
        ok: false,
        error: "Invalid city.",
        allowedCities: NEWSLETTER_PUBLIC_CITIES,
      });
    }

    if (!isValidNewsletterSignupEmail(email)) {
      return res.status(400).json({
        ok: false,
        error: "Invalid email address.",
      });
    }

    const insertResult = await run(
      `INSERT INTO newsletter_audience (city, email, createdByUserId, createdAt)
       VALUES (?, ?, NULL, datetime('now'))
       ON CONFLICT(city, email) DO NOTHING`,
      [city, email]
    );

    return res.status(200).json({
      ok: true,
      city,
      email,
      subscribed: true,
      duplicate: Number(insertResult?.changes || 0) === 0,
      message: "Subscribed successfully.",
    });
  } catch (err) {
    console.error("[NEWSLETTER] subscribe failed:", err && err.stack ? err.stack : err);
    return res.status(500).json({
      ok: false,
      error: "Unable to subscribe right now.",
    });
  }
});

// Routes
app.use(requireLogin);
app.get("/newsletter/open/:token.gif", async (req, res) => {
  const token = String(req.params.token || "").trim();
  try {
    await ensurePublicNewsletterSchema();
    if (token) {
      const row = await get(
        "SELECT id, campaignId, openCount FROM newsletter_recipients WHERE openToken = ? LIMIT 1",
        [token]
      );
      if (row?.id) {
        const wasOpened = Number(row.openCount || 0) > 0;
        await run(
          `UPDATE newsletter_recipients
              SET openCount = COALESCE(openCount, 0) + 1,
                  firstOpenedAt = COALESCE(firstOpenedAt, datetime('now')),
                  lastOpenedAt = datetime('now'),
                  updatedAt = datetime('now')
            WHERE id = ?`,
          [row.id]
        );
        await run(
          `UPDATE newsletter_campaigns
              SET openCount = COALESCE(openCount, 0) + 1,
                  uniqueOpenCount = COALESCE(uniqueOpenCount, 0) + ?,
                  updatedAt = datetime('now')
            WHERE id = ?`,
          [wasOpened ? 0 : 1, row.campaignId]
        );
      }
    }
  } catch (err) {
    console.error("[NEWSLETTER] Open tracking failed:", err);
  }
  const gif = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");
  res.set("Content-Type", "image/gif");
  res.set("Content-Length", String(gif.length));
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, private, max-age=0, s-maxage=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  res.set("Surrogate-Control", "no-store");
  res.set("Last-Modified", new Date().toUTCString());
  res.set("ETag", `"newsletter-open-${Date.now()}-${Math.random().toString(36).slice(2, 8)}"`);
  res.status(200);
  return res.end(gif);
});
app.get("/newsletter/click/:token", async (req, res) => {
  const token = String(req.params.token || "").trim();
  const fallbackUrl = "https://enumclawevents.org/events";
  const requestedUrl = String(req.query.url || "").trim();
  let targetUrl = fallbackUrl;
  try {
    const parsed = new URL(requestedUrl);
    if (/^https?:$/i.test(parsed.protocol)) targetUrl = parsed.toString();
  } catch (_) {}
  try {
    await ensurePublicNewsletterSchema();
    if (token) {
      const row = await get(
        "SELECT id, campaignId, clickCount FROM newsletter_recipients WHERE openToken = ? LIMIT 1",
        [token]
      );
      if (row?.id) {
        const wasClicked = Number(row.clickCount || 0) > 0;
        await run(
          `UPDATE newsletter_recipients
              SET clickCount = COALESCE(clickCount, 0) + 1,
                  firstClickedAt = COALESCE(firstClickedAt, datetime('now')),
                  lastClickedAt = datetime('now'),
                  updatedAt = datetime('now')
            WHERE id = ?`,
          [row.id]
        );
        await run(
          `UPDATE newsletter_campaigns
              SET clickCount = COALESCE(clickCount, 0) + 1,
                  uniqueClickCount = COALESCE(uniqueClickCount, 0) + ?,
                  updatedAt = datetime('now')
            WHERE id = ?`,
          [wasClicked ? 0 : 1, row.campaignId]
        );
      }
    }
  } catch (err) {
    console.error("[NEWSLETTER] Click tracking failed:", err);
  }
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, private, max-age=0, s-maxage=0");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  return res.redirect(302, targetUrl);
});
app.use("/events", eventsRouter);
app.use("/updates", updatesRouter);
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
    await ensureUpdatesSchema();
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

    const runEmailReportScheduler = () => {
      if (typeof adminRouter.processScheduledEmailReports !== "function") return;
      adminRouter.processScheduledEmailReports()
        .then((result) => {
          if (result && (result.sent || result.failed)) {
            console.log("[EMAIL REPORTS] Scheduler result:", result);
          }
        })
        .catch((err) => console.error("[EMAIL REPORTS] Scheduler failed:", err));
    };

    runEmailReportScheduler();
    setInterval(runEmailReportScheduler, 5 * 60 * 1000);

    const runUpdatePublisher = () => {
      publishDueUpdates()
        .then((result) => { if (result?.published) console.log("[UPDATES] Published scheduled updates:", result.published); })
        .catch((err) => console.error("[UPDATES] Scheduler failed:", err));
    };
    runUpdatePublisher();
    setInterval(runUpdatePublisher, 60 * 1000);

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
