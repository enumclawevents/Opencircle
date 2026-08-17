"use strict";

const nodemailer = require("nodemailer");

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "no-reply@opencircleapi.com";
const PASSWORD_RESET_FROM_ADDRESS = process.env.PASSWORD_RESET_FROM || "support@opencircleapi.com";
const PASSWORD_RESET_FROM_NAME = process.env.PASSWORD_RESET_FROM_NAME || "OpenCircle Support";
const PASSWORD_RESET_REPLY_TO = process.env.PASSWORD_RESET_REPLY_TO || PASSWORD_RESET_FROM_ADDRESS;

function formatSender(name, email) {
  const trimmedEmail = String(email || "").trim();
  const trimmedName = String(name || "").trim();
  if (!trimmedEmail) return SMTP_FROM;
  if (!trimmedName) return trimmedEmail;
  return `${trimmedName} <${trimmedEmail}>`;
}

const PASSWORD_RESET_FROM = formatSender(PASSWORD_RESET_FROM_NAME, PASSWORD_RESET_FROM_ADDRESS);

const mailer = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    })
  : null;

async function sendEmail({ to, subject, html, text, from, replyTo }) {
  if (!mailer) {
    console.warn("[MAIL] SMTP not configured. Skipping email to:", to);
    return false;
  }
  return mailer.sendMail({
    from: from || SMTP_FROM,
    replyTo: replyTo || undefined,
    to,
    subject,
    html,
    text,
  });
}

module.exports = {
  PASSWORD_RESET_FROM,
  PASSWORD_RESET_REPLY_TO,
  sendEmail,
};
