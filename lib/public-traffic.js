"use strict";

function getHeader(req, name) {
  return String(req?.headers?.[name] || "").trim().toLowerCase();
}

function isLikelyBotUserAgent(userAgent) {
  const ua = String(userAgent || "").trim().toLowerCase();
  if (!ua) return false;
  return /bot|spider|crawler|slurp|bingpreview|google|lighthouse|pagespeed|headless|facebookexternalhit|whatsapp|discordbot|twitterbot|linkedinbot|slackbot|embedly/.test(ua);
}

function isPrefetchRequest(req) {
  const purpose = getHeader(req, "purpose");
  const secPurpose = getHeader(req, "sec-purpose");
  const xMoz = getHeader(req, "x-moz");
  return purpose === "prefetch" || secPurpose === "prefetch" || xMoz === "prefetch";
}

function shouldTrackPublicView(req) {
  const trackRaw = String(req?.query?.track ?? "1").trim().toLowerCase();
  if (trackRaw === "0" || trackRaw === "false" || trackRaw === "no") return false;
  if (trackRaw === "1" || trackRaw === "true" || trackRaw === "yes") {
    if (isPrefetchRequest(req)) return false;
    if (isLikelyBotUserAgent(req?.headers?.["user-agent"])) return false;
    return true;
  }
  if (isPrefetchRequest(req)) return false;
  if (isLikelyBotUserAgent(req?.headers?.["user-agent"])) return false;
  return true;
}

module.exports = {
  isLikelyBotUserAgent,
  isPrefetchRequest,
  shouldTrackPublicView,
};
