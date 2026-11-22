"use strict";
const crypto = require("node:crypto");
const PREFIX = "ocm_";
let managedAuthority = null;
function configureManagedCredentialAuthority(authorize) { managedAuthority = authorize; }
const validId = value => typeof value === "string" && /^ocm_[A-Za-z0-9_-]{32}$/.test(value);
class RegistryError extends Error {
  constructor(code) { super("Website credential operation failed: " + code); this.code = code; }
}
const fail = code => { throw new RegistryError(code); };
const positiveId = value => Number.isSafeInteger(value) && value > 0;
function keyring(env, version) {
  try {
    const keys = JSON.parse(env.WEBSITE_CREDENTIAL_ENCRYPTION_KEYS || "{}");
    const key = keys && !Array.isArray(keys) && Object.hasOwn(keys, version) && keys[version];
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(version || "") || typeof key !== "string" || !/^[a-f0-9]{64}$/i.test(key)) fail("UNAVAILABLE");
    if (key.toLowerCase() === String(env.OCCURRENCE_ENGAGEMENT_IDENTITY_KEY || "").toLowerCase()) fail("UNAVAILABLE");
    return Buffer.from(key, "hex");
  } catch { fail("UNAVAILABLE"); }
}
function aad(row) {
  return Buffer.from(JSON.stringify(["website-credential-v1", row.id, row.installationId, row.city, row.encryptionKeyVersion]));
}
function encrypt(secret, row, env) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyring(env, row.encryptionKeyVersion), iv);
  cipher.setAAD(aad(row));
  const ciphertext = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return [iv, ciphertext, cipher.getAuthTag()].map(b => b.toString("hex")).join(":");
}
function decrypt(row, env) {
  try {
    if (!/^[a-f0-9]{24}:[a-f0-9]{86}:[a-f0-9]{32}$/.test(row.secretCiphertext)) fail("UNAVAILABLE");
    const [iv, ciphertext, tag] = row.secretCiphertext.split(":").map(s => Buffer.from(s, "hex"));
    const cipher = crypto.createDecipheriv("aes-256-gcm", keyring(env, row.encryptionKeyVersion), iv);
    cipher.setAAD(aad(row)); cipher.setAuthTag(tag);
    return Buffer.concat([cipher.update(ciphertext), cipher.final()]).toString("utf8");
  } catch { fail("UNAVAILABLE"); }
}
function canonicalSiteUrl(value) {
  try {
    if (typeof value !== "string" || value.length > 2048) fail("INVALID");
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) fail("INVALID");
    return url.origin + url.pathname.replace(/\/+$/, "") + "/";
  } catch { fail("INVALID"); }
}
async function ensureWebsiteCredentialSchema(run) {
  await run(`CREATE TABLE IF NOT EXISTS website_installations (
    id TEXT PRIMARY KEY, siteUrl TEXT NOT NULL, createdByUserId INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'registered' CHECK(status IN ('registered','active','revoked')),
    createdAt TEXT NOT NULL, revokedAt TEXT
  )`);
  await run(`CREATE TABLE IF NOT EXISTS website_authorized_cities (
    installationId TEXT NOT NULL, city TEXT NOT NULL,
    authorizedByUserId INTEGER NOT NULL, authorizedAt TEXT NOT NULL, revokedAt TEXT,
    PRIMARY KEY(installationId,city),
    FOREIGN KEY(installationId) REFERENCES website_installations(id)
  )`);
  await run(`CREATE TABLE IF NOT EXISTS website_signing_credentials (
    id TEXT PRIMARY KEY, installationId TEXT NOT NULL, city TEXT NOT NULL,
    secretCiphertext TEXT NOT NULL, encryptionKeyVersion TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','active','revoked')),
    createdByUserId INTEGER NOT NULL, createdAt TEXT NOT NULL, activatedAt TEXT,
    expiresAt INTEGER, revokedAt TEXT, replacesCredentialId TEXT,
    FOREIGN KEY(installationId,city) REFERENCES website_authorized_cities(installationId,city),
    FOREIGN KEY(replacesCredentialId) REFERENCES website_signing_credentials(id)
  )`);
  await run("CREATE INDEX IF NOT EXISTS idx_website_credentials_installation ON website_signing_credentials(installationId,city,status)");
  await run(`CREATE TABLE IF NOT EXISTS website_connection_audit (
    id INTEGER PRIMARY KEY, installationId TEXT NOT NULL, credentialId TEXT,
    city TEXT, actorUserId INTEGER NOT NULL, action TEXT NOT NULL, createdAt TEXT NOT NULL
  )`);
}
// No routes call these mutation operations in Phase A. authorize is mandatory
// for mutations and must recheck Phase B's account/community authorization
// inside this transaction. It is never inferred from submitted URLs or cities.
function createWebsiteCredentialRegistry({ transaction, authorize, env = process.env, now = Date.now }) {
  const audit = (tx, actorUserId, action, installationId, credentialId = null, city = null) => tx.run(
    "INSERT INTO website_connection_audit(installationId,credentialId,city,actorUserId,action,createdAt) VALUES (?,?,?,?,?,?)",
    [installationId, credentialId, city, actorUserId, action, new Date(now()).toISOString()]);
  async function permit(tx, actor, city = null, installationId = null) {
    if (!positiveId(actor) || typeof authorize !== "function" || !await authorize({ tx, actorUserId: actor, city, installationId })) fail("FORBIDDEN");
  }
  async function installation(tx, id) {
    if (typeof id !== "string" || id.length > 100) fail("INVALID");
    const row = await tx.get("SELECT * FROM website_installations WHERE id = ? AND status <> 'revoked'", [id]);
    if (!row) fail("NOT_FOUND");
    return row;
  }
  async function grant(tx, id, city) {
    await installation(tx, id);
    const row = await tx.get("SELECT 1 AS found FROM website_authorized_cities WHERE installationId = ? AND city = ? AND revokedAt IS NULL", [id, city]);
    if (!row) fail("FORBIDDEN");
  }
  const safe = fn => async input => {
    try { return await transaction(tx => fn(tx, input || {})); }
    catch (error) { if (error instanceof RegistryError) throw error; fail("STORAGE"); }
  };
  const credential = async (tx, id) => {
    if (!validId(id)) fail("INVALID");
    const row = await tx.get("SELECT * FROM website_signing_credentials WHERE id = ?", [id]);
    if (!row) fail("NOT_FOUND");
    return row;
  };
  return {
    registerInstallation: safe(async (tx, { actorUserId, siteUrl }) => {
      await permit(tx, actorUserId);
      const id = crypto.randomUUID();
      const canonical = canonicalSiteUrl(siteUrl);
      await tx.run("INSERT INTO website_installations(id,siteUrl,createdByUserId,createdAt) VALUES (?,?,?,?)", [id, canonical, actorUserId, new Date(now()).toISOString()]);
      await audit(tx, actorUserId, "installation.registered", id);
      return { id, siteUrl: canonical };
    }),
    grantCity: safe(async (tx, { actorUserId, installationId, city }) => {
      if (typeof city !== "string" || !city.trim() || city !== city.trim() || city.length > 100 || /[\x00-\x1f\x7f]/.test(city) || /^(plateau regional|plateau area)$/i.test(city)) fail("INVALID");
      await permit(tx, actorUserId, city, installationId); await installation(tx, installationId);
      await tx.run(`INSERT INTO website_authorized_cities VALUES (?,?,?,?,NULL)
        ON CONFLICT(installationId,city) DO UPDATE SET authorizedByUserId=excluded.authorizedByUserId,authorizedAt=excluded.authorizedAt,revokedAt=NULL`, [installationId, city, actorUserId, new Date(now()).toISOString()]);
      await audit(tx, actorUserId, "city.granted", installationId, null, city);
    }),
    issueCredential: safe(async (tx, { actorUserId, installationId, city, expiresAt = null, replacesCredentialId = null }) => {
      await permit(tx, actorUserId, city, installationId); await grant(tx, installationId, city);
      if (expiresAt !== null && (!Number.isSafeInteger(expiresAt) || expiresAt <= now())) fail("INVALID");
      if (replacesCredentialId) {
        const old = await credential(tx, replacesCredentialId);
        if (old.installationId !== installationId || old.city !== city || old.status !== "active") fail("INVALID");
      }
      const row = { id: PREFIX + crypto.randomBytes(24).toString("base64url"), installationId, city,
        encryptionKeyVersion: env.WEBSITE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY };
      const secret = crypto.randomBytes(32).toString("base64url");
      const ciphertext = encrypt(secret, row, env);
      await tx.run(`INSERT INTO website_signing_credentials(id,installationId,city,secretCiphertext,encryptionKeyVersion,status,createdByUserId,createdAt,expiresAt,replacesCredentialId)
        VALUES (?,?,?,?,?,'pending',?,?,?,?)`, [row.id, installationId, city, ciphertext, row.encryptionKeyVersion, actorUserId, new Date(now()).toISOString(), expiresAt, replacesCredentialId]);
      await audit(tx, actorUserId, "credential.issued", installationId, row.id, city);
      return { id: row.id, secret, city }; // Only this trusted issuance call receives plaintext.
    }),
    activateCredential: safe(async (tx, { actorUserId, credentialId }) => {
      const row = await credential(tx, credentialId);
      await permit(tx, actorUserId, row.city, row.installationId); await grant(tx, row.installationId, row.city);
      if (!["pending", "active"].includes(row.status) || (row.expiresAt !== null && row.expiresAt <= now())) fail("CONFLICT");
      decrypt(row, env); // Never activate an unreadable credential.
      if (row.status === "active") return;
      await tx.run("UPDATE website_signing_credentials SET status='active',activatedAt=? WHERE id=? AND status='pending'", [new Date(now()).toISOString(), row.id]);
      await tx.run("UPDATE website_installations SET status='active' WHERE id=? AND status='registered'", [row.installationId]);
      await audit(tx, actorUserId, "credential.activated", row.installationId, row.id, row.city);
    }),
    revokeCredential: safe(async (tx, { actorUserId, credentialId }) => {
      const row = await credential(tx, credentialId); await permit(tx, actorUserId, row.city, row.installationId);
      if (row.status === "revoked") return;
      await tx.run("UPDATE website_signing_credentials SET status='revoked',revokedAt=? WHERE id=?", [new Date(now()).toISOString(), row.id]);
      await audit(tx, actorUserId, "credential.revoked", row.installationId, row.id, row.city);
    }),
    revokeCity: safe(async (tx, { actorUserId, installationId, city }) => {
      await permit(tx, actorUserId, city, installationId); await installation(tx, installationId);
      await tx.run("UPDATE website_authorized_cities SET revokedAt=? WHERE installationId=? AND city=? AND revokedAt IS NULL", [new Date(now()).toISOString(), installationId, city]);
      await tx.run("UPDATE website_signing_credentials SET status='revoked',revokedAt=? WHERE installationId=? AND city=? AND status<>'revoked'", [new Date(now()).toISOString(), installationId, city]);
      await audit(tx, actorUserId, "city.revoked", installationId, null, city);
    }),
    revokeInstallation: safe(async (tx, { actorUserId, installationId }) => {
      await installation(tx, installationId);
      const grants = await tx.all("SELECT city FROM website_authorized_cities WHERE installationId=?", [installationId]);
      await permit(tx, actorUserId, null, installationId);
      for (const { city } of grants) await permit(tx, actorUserId, city, installationId);
      await tx.run("UPDATE website_installations SET status='revoked',revokedAt=? WHERE id=?", [new Date(now()).toISOString(), installationId]);
      await tx.run("UPDATE website_authorized_cities SET revokedAt=? WHERE installationId=?", [new Date(now()).toISOString(), installationId]);
      await tx.run("UPDATE website_signing_credentials SET status='revoked',revokedAt=? WHERE installationId=? AND status<>'revoked'", [new Date(now()).toISOString(), installationId]);
      await audit(tx, actorUserId, "installation.revoked", installationId);
    }),
    recordAuditEvent: safe(async (tx, { actorUserId, installationId, credentialId = null, action }) => {
      if (!["connection.checked", "connection.check_failed", "provisioning.acknowledged"].includes(action)) fail("INVALID");
      await permit(tx, actorUserId, null, installationId); await installation(tx, installationId);
      let city = null;
      if (credentialId !== null) {
        const row = await credential(tx, credentialId);
        if (row.installationId !== installationId) fail("INVALID");
        city = row.city; await permit(tx, actorUserId, city, installationId);
      } else {
        const cities = await tx.all("SELECT city FROM website_authorized_cities WHERE installationId=?", [installationId]);
        for (const row of cities) await permit(tx, actorUserId, row.city, installationId);
      }
      await audit(tx, actorUserId, action, installationId, credentialId, city);
    }),
    getStatus: safe(async (tx, { actorUserId, installationId }) => {
      await permit(tx, actorUserId, null, installationId);
      const connection = await tx.get("SELECT id,siteUrl,status,createdAt,revokedAt FROM website_installations WHERE id=?", [installationId]);
      if (!connection) fail("NOT_FOUND");
      const cities = await tx.all("SELECT city,revokedAt FROM website_authorized_cities WHERE installationId=? ORDER BY city", [installationId]);
      for (const { city } of cities) await permit(tx, actorUserId, city, installationId);
      const credentials = await tx.all("SELECT id,city,status,expiresAt,activatedAt,revokedAt,replacesCredentialId FROM website_signing_credentials WHERE installationId=? ORDER BY createdAt,id", [installationId]);
      return { ...connection, cities, credentials };
    }),
  };
}
// Called INSIDE the engagement write transaction, so revocation and mutations
// serialize. A managed namespace ID never falls back to environment credentials.
async function resolveSigningCredential(tx, id, env = process.env, now = Date.now(), authorize = managedAuthority) {
  if (typeof id !== "string" || id.length > 100) return null;
  if (id.startsWith(PREFIX)) {
    if (!validId(id)) return null;
    try {
      const row = await tx.get(`SELECT c.*, g.authorizedByUserId, i.createdByUserId AS installationOwner FROM website_signing_credentials c
        JOIN website_installations i ON i.id=c.installationId
        JOIN website_authorized_cities g ON g.installationId=c.installationId AND g.city=c.city
        WHERE c.id=? AND c.status='active' AND i.status='active' AND g.revokedAt IS NULL
          AND (c.expiresAt IS NULL OR c.expiresAt>?)`, [id, now]);
      if (!row || typeof authorize !== "function") return null;
      for (const actorUserId of new Set([row.createdByUserId,row.authorizedByUserId,row.installationOwner])) {
        if (!await authorize({tx,actorUserId,city:row.city,installationId:row.installationId})) return null;
      }
      return { city: row.city, secret: decrypt(row, env) };
    } catch { return null; }
  }
  try {
    const config = JSON.parse(env.OCCURRENCE_ENGAGEMENT_CREDENTIALS || "{}");
    const credential = config && !Array.isArray(config) && Object.hasOwn(config, id) ? config[id] : null;
    return credential && typeof credential.city === "string" && credential.city.trim() && typeof credential.secret === "string" && credential.secret.length >= 32
      ? { city: credential.city, secret: credential.secret } : null;
  } catch { return null; }
}
async function resolvePendingCredential(tx,id,env=process.env,now=Date.now()) {
  if (!validId(id)) return null;
  try {
    const row=await tx.get(`SELECT c.* FROM website_signing_credentials c
      JOIN website_installations i ON i.id=c.installationId
      JOIN website_authorized_cities g ON g.installationId=c.installationId AND g.city=c.city
      WHERE c.id=? AND c.status IN ('pending','active') AND i.status<>'revoked' AND g.revokedAt IS NULL
        AND (c.expiresAt IS NULL OR c.expiresAt>?)`,[id,now]);
    return row?{city:row.city,secret:decrypt(row,env)}:null;
  } catch { return null; }
}
function validateEncryptionConfiguration(env=process.env) { keyring(env,env.WEBSITE_CREDENTIAL_ENCRYPTION_ACTIVE_KEY); }
module.exports = { validateEncryptionConfiguration, configureManagedCredentialAuthority, resolvePendingCredential, ensureWebsiteCredentialSchema, createWebsiteCredentialRegistry, resolveSigningCredential, RegistryError, canonicalSiteUrl };
