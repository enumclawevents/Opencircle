"use strict";

// Process-local protection for anonymous write endpoints. This matches the
// application's current single-process operational model without changing
// public payloads. A future shared store can replace this implementation.
function clientIp(req) {
  return String(req.ip || req.headers?.["x-forwarded-for"] || req.socket?.remoteAddress || "unknown")
    .split(",")[0]
    .trim()
    .slice(0, 128) || "unknown";
}

function createRateLimiter({ windowMs, max }) {
  const buckets = new Map();
  return {
    consume(key) {
      const now = Date.now();
      const entries = (buckets.get(key) || []).filter((timestamp) => now - timestamp < windowMs);
      if (entries.length >= max) {
        buckets.set(key, entries);
        return false;
      }
      entries.push(now);
      buckets.set(key, entries);
      return true;
    },
    retryAfterSeconds: Math.ceil(windowMs / 1000),
  };
}

module.exports = { clientIp, createRateLimiter };
