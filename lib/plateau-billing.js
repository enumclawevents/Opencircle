"use strict";

const crypto = require("node:crypto");
const { DateTime } = require("luxon");
const { all, get, run } = require("../db");

const SQUARE_SANDBOX = "https://connect.squareupsandbox.com";
const SQUARE_PRODUCTION = "https://connect.squareup.com";
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
    const response = await fetcher(SQUARE_PRODUCTION + "/v2/locations/" + locationId, {
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

async function squareRequest(config, path, body, method = body ? "POST" : "GET") {
  const response = await fetch((config.production ? SQUARE_PRODUCTION : SQUARE_SANDBOX) + path, {
    method,
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
    if (config.production) {
      console.error("[square production] payment setup request failed", method, response.status, code, field);
      const invalidCard = path === "/v2/cards" && response.status === 400;
      throw new BillingError(invalidCard ? 422 : 502, invalidCard
        ? "Square could not save this card. Check your card details and try again."
        : "Square could not save the payment method. Please try again or contact OpenCircle support.");
    }
    const step = path === "/v2/catalog/object"
      ? (body.object.type === "SUBSCRIPTION_PLAN_VARIATION" ? "create the monthly plan variation" : "create the billing plan")
      : path === "/v2/customers" ? "create the test customer"
      : path === "/v2/cards" ? "save the test card"
      : /^\/v2\/(invoices|orders|payments)\//.test(path) ? "retrieve billing history"
      : method === "PUT" ? "update the subscription card"
      : path.endsWith("/billing-anchor") ? "schedule the billing day change"
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
  const subscription = await retrieveManagedSubscription(config, row);
  let card = null;
  if (subscription.card_id) {
    try {
      const result = await squareRequest(config, "/v2/cards/" + encodeURIComponent(subscription.card_id));
      if (result.card?.id === subscription.card_id && result.card.customer_id === row.customerId) card = result.card;
    } catch (_) {
      // Subscription and scheduling data remains usable when card details are unavailable.
    }
  }
  return {
    ...row, status: subscription.status, startDate: subscription.start_date,
    cardId: subscription.card_id, cardLast4: card?.last_4 || (subscription.card_id === row.cardId ? row.cardLast4 : ""),
    cardBrand: card?.card_brand, cardMonth: card?.exp_month, cardYear: card?.exp_year, cardEnabled: card?.enabled,
    schedule: billingSchedule(subscription),
  };
}

function subscriptionPath(row) {
  return "/v2/subscriptions/" + encodeURIComponent(row.subscriptionId);
}

async function retrieveManagedSubscription(config, row) {
  const { subscription } = await squareRequest(config, subscriptionPath(row) + "?include=actions");
  if (!subscription || subscription.id !== row.subscriptionId
      || !row.customerId || subscription.customer_id !== row.customerId
      || subscription.location_id !== config.locationId) {
    throw new BillingError(409, "The Square subscription could not be verified for this account.");
  }
  return subscription;
}

function billingSchedule(subscription) {
  const day = subscription.monthly_billing_anchor_date;
  const zone = subscription.timezone || TIMEZONE;
  const today = DateTime.now().setZone(zone).startOf("day");
  const chargedThrough = DateTime.fromISO(subscription.charged_through_date || "", { zone });
  const nextCycle = chargedThrough.plus({ days: 1 });
  const actions = subscription.actions || [];
  const pending = actions.find(action => action.type === "CHANGE_BILLING_ANCHOR_DATE");
  const start = DateTime.fromISO(subscription.start_date || "", { zone });
  const active = subscription.status === "ACTIVE" && !subscription.canceled_date;
  const nextDate = active && nextCycle.isValid && nextCycle >= today && nextCycle.day === day
    && !actions.some(action => !action.effective_date || action.effective_date <= nextCycle.toISODate())
    ? nextCycle.toISODate()
    : subscription.status === "PENDING" && start.isValid && start >= today ? start.toISODate() : null;
  return {
    day: Number.isInteger(day) && day >= 1 && day <= 31 ? day : null,
    zone,
    nextDate,
    pending: pending ? { day: pending.monthly_billing_anchor_date, date: pending.effective_date } : null,
    canChangeDay: Boolean(active && nextDate && actions.length === 0),
  };
}

async function withBillingChange(config, userId, change) {
  const row = await readBilling(config, userId);
  if (!row?.subscriptionId) throw new BillingError(409, "There is no subscription to update.");
  const lease = Date.now() + 90000;
  const claim = await run(
    "UPDATE plateau_sandbox_billing SET leaseUntil = ? WHERE scope = ? AND subscriptionId = ? AND leaseUntil < ?",
    [lease, SCOPE, row.subscriptionId, Date.now()]
  );
  if (!claim.changes) throw new BillingError(409, "A billing change is in progress. Wait a moment and try again.");
  try {
    return await change(row, await retrieveManagedSubscription(config, row));
  } finally {
    await run("UPDATE plateau_sandbox_billing SET leaseUntil = 0 WHERE scope = ? AND leaseUntil = ?", [SCOPE, lease]);
  }
}

async function replaceBillingCard(config, userId, { sourceId, authorized }) {
  if (authorized !== true || typeof sourceId !== "string" || !sourceId || sourceId.length > 512) {
    throw new BillingError(400, "Enter and authorize a replacement test card first.");
  }
  return withBillingChange(config, userId, async (row, subscription) => {
    if (subscription.status !== "ACTIVE" || !Number.isSafeInteger(subscription.version)) {
      throw new BillingError(409, "Square card changes are available after the subscription becomes active.");
    }
    const { card } = await squareRequest(config, "/v2/cards", {
      idempotency_key: keyFor(row.enrollmentId, "replacement", sourceId),
      source_id: sourceId,
      card: { customer_id: row.customerId },
    });
    if (!card?.id || card.customer_id !== row.customerId || card.enabled === false) {
      throw new BillingError(502, "Square could not verify the replacement card.");
    }
    if (subscription.card_id !== card.id) {
      await squareRequest(config, subscriptionPath(row), {
        subscription: { card_id: card.id, version: subscription.version },
      }, "PUT");
    }
    const confirmed = await retrieveManagedSubscription(config, row);
    if (confirmed.card_id !== card.id) {
      throw new BillingError(502, "Square did not confirm the replacement. Reload Billing to check the current card.");
    }
    await run("UPDATE plateau_sandbox_billing SET cardId = ?, cardLast4 = ? WHERE scope = ? AND subscriptionId = ?",
      [card.id, card.last_4 || "", SCOPE, row.subscriptionId]);
  });
}

async function changeBillingDay(config, userId, { day, currentDay, nextDate, authorized }) {
  if (authorized !== true || !Number.isInteger(day) || day < 1 || day > 28) {
    throw new BillingError(400, "Choose a day from 1 to 28 and confirm the billing terms.");
  }
  return withBillingChange(config, userId, async (row, subscription) => {
    const schedule = billingSchedule(subscription);
    if (schedule.pending?.day === day && schedule.pending.date) return;
    if (!schedule.canChangeDay || day === schedule.day || currentDay !== schedule.day || nextDate !== schedule.nextDate) {
      throw new BillingError(409, "This billing schedule cannot be changed from the current page. Reload Billing and review the schedule.");
    }
    // Keep the upcoming cycle intact. Never retry with an immediate effective date.
    const effective = DateTime.fromISO(schedule.nextDate, { zone: schedule.zone }).plus({ months: 1 }).set({ day });
    await squareRequest(config, subscriptionPath(row) + "/billing-anchor", {
      monthly_billing_anchor_date: day,
      effective_date: effective.toISODate(),
    });
    const confirmed = billingSchedule(await retrieveManagedSubscription(config, row));
    if (confirmed.pending?.day !== day || !confirmed.pending.date) {
      throw new BillingError(502, "Square did not confirm a scheduled change. Reload Billing before trying again.");
    }
  });
}

function receiptLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch (_) {
    // Square does not supply a receipt URL for every payment.
  }
  return null;
}

function usdCents(money) {
  return money?.currency === "USD" && Number.isSafeInteger(money.amount) ? money.amount : null;
}

async function retrieveInvoiceHistory(config, row, invoiceId) {
  const { invoice } = await squareRequest(config, "/v2/invoices/" + encodeURIComponent(invoiceId));
  if (invoice?.id !== invoiceId || invoice.subscription_id !== row.subscriptionId
      || invoice.location_id !== config.locationId || invoice.primary_recipient?.customer_id !== row.customerId) {
    throw new BillingError(502, "Square could not verify an invoice for this subscription.");
  }
  const description = invoice.title || "OpenCircle Premium subscription";
  let order;
  const payments = [];
  if (invoice.order_id) {
    ({ order } = await squareRequest(config, "/v2/orders/" + encodeURIComponent(invoice.order_id)));
    if (order?.id !== invoice.order_id || order.location_id !== config.locationId) {
      throw new BillingError(502, "Square could not verify the order for this invoice.");
    }
    const paymentIds = new Set((order.tenders || []).map(tender => tender.payment_id).filter(Boolean));
    for (const paymentId of paymentIds) {
      const { payment } = await squareRequest(config, "/v2/payments/" + encodeURIComponent(paymentId));
      if (payment?.id !== paymentId || payment.order_id !== order.id || payment.location_id !== config.locationId) {
        throw new BillingError(502, "Square could not verify a payment for this invoice.");
      }
      const amount = usdCents(payment.total_money || payment.amount_money);
      const refunded = usdCents(payment.refunded_money);
      const status = payment.status === "COMPLETED"
        ? (refunded > 0 ? (amount !== null && refunded >= amount ? "Refunded" : "Partially refunded") : "Paid")
        : ({ FAILED: "Failed", CANCELED: "Canceled", PENDING: "Pending", APPROVED: "Authorized" }[payment.status] || null);
      payments.push({ id: payment.id, date: payment.created_at || null, description, amount, status, receipt: receiptLink(payment.receipt_url) });
    }
  }
  if (payments.length) return payments;
  const invoiceStatuses = {
    PAID: "Paid", UNPAID: "Unpaid", PAYMENT_PENDING: "Pending", FAILED: "Failed",
    REFUNDED: "Refunded", PARTIALLY_REFUNDED: "Partially refunded", PARTIALLY_PAID: "Partially paid",
    CANCELED: "Canceled", SCHEDULED: "Scheduled", DRAFT: "Draft",
  };
  return [{
    id: invoice.invoice_number || invoice.id,
    date: order?.created_at || invoice.scheduled_at || invoice.payment_requests?.[0]?.due_date || null,
    description,
    amount: usdCents(order?.total_money),
    status: invoiceStatuses[invoice.status] || null,
    receipt: null,
  }];
}

async function readBillingHistory(config, userId, cursor) {
  const row = await readBilling(config, userId);
  return readLinkedBillingHistory(config, row, cursor);
}

async function readLinkedBillingHistory(config, row, cursor) {
  if (!row?.subscriptionId) return { entries: [], nextCursor: null };
  const subscription = await retrieveManagedSubscription(config, row);
  const invoiceIds = [...new Set(subscription.invoice_ids || [])];
  const cursorIndex = cursor ? invoiceIds.indexOf(cursor) : -1;
  if (cursor && cursorIndex === -1) throw new BillingError(409, "Billing history changed. Reload Billing to start again.");
  const start = cursorIndex + 1;
  const page = invoiceIds.slice(start, start + 5);
  const entries = (await Promise.all(page.map(id => retrieveInvoiceHistory(config, row, id)))).flat();
  entries.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return {
    entries,
    nextCursor: start + page.length < invoiceIds.length ? page.at(-1) : null,
    timezone: subscription.timezone || TIMEZONE,
  };
}

function productionPaymentConfig(env = process.env) {
  const appId = String(env.SQUARE_PRODUCTION_APPLICATION_ID || "").trim();
  const token = String(env.SQUARE_PRODUCTION_ACCESS_TOKEN || "").trim();
  const locationId = String(env.SQUARE_PRODUCTION_LOCATION_ID || "").trim();
  if (!token || !/^sq0idp-[A-Za-z0-9_-]+$/.test(appId) || !/^[A-Za-z0-9]+$/.test(locationId)) return null;
  return { production: true, appId, token, locationId };
}

let paymentMethodSchema;
function ensurePaymentMethodSchema() {
  paymentMethodSchema ||= (async () => {
    await run(`CREATE TABLE IF NOT EXISTS account_square_customers (
      userId INTEGER PRIMARY KEY, locationId TEXT NOT NULL, setupId TEXT NOT NULL, customerEmail TEXT NOT NULL,
      customerId TEXT
    )`);
    await run(`CREATE TABLE IF NOT EXISTS organization_billing_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      contactUserId INTEGER NOT NULL, locationId TEXT NOT NULL, variationId TEXT NOT NULL,
      itemVariationId TEXT NOT NULL, enrollmentKey TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 0,
      subscriptionId TEXT UNIQUE, customerId TEXT, subscriptionRequest TEXT, consentedAt TEXT,
      leaseUntil INTEGER NOT NULL DEFAULT 0
    )`);
    await run(`CREATE TABLE IF NOT EXISTS account_square_cards (
      id TEXT PRIMARY KEY, userId INTEGER NOT NULL, brand TEXT, last4 TEXT, expMonth INTEGER, expYear INTEGER,
      createdAt TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
  })().catch(error => {
    paymentMethodSchema = undefined;
    throw error;
  });
  return paymentMethodSchema;
}

async function readAccountSquareCustomer(config, userId) {
  await ensurePaymentMethodSchema();
  const row = await get("SELECT * FROM account_square_customers WHERE userId = ?", [userId]);
  if (row && row.locationId !== config.locationId) {
    throw new BillingError(409, "The payment profile is linked to a different Square location. Contact OpenCircle support.");
  }
  return row;
}

async function listAccountPaymentMethods(config, userId) {
  if (!await readAccountSquareCustomer(config, userId)) return [];
  return all("SELECT id, brand, last4, expMonth, expYear FROM account_square_cards WHERE userId = ? ORDER BY createdAt DESC, rowid DESC", [userId]);
}

async function saveAccountPaymentMethod(config, user, { sourceId, authorized }) {
  const email = String(user.email || "").trim().toLowerCase();
  if (!Number.isSafeInteger(user.id) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new BillingError(400, "A valid OpenCircle account email is required to save a payment method.");
  }
  if (authorized !== true || typeof sourceId !== "string" || !sourceId.startsWith("cnon:") || sourceId.length <= 5 || sourceId.length > 16384) {
    throw new BillingError(400, "Enter your card and authorize Square to save it first.");
  }
  await ensurePaymentMethodSchema();
  await run("INSERT OR IGNORE INTO account_square_customers (userId, locationId, setupId, customerEmail) VALUES (?, ?, ?, ?)",
    [user.id, config.locationId, crypto.randomUUID(), email]);
  const row = await readAccountSquareCustomer(config, user.id);
  let customerId = row.customerId;
  if (!customerId) {
    const { customer } = await squareRequest(config, "/v2/customers", {
      idempotency_key: keyFor(row.setupId, "account-customer"),
      reference_id: row.setupId,
      email_address: row.customerEmail,
    });
    if (!customer?.id) throw new BillingError(502, "Square could not confirm your payment profile.");
    await run("UPDATE account_square_customers SET customerId = ? WHERE userId = ? AND customerId IS NULL", [customer.id, user.id]);
    customerId = (await readAccountSquareCustomer(config, user.id)).customerId;
  }
  const { card } = await squareRequest(config, "/v2/cards", {
    idempotency_key: keyFor(row.setupId, "account-card", sourceId),
    source_id: sourceId,
    card: { customer_id: customerId },
  });
  if (!card?.id || card.customer_id !== customerId || card.enabled === false) {
    throw new BillingError(502, "Square could not confirm the saved card.");
  }
  await run(`INSERT OR IGNORE INTO account_square_cards (id, userId, brand, last4, expMonth, expYear)
    VALUES (?, ?, ?, ?, ?, ?)`,
    [card.id, user.id, card.card_brand || null, /^\d{4}$/.test(card.last_4 || "") ? card.last_4 : null,
      Number.isInteger(card.exp_month) ? card.exp_month : null, Number.isInteger(card.exp_year) ? card.exp_year : null]);
}

function organizationFirstCharge(now = DateTime.now()) {
  const today = now.setZone(TIMEZONE).startOf("day");
  return today.startOf("month").plus({ months: 1 }).toISODate();
}

async function listOrganizationBillingAccounts(userId) {
  await ensurePaymentMethodSchema();
  return userId == null
    ? all(`SELECT a.id, a.name, a.enabled, a.subscriptionId, a.variationId, a.itemVariationId, u.email
        FROM organization_billing_accounts a LEFT JOIN users u ON a.contactUserId = u.id ORDER BY a.name`)
    : all(`SELECT id, name, enabled, subscriptionId FROM organization_billing_accounts
        WHERE contactUserId = ? AND (enabled = 1 OR subscriptionId IS NOT NULL) ORDER BY name`, [userId]);
}

async function getOrganizationBillingAccount(id, userId) {
  await ensurePaymentMethodSchema();
  const account = await get("SELECT * FROM organization_billing_accounts WHERE id = ? AND contactUserId = ?", [id, userId]);
  if (!account || (!account.enabled && !account.subscriptionId)) {
    throw new BillingError(404, "Billing account not found.");
  }
  return account;
}

async function getOrganizationPlan(config, variationId, itemVariationId) {
  const { object } = await squareRequest(config, "/v2/catalog/object/" + encodeURIComponent(variationId));
  const variation = object?.subscription_plan_variation_data;
  const phase = variation?.phases?.[0];
  if (object?.id !== variationId || object.type !== "SUBSCRIPTION_PLAN_VARIATION" || object.is_deleted
      || object.present_at_all_locations === false || variation?.monthly_billing_anchor_date !== 1
      || variation?.phases?.length !== 1 || phase.cadence !== "MONTHLY" || (phase.periods != null && phase.periods !== 0)) {
    throw new BillingError(409, "The Square plan must have a single ongoing monthly phase billed on the 1st.");
  }
  if (phase.pricing?.type === "STATIC" && usdCents(phase.pricing.price) === AMOUNT_CENTS) return null;
  if (phase.pricing?.type !== "RELATIVE" || phase.pricing.discount_ids?.length || !phase.uid || !itemVariationId) {
    throw new BillingError(409, "Square could not verify the $100 monthly plan. Check the plan and item variations.");
  }
  const { object: item } = await squareRequest(config, "/v2/catalog/object/" + encodeURIComponent(itemVariationId));
  const itemData = item?.item_variation_data;
  if (item?.id !== itemVariationId || item.type !== "ITEM_VARIATION" || item.is_deleted || itemData?.sellable === false
      || usdCents(itemData?.price_money) !== AMOUNT_CENTS
      || !variation.subscription_plan_id || !itemData?.subscription_plan_ids?.includes(variation.subscription_plan_id)) {
    throw new BillingError(409, "The Square item must belong to the plan and have a price of $100.00 USD.");
  }
  return phase;
}

async function createOrganizationBillingAccount(config, { name, contactUserId, variationId, itemVariationId = "" }) {
  const validId = /^[A-Za-z0-9_-]{1,100}$/;
  if (typeof name !== "string" || !name.trim() || name.trim().length > 120
      || !Number.isSafeInteger(contactUserId) || typeof variationId !== "string" || !validId.test(variationId)
      || typeof itemVariationId !== "string" || (itemVariationId && !validId.test(itemVariationId))) {
    throw new BillingError(400, "Enter an organization name, billing contact, and valid Square variation IDs.");
  }
  await ensurePaymentMethodSchema();
  const contact = await get("SELECT id, email FROM users WHERE id = ?", [contactUserId]);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(contact?.email || "").trim())) {
    throw new BillingError(400, "Select an existing OpenCircle account with an email address.");
  }
  await getOrganizationPlan(config, variationId, itemVariationId);
  const result = await run(`INSERT INTO organization_billing_accounts
    (name, contactUserId, locationId, variationId, itemVariationId, enrollmentKey)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(name) DO NOTHING`,
    [name.trim().replace(/\s+/g, " "), contactUserId, config.locationId, variationId, itemVariationId, crypto.randomUUID()]);
  if (!result.changes) throw new BillingError(409, "A billing account with this organization name already exists.");
}

async function setOrganizationEnrollment(config, id, enabled) {
  await ensurePaymentMethodSchema();
  const result = await run(`UPDATE organization_billing_accounts SET enabled = ?
    WHERE id = ? AND locationId = ? AND subscriptionId IS NULL`, [enabled ? 1 : 0, id, config.locationId]);
  if (!result.changes) throw new BillingError(409, "This organization is unavailable or already has a subscription.");
}

async function organizationBillingStatus(config, account) {
  if (!account.subscriptionId || account.locationId !== config.locationId) return null;
  const subscription = await retrieveManagedSubscription(config, account);
  return { status: subscription.status, schedule: billingSchedule(subscription) };
}

async function readOrganizationBillingHistory(config, id, userId, cursor) {
  const account = await getOrganizationBillingAccount(id, userId);
  if (account.locationId !== config.locationId) throw new BillingError(409, "The Square billing location has changed.");
  return readLinkedBillingHistory(config, account, cursor);
}

async function enrollOrganizationBilling(config, userId, { organizationId, cardId, acceptedStart, authorized }) {
  if (!Number.isSafeInteger(organizationId) || typeof cardId !== "string" || !cardId || cardId.length > 255
      || authorized !== true || typeof acceptedStart !== "string") {
    throw new BillingError(400, "Choose a saved card and confirm the subscription terms first.");
  }
  const account = await getOrganizationBillingAccount(organizationId, userId);
  if (account.locationId !== config.locationId) throw new BillingError(409, "The Square billing location has changed.");
  if (account.subscriptionId) return;
  const customer = await readAccountSquareCustomer(config, userId);
  const saved = await get("SELECT id FROM account_square_cards WHERE id = ? AND userId = ?", [cardId, userId]);
  if (!customer?.customerId || !saved) throw new BillingError(400, "Choose a card saved to your account.");
  const lease = Date.now() + 90000;
  const claim = await run(`UPDATE organization_billing_accounts SET leaseUntil = ?
    WHERE id = ? AND contactUserId = ? AND enabled = 1 AND subscriptionId IS NULL AND leaseUntil < ?`,
    [lease, organizationId, userId, Date.now()]);
  if (!claim.changes) throw new BillingError(409, "Enrollment is unavailable or already in progress. Reload Billing.");
  try {
    const current = await get("SELECT subscriptionRequest FROM organization_billing_accounts WHERE id = ? AND leaseUntil = ?", [organizationId, lease]);
    let body = current.subscriptionRequest ? JSON.parse(current.subscriptionRequest) : null;
    const firstCharge = body?.start_date || organizationFirstCharge();
    if (acceptedStart !== firstCharge || firstCharge <= DateTime.now().setZone(TIMEZONE).toISODate()
        || (body && (body.card_id !== cardId || body.customer_id !== customer.customerId))) {
      throw new BillingError(409, "The authorized date or card does not match. Reload Billing before trying again.");
    }
    if (!body) {
      const { card } = await squareRequest(config, "/v2/cards/" + encodeURIComponent(cardId));
      if (card?.id !== cardId || card.customer_id !== customer.customerId || card.enabled !== true) {
        throw new BillingError(409, "This saved card is unavailable. Choose another card.");
      }
      const phase = await getOrganizationPlan(config, account.variationId, account.itemVariationId);
      let phases;
      if (phase) {
        const { order } = await squareRequest(config, "/v2/orders", {
          idempotency_key: keyFor(account.enrollmentKey, "order-template"),
          order: { location_id: config.locationId, customer_id: customer.customerId, state: "DRAFT",
            line_items: [{ catalog_object_id: account.itemVariationId, quantity: "1" }] },
        });
        if (!order?.id || order.state !== "DRAFT" || usdCents(order.total_money) !== AMOUNT_CENTS) {
          throw new BillingError(409, "The Square order does not total $100.00. Contact OpenCircle support.");
        }
        phases = [{ ordinal: 0, plan_phase_uid: phase.uid, order_template_id: order.id }];
      }
      body = {
        idempotency_key: keyFor(account.enrollmentKey, "subscription"),
        location_id: config.locationId, customer_id: customer.customerId, card_id: cardId,
        plan_variation_id: account.variationId, start_date: firstCharge, timezone: TIMEZONE,
        monthly_billing_anchor_date: 1, ...(phases ? { phases } : {}),
      };
      await run(`UPDATE organization_billing_accounts SET subscriptionRequest = ?, customerId = ?, consentedAt = datetime('now')
        WHERE id = ? AND leaseUntil = ?`, [JSON.stringify(body), customer.customerId, organizationId, lease]);
    }
    if (body.start_date <= DateTime.now().setZone(TIMEZONE).toISODate()) {
      throw new BillingError(409, "The authorized first charge date has passed. Contact OpenCircle support.");
    }
    const { subscription } = await squareRequest(config, "/v2/subscriptions", body);
    if (!subscription?.id || subscription.customer_id !== body.customer_id || subscription.location_id !== body.location_id
        || subscription.plan_variation_id !== body.plan_variation_id || subscription.card_id !== body.card_id
        || subscription.start_date !== body.start_date || subscription.status !== "PENDING") {
      throw new BillingError(502, "Square did not confirm the expected subscription. Contact OpenCircle support.");
    }
    await run("UPDATE organization_billing_accounts SET subscriptionId = ? WHERE id = ? AND leaseUntil = ?",
      [subscription.id, organizationId, lease]);
  } finally {
    await run("UPDATE organization_billing_accounts SET leaseUntil = 0 WHERE id = ? AND leaseUntil = ?", [organizationId, lease]);
  }
}

module.exports = { billingAdminEmail, billingConfig, checkProductionBilling, BillingError, enrollBilling, nextBillingDate, readBilling, refreshBilling, replaceBillingCard, changeBillingDay, readBillingHistory, productionPaymentConfig, listAccountPaymentMethods, saveAccountPaymentMethod, organizationFirstCharge, listOrganizationBillingAccounts, getOrganizationBillingAccount, createOrganizationBillingAccount, setOrganizationEnrollment, organizationBillingStatus, readOrganizationBillingHistory, enrollOrganizationBilling };
