"use strict";

const crypto = require("node:crypto");
const { DateTime } = require("luxon");
const { get, run } = require("../db");

const SQUARE_SANDBOX = "https://connect.squareupsandbox.com";
const SQUARE_VERSION = "2026-09-16";
const BILLING_DAY = 8;
const AMOUNT_CENTS = 10000;
const TIMEZONE = "America/Los_Angeles";
const SCOPE = "Plateau Regional";

class BillingError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function billingAdminEmail(env = process.env) {
  return String(env.SQUARE_SANDBOX_BILLING_ADMIN_EMAIL || "").trim().toLowerCase();
}

function billingConfig(env = process.env) {
  const ownerEmail = billingAdminEmail(env);
  const appId = String(env.SQUARE_SANDBOX_APPLICATION_ID || "").trim();
  const locationId = String(env.SQUARE_SANDBOX_LOCATION_ID || "").trim();
  const token = String(env.SQUARE_SANDBOX_ACCESS_TOKEN || "").trim();
  if (env.SQUARE_SANDBOX_BILLING_ENABLED !== "1" || !ownerEmail || !appId.startsWith("sandbox-") || !locationId || !token) return null;
  return { ownerEmail, appId, locationId, token };
}

async function checkProductionBilling({ verify = false, env = process.env, fetcher = fetch } = {}) {
  const locationId = String(env.SQUARE_PRODUCTION_LOCATION_ID || "").trim();
  const token = String(env.SQUARE_PRODUCTION_ACCESS_TOKEN || "").trim();
  if (!/^[A-Za-z0-9]+$/.test(locationId) || !token) {
    const instructions = "Add the production Square Location ID and access token in Render.";
    return verify ? `Connection check could not run. ${instructions}` : instructions;
  }
  if (!verify) return "Production settings are present. Check the connection to verify the Square location.";

  try {
    const response = await fetcher("https://connect.squareup.com/v2/locations/" + locationId, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}`, "Square-Version": SQUARE_VERSION },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 401 || response.status === 403) {
      return "Square denied access. Check the production access token and its location permissions.";
    }
    if (response.status === 404) return "Square could not find that location. Check the production Location ID.";
    if (!response.ok) return "Square is unavailable. Try checking the connection again.";

    const { location } = await response.json();
    if (!location || location.status !== "ACTIVE") return "The Square location must be active.";
    if (location.currency !== "USD") return "The Square location must use USD.";
    if (!location.capabilities?.includes("CREDIT_CARD_PROCESSING")) {
      return "The Square location is active but is missing the credit card processing capability.";
    }
    return "Connected. Square reports an active USD location with credit card processing.";
  } catch (_) {
    return "Could not verify the Square connection. Try again.";
  }
}

function nextBillingDate(now = DateTime.now()) {
  const today = now.setZone(TIMEZONE).startOf("day");
  const thisMonth = today.set({ day: BILLING_DAY });
  return (thisMonth > today ? thisMonth : thisMonth.plus({ months: 1 })).toISODate();
}

function keyFor(...parts) {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 40);
}

async function squareRequest(config, path, body, fetcher = fetch) {
  const response = await fetcher(SQUARE_SANDBOX + path, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${config.token}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    redirect: "error",
    signal: AbortSignal.timeout(8000),
  });
  const data = await response.json();
  if (!response.ok || data.errors?.length) {
    const error = data.errors?.[0];
    const code = /^[A-Z_][A-Z0-9_]{0,59}$/.test(error?.code || "") ? error.code : "UNKNOWN";
    const field = /^[a-z_][a-z0-9_.\[\]]{0,119}$/i.test(error?.field || "") ? error.field : "";
    const step = path === "/v2/catalog/object"
      ? (body.object.type === "SUBSCRIPTION_PLAN_VARIATION" ? "create the monthly plan variation" : "create the billing plan")
      : path === "/v2/customers" ? "create the test customer"
      : path === "/v2/cards" ? "save the test card"
      : body ? "schedule the subscription" : "refresh the subscription";
    const reference = `${response.status} ${code}${field ? ` · ${field}` : ""}`;
    console.error("[square sandbox]", step, reference);
    const hint = response.status === 401
      ? " Check the Sandbox access token in Render."
      : code === "INVALID_LOCATION" || code === "LOCATION_MISMATCH"
        ? " Check that the Location ID and access token are from the same Sandbox account."
        : "";
    throw new BillingError(
      path === "/v2/cards" && response.status === 400 ? 422 : 502,
      `Square Sandbox could not ${step} (${reference}).${hint}`
    );
  }
  return data;
}

async function ensurePlan(config, request) {
  // Square enables these catalog objects across locations. The subscription
  // itself is created at the configured Sandbox location.
  const { catalog_object: plan } = await request("/v2/catalog/object", {
    idempotency_key: keyFor("plateau-sandbox-plan-v2", config.locationId),
    object: {
      id: "#plateau-sandbox-plan",
      type: "SUBSCRIPTION_PLAN",
      subscription_plan_data: { name: "OpenCircle Plateau Regional Sandbox", all_items: true },
    },
  });
  const { catalog_object: variation } = await request("/v2/catalog/object", {
    idempotency_key: keyFor("plateau-sandbox-monthly-v2", plan.id),
    object: {
      id: "#plateau-sandbox-monthly",
      type: "SUBSCRIPTION_PLAN_VARIATION",
      subscription_plan_variation_data: {
        name: "Plateau Regional monthly sandbox",
        subscription_plan_id: plan.id,
        monthly_billing_anchor_date: BILLING_DAY,
        can_prorate: false,
        phases: [{ cadence: "MONTHLY", ordinal: 0, pricing: { type: "STATIC", price: { amount: AMOUNT_CENTS, currency: "USD" } } }],
      },
    },
  });
  return variation.id;
}

async function readBilling(config, userId) {
  await run(`CREATE TABLE IF NOT EXISTS plateau_sandbox_billing (
    scope TEXT PRIMARY KEY,
    ownerUserId INTEGER NOT NULL,
    locationId TEXT NOT NULL,
    enrollmentId TEXT NOT NULL,
    customerId TEXT,
    cardId TEXT,
    cardLast4 TEXT,
    startDate TEXT,
    variationId TEXT,
    subscriptionId TEXT,
    status TEXT,
    leaseUntil INTEGER NOT NULL DEFAULT 0
  )`);
  const row = await get("SELECT * FROM plateau_sandbox_billing WHERE scope = ?", [SCOPE]);
  if (row && (row.ownerUserId !== userId || row.locationId !== config.locationId)) {
    throw new BillingError(409, "This Sandbox subscription is linked to a different account or location. Contact OpenCircle support.");
  }
  return row || null;
}

async function enrollBilling(config, userId, { sourceId, acceptedStart }, request = (path, body) => squareRequest(config, path, body)) {
  let row = await readBilling(config, userId);
  if (row?.subscriptionId) return row;
  if (!row?.cardId && (typeof sourceId !== "string" || !sourceId || sourceId.length > 512)) {
    throw new BillingError(400, "Enter a Square Sandbox test card first.");
  }
  const startDate = row?.startDate || nextBillingDate();
  if (acceptedStart !== startDate || startDate < nextBillingDate()) {
    throw new BillingError(409, "The first billing date changed or has passed. Reload Billing before retrying.");
  }

  await run(
    "INSERT OR IGNORE INTO plateau_sandbox_billing (scope, ownerUserId, locationId, enrollmentId) VALUES (?, ?, ?, ?)",
    [SCOPE, userId, config.locationId, crypto.randomUUID()]
  );
  row = await readBilling(config, userId);
  if (row.subscriptionId) return row;
  const lease = Date.now() + 90000;
  const claim = await run(
    "UPDATE plateau_sandbox_billing SET leaseUntil = ? WHERE scope = ? AND leaseUntil < ? AND subscriptionId IS NULL",
    [lease, SCOPE, Date.now()]
  );
  if (!claim.changes) throw new BillingError(409, "Setup is already in progress. Wait a moment and reload Billing.");

  try {
    // Reread after taking the lease. Another request may have saved the card.
    row = await readBilling(config, userId);
    const variationId = row.variationId || await ensurePlan(config, request);
    if (!row.customerId) {
      const { customer } = await request("/v2/customers", {
        idempotency_key: keyFor(row.enrollmentId, "customer"),
        company_name: "Plateau Regional Sandbox",
        email_address: "plateau-billing@example.test",
        reference_id: row.enrollmentId,
      });
      await run("UPDATE plateau_sandbox_billing SET customerId = ? WHERE scope = ?", [customer.id, SCOPE]);
      row.customerId = customer.id;
    }
    if (!row.cardId) {
      const { card } = await request("/v2/cards", {
        idempotency_key: keyFor(row.enrollmentId, "card", sourceId),
        source_id: sourceId,
        card: { customer_id: row.customerId },
      });
      await run("UPDATE plateau_sandbox_billing SET cardId = ?, cardLast4 = ? WHERE scope = ?", [card.id, card.last_4 || "", SCOPE]);
      row.cardId = card.id;
    }
    const confirmedStart = row.startDate || startDate;
    if (confirmedStart !== acceptedStart || confirmedStart < nextBillingDate()) {
      throw new BillingError(409, "The first billing date changed. Reload Billing to review the new date.");
    }
    // Save the exact subscription request parameters before calling Square so
    // an interrupted request can be retried with the same idempotency key.
    await run("UPDATE plateau_sandbox_billing SET startDate = ?, variationId = ? WHERE scope = ?", [confirmedStart, variationId, SCOPE]);
    const { subscription } = await request("/v2/subscriptions", {
      idempotency_key: keyFor(row.enrollmentId, "subscription"),
      location_id: config.locationId,
      customer_id: row.customerId,
      card_id: row.cardId,
      plan_variation_id: variationId,
      start_date: confirmedStart,
      timezone: TIMEZONE,
      monthly_billing_anchor_date: BILLING_DAY,
    });
    await run("UPDATE plateau_sandbox_billing SET subscriptionId = ?, status = ? WHERE scope = ?", [subscription.id, subscription.status, SCOPE]);
    return readBilling(config, userId);
  } finally {
    await run("UPDATE plateau_sandbox_billing SET leaseUntil = 0 WHERE scope = ? AND leaseUntil = ?", [SCOPE, lease]);
  }
}

async function refreshBilling(config, row) {
  if (!row?.subscriptionId) return row;
  const { subscription } = await squareRequest(config, "/v2/subscriptions/" + encodeURIComponent(row.subscriptionId));
  return { ...row, status: subscription.status, startDate: subscription.start_date };
}

module.exports = { billingAdminEmail, billingConfig, checkProductionBilling, BillingError, enrollBilling, nextBillingDate, readBilling, refreshBilling };
