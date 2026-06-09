"use strict";

const nodemailer = require("nodemailer");

const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "no-reply@opencircleapi.com";
const PASSWORD_RESET_FROM = process.env.PASSWORD_RESET_FROM || "support@opencircleapi.com";

const mailer = SMTP_HOST
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_PORT === 465,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    })
  : null;

async function sendEmail({ to, subject, html, text, from }) {
  if (!mailer) {
    console.warn("[MAIL] SMTP not configured. Skipping email to:", to);
    return false;
  }
  await mailer.sendMail({
    from: from || SMTP_FROM,
    to,
    subject,
    html,
    text,
  });
  return true;
}

module.exports = {
  PASSWORD_RESET_FROM,
  sendEmail,
};
