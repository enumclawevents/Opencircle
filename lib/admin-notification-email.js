"use strict";

const { all, run } = require("../db");
const { sendEmail } = require("../mailer");
const { esc } = require("./html");

const ALL_AREAS = new Set(["Enumclaw", "Buckley", "Wilkeson", "Carbonado", "South Prairie"]);

function prefs(value) {
  try { return typeof value === "string" ? (JSON.parse(value) || {}) : (value || {}); } catch (_) { return {}; }
}
function role(value) { const v = String(value || "").toLowerCase(); return v === "admin" ? "admin" : (["developer", "area_manager"].includes(v) ? "developer" : "organizer"); }
function canAccessCity(user, city) {
  const r = role(user.role);
  if (r === "admin") return true;
  const permission = prefs(user.permissionsJson);
  const cities = Array.isArray(permission.cityAccess) ? permission.cityAccess : Array.isArray(permission.cities) ? permission.cities : null;
  if (r === "developer" && !cities) return true;
  return (cities || [user.city]).includes(city);
}
function wantsEmail(user, category) {
  const value = prefs(user.notificationPreferencesJson);
  return value[category] !== false;
}
async function logDelivery({ userId = null, category, city = null, email, subject, status, errorText = "" }) {
  try {
    await run("INSERT INTO notification_email_log (userId, category, city, email, subject, status, errorText, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))", [userId, category, city, email || null, subject || null, status, errorText || null]);
  } catch (error) { console.error("[notification email log]", error); }
}
async function notifyAreaApprovers({ category, city, subject, text, html }) {
  const users = await all("SELECT id, email, role, city, permissionsJson, notificationPreferencesJson FROM users WHERE email IS NOT NULL AND trim(email) <> ''");
  const recipients = users.filter((user) => ["admin", "developer"].includes(role(user.role)) && canAccessCity(user, city) && wantsEmail(user, category));
  await Promise.all(recipients.map(async (user) => {
    try {
      const result = await sendEmail({ to: user.email, subject, text, html });
      await logDelivery({ userId: user.id, category, city, email: user.email, subject, status: result ? "sent" : "skipped", errorText: result ? "" : "SMTP is not configured" });
    } catch (error) {
      console.error("[notification email]", error);
      await logDelivery({ userId: user.id, category, city, email: user.email, subject, status: "failed", errorText: error.message || "Send failed" });
    }
  }));
}
async function notifyMessageRecipient({ recipient, city, senderName, body, url }) {
  if (!recipient?.email || !wantsEmail(recipient, "messages")) return;
  const subject = `New OpenCircle message from ${senderName || "a team member"}`;
  const safeBody = String(body || "").slice(0, 4000);
  try {
    const result = await sendEmail({ to: recipient.email, subject, text: `You have a new message from ${senderName || "a team member"}.\n\n${safeBody}\n\nOpen messages: ${url}`, html: `<p>You have a new message from <strong>${esc(senderName || "a team member")}</strong>.</p><p style="white-space:pre-wrap;">${esc(safeBody)}</p><p><a href="${esc(url)}">Open messages</a></p>` });
    await logDelivery({ userId: recipient.id, category: "messages", city, email: recipient.email, subject, status: result ? "sent" : "skipped", errorText: result ? "" : "SMTP is not configured" });
  } catch (error) { await logDelivery({ userId: recipient.id, category: "messages", city, email: recipient.email, subject, status: "failed", errorText: error.message || "Send failed" }); }
}
module.exports = { notifyAreaApprovers, notifyMessageRecipient };
