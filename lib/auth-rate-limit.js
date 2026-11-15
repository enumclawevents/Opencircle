"use strict";

const { BlockList, isIP } = require("node:net");
const { hashToken } = require("./auth");
const { withRedemptionTransaction } = require("./auth-recovery");

const WINDOW_MS = 15 * 60_000;
const MAX_BUCKETS = 20_000;

function normalizeIdentifier(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeIp(value) {
  if (typeof value !== "string" || !isIP(value) || value.includes("%")) return null;
  if (isIP(value) === 4) return value;
  const canonical = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(canonical);
  if (!mapped) return canonical;
  const high = parseInt(mapped[1], 16);
  const low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

function createAuthIpResolver({ mode, trustedProxyCidrs }) {
  if (mode === "direct") return (req) => normalizeIp(req.socket.remoteAddress);
  if (mode !== "render") return () => null;

  const peers = new BlockList();
  const cidrs = String(trustedProxyCidrs || "").split(",").map((value) => value.trim()).filter(Boolean);
  if (!cidrs.length) return () => null;
  for (const cidr of cidrs) {
    const [address, prefix, extra] = cidr.split("/");
    const family = isIP(address);
    const max = family === 4 ? 32 : 128;
    if (!family || extra !== undefined || !/^\d+$/.test(prefix || "") || Number(prefix) < 1 || Number(prefix) > max) {
      throw new Error("Invalid AUTH_RATE_LIMIT_TRUSTED_PROXY_CIDRS");
    }
    peers.addSubnet(address, Number(prefix), family === 4 ? "ipv4" : "ipv6");
  }
  return (req) => {
    const peer = normalizeIp(req.socket.remoteAddress);
    if (!peer || !peers.check(peer, isIP(peer) === 4 ? "ipv4" : "ipv6")) return null;
    // Enable this mode only after verifying every trusted ingress overwrites
    // CF-Connecting-IP. Never fall back to an unverified forwarding header.
    return normalizeIp(req.headers["cf-connecting-ip"]);
  };
}

function bucket(kind, identity, max, windowMs = WINDOW_MS) {
  return { key: hashToken(JSON.stringify([kind, identity])), kind, max, windowMs };
}

const limits = {
  loginVolume: (ip) => ip && bucket("login-ip", ip, 30),
  loginFailures: (identity, ip) => [
    bucket(identity[0] === "identifier" ? "login-unknown" : "login-account", identity, 15),
    ...(ip ? [bucket(identity[0] === "identifier" ? "login-unknown-pair" : "login-pair", [identity, ip], 5)] : []),
  ],
  recoveryVolume: (ip) => ip && bucket("forgot-ip", ip, 10),
  recoveryAddress: (email) => bucket("forgot-address", email, 1, 5 * 60_000),
  resetVolume: (ip) => ip && bucket("reset-ip", ip, 20),
  resetToken: (token) => bucket("reset-token", token, 6),
};

async function ensureAuthRateLimitSchema(run) {
  await run(`CREATE TABLE IF NOT EXISTS auth_rate_limits (
    bucketKey TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    count INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  )`);
  await run("CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_expires ON auth_rate_limits(expiresAt)");
  await run("CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_kind_expires ON auth_rate_limits(kind, expiresAt)");
}

function createAuthRateLimiter(filename, now = Date.now, maxBuckets = MAX_BUCKETS) {
  let tail = Promise.resolve();
  const transact = (work) => {
    const result = tail.then(() => withRedemptionTransaction(filename, work));
    tail = result.catch(() => {});
    return result;
  };
  const retry = (expiry, time) => Math.max(1, Math.ceil((expiry - time) / 1000));

  return {
    take(volume, restrictions) {
      return transact(async ({ get, run }) => {
        const time = now();
        await run("DELETE FROM auth_rate_limits WHERE expiresAt <= ?", [time]);
        const load = (item) => get("SELECT count, expiresAt FROM auth_rate_limits WHERE bucketKey = ?", [item.key]);
        const charge = (item) => run(
          `INSERT INTO auth_rate_limits (bucketKey, kind, count, expiresAt) VALUES (?, ?, 1, ?)
           ON CONFLICT(bucketKey) DO UPDATE SET count = count + 1`,
          [item.key, item.kind, time + item.windowMs]
        );
        const overCapacity = async (kind) => {
          const { count } = await get("SELECT COUNT(*) AS count FROM auth_rate_limits WHERE kind = ?", [kind]);
          if (count < maxBuckets) return null;
          const oldest = await get("SELECT expiresAt FROM auth_rate_limits WHERE kind = ? ORDER BY expiresAt LIMIT 1", [kind]);
          return retry(oldest?.expiresAt || time + 60_000, time);
        };
        if (volume) {
          const current = await load(volume);
          const wait = current?.count >= volume.max ? retry(current.expiresAt, time) : !current ? await overCapacity(volume.kind) : null;
          if (wait) return { retryAfter: wait, volumeLimited: true };
          await charge(volume);
        }
        let wait = 0;
        const newKinds = [];
        for (const restriction of restrictions) {
          const current = await load(restriction);
          if (!current) newKinds.push(restriction.kind);
          else if (current.count >= restriction.max) wait = Math.max(wait, retry(current.expiresAt, time));
        }
        if (wait) return { retryAfter: wait, volumeLimited: false };
        for (const kind of newKinds) {
          const capacityWait = await overCapacity(kind);
          if (capacityWait) return { retryAfter: capacityWait, volumeLimited: true };
        }
        for (const restriction of restrictions) await charge(restriction);
        return null;
      });
    },
    clearFailures(restrictions) {
      return transact(async ({ run }) => {
        for (const restriction of restrictions) {
          await run("DELETE FROM auth_rate_limits WHERE bucketKey = ?", [restriction.key]);
        }
      });
    },
  };
}

function sendAuthRestriction(res, retryAfter) {
  res.set("Retry-After", String(retryAfter));
  res.set("Cache-Control", "no-store");
  return res.status(429).send("Too many attempts. Please wait a few minutes and try again.");
}

module.exports = {
  createAuthIpResolver, createAuthRateLimiter, ensureAuthRateLimitSchema, limits, normalizeIdentifier, sendAuthRestriction,
};
