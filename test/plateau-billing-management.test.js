"use strict";

process.env.DB_PATH = ":memory:";

const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { DateTime } = require("luxon");
const { run, db } = require("../db");
const { readBilling, refreshBilling, replaceBillingCard, changeBillingDay, readBillingHistory } = require("../lib/plateau-billing");

after(() => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())));

test("Sandbox changes target the linked subscription and require Square confirmation", async t => {
  const config = { locationId: "location", token: "test-secret" };
  const owner = 12;
  await readBilling(config, owner);
  await run(
    "INSERT INTO plateau_sandbox_billing (scope, ownerUserId, locationId, enrollmentId, customerId, subscriptionId, cardId, cardLast4) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ["Plateau Regional", owner, "location", "enrollment", "customer", "linked-subscription", "old-card", "1111"]
  );

  const nextCycle = DateTime.now().setZone("America/Los_Angeles").startOf("month").plus({ months: 1 }).set({ day: 8 });
  const subscription = {
    id: "linked-subscription", customer_id: "customer", location_id: "location", status: "ACTIVE",
    card_id: "old-card", version: 3, monthly_billing_anchor_date: 8,
    charged_through_date: nextCycle.minus({ days: 1 }).toISODate(), timezone: "America/Los_Angeles",
    actions: [],
  };
  const requests = [];
  let rejectCardUpdate = true;
  t.mock.method(global, "fetch", async (url, options) => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.origin, "https://connect.squareupsandbox.com");
    const body = options.body && JSON.parse(options.body);
    requests.push({ path: requestUrl.pathname, method: options.method, body });
    const respond = (data, status = 200) => ({ ok: status === 200, status, json: async () => structuredClone(data) });
    switch (requestUrl.pathname) {
      case "/v2/subscriptions/linked-subscription":
        if (options.method === "GET") {
          assert.equal(requestUrl.searchParams.get("include"), "actions");
        } else {
          assert.equal(options.method, "PUT");
          assert.deepEqual(body, { subscription: { card_id: "new-card", version: 3 } });
          if (rejectCardUpdate) return respond({ errors: [{ code: "INVALID_CARD" }] }, 400);
          subscription.card_id = "new-card";
        }
        return respond({ subscription });
      case "/v2/cards":
        assert.equal(body.card.customer_id, "customer");
        return respond({ card: { id: "new-card", customer_id: "customer", enabled: true, last_4: "2222" } });
      case "/v2/cards/new-card":
        return respond({ card: { id: "new-card", customer_id: "customer", last_4: "2222", card_brand: "VISA" } });
      case "/v2/subscriptions/linked-subscription/billing-anchor":
        assert.equal(body.effective_date, nextCycle.plus({ months: 1 }).set({ day: 5 }).toISODate());
        subscription.actions = [{
          type: "CHANGE_BILLING_ANCHOR_DATE", monthly_billing_anchor_date: body.monthly_billing_anchor_date,
          effective_date: body.effective_date,
        }];
        return respond({ subscription });
      default:
        assert.fail("Unexpected Square endpoint: " + requestUrl.pathname);
    }
  });

  const cardChange = { sourceId: "test-nonce", authorized: true, subscriptionId: "another-subscription" };
  await assert.rejects(replaceBillingCard(config, 99, cardChange), /different account/);
  subscription.status = "PENDING";
  await assert.rejects(replaceBillingCard(config, owner, cardChange), /becomes active/);
  subscription.status = "ACTIVE";
  await assert.rejects(replaceBillingCard(config, owner, cardChange), /update the subscription card/);
  assert.equal(subscription.card_id, "old-card");
  assert.equal((await readBilling(config, owner)).cardId, "old-card");
  rejectCardUpdate = false;
  await replaceBillingCard(config, owner, cardChange);
  assert.equal(subscription.card_id, "new-card");
  assert.equal((await readBilling(config, owner)).cardId, "new-card");
  const cardRequests = requests.filter(request => request.path === "/v2/cards");
  assert.equal(cardRequests.length, 2);
  assert.equal(cardRequests[0].body.idempotency_key, cardRequests[1].body.idempotency_key);

  const scheduleChange = { day: 5, currentDay: 8, nextDate: nextCycle.toISODate(), authorized: true };
  await assert.rejects(changeBillingDay(config, owner, { ...scheduleChange, day: 29 }), /1 to 28/);
  await assert.rejects(changeBillingDay(config, owner, { ...scheduleChange, authorized: false }), /confirm/);
  await assert.rejects(changeBillingDay(config, owner, { ...scheduleChange, currentDay: 9 }), /current page/);
  await changeBillingDay(config, owner, scheduleChange);
  await changeBillingDay(config, owner, scheduleChange);
  await assert.rejects(changeBillingDay(config, owner, { ...scheduleChange, day: 6 }), /current page/);
  assert.equal(requests.filter(request => request.path.endsWith("/billing-anchor")).length, 1);

  const billing = await refreshBilling(config, await readBilling(config, owner));
  assert.equal(billing.cardBrand, "VISA");
  assert.equal(billing.schedule.day, 8);
  assert.equal(billing.schedule.nextDate, nextCycle.toISODate());
  assert.equal(billing.schedule.pending.day, 5);
  assert.equal(billing.schedule.canChangeDay, false);
  assert.ok(requests.every(request => !request.path.includes("another-subscription") && !request.path.includes("disable")));
});

test("history follows only the linked subscription and paginates confirmed Square data", async t => {
  const config = { locationId: "history-location", token: "test-secret" };
  await run("DELETE FROM plateau_sandbox_billing");
  assert.deepEqual(await readBillingHistory(config, 25), { entries: [], nextCursor: null });
  await run(
    "INSERT INTO plateau_sandbox_billing (scope, ownerUserId, locationId, enrollmentId, customerId, subscriptionId) VALUES (?, ?, ?, ?, ?, ?)",
    ["Plateau Regional", 25, config.locationId, "history-enrollment", "history-customer", "history-subscription"]
  );
  const invoiceIds = ["inv-6", "inv-5", "inv-4", "inv-3", "inv-2", "inv-1"];
  let unavailable = false;
  let mismatch = false;
  let calls = 0;
  t.mock.method(global, "fetch", async (url) => {
    calls++;
    const requestUrl = new URL(url);
    assert.equal(requestUrl.origin, "https://connect.squareupsandbox.com");
    const [, , resource, id] = requestUrl.pathname.split("/");
    if (unavailable) return { ok: false, status: 503, json: async () => ({ errors: [{ code: "SERVICE_UNAVAILABLE" }] }) };
    let data;
    if (resource === "subscriptions") {
      assert.equal(id, "history-subscription");
      data = { subscription: { id, location_id: config.locationId, customer_id: "history-customer", invoice_ids: invoiceIds } };
    } else if (resource === "invoices") {
      assert.ok(invoiceIds.includes(id));
      data = { invoice: { id, subscription_id: mismatch ? "other-subscription" : "history-subscription",
        location_id: config.locationId, primary_recipient: { customer_id: "history-customer" },
        order_id: id.replace("inv-", "ord-"), status: "UNPAID" } };
    } else if (resource === "orders") {
      const number = Number(id.at(-1));
      data = { order: { id, location_id: config.locationId, created_at: `2026-10-0${number}T18:00:00Z`,
        total_money: { amount: 10000, currency: "USD" }, tenders: number >= 4 ? [{ payment_id: "pay-" + number }] : [] } };
    } else {
      assert.equal(resource, "payments");
      const number = Number(id.at(-1));
      data = { payment: { id, order_id: "ord-" + number, location_id: config.locationId,
        created_at: `2026-10-0${number}T18:00:00Z`, status: number === 4 ? "FAILED" : "COMPLETED",
        total_money: { amount: 10000, currency: "USD" }, refunded_money: { amount: number === 5 ? 10000 : 0, currency: "USD" },
        receipt_url: number === 6 ? "https://squareup.com/receipt/preview/test" : "javascript:invalid" } };
    }
    return { ok: true, status: 200, json: async () => data };
  });
  await assert.rejects(readBillingHistory(config, 99), /different account/);
  assert.equal(calls, 0);
  const first = await readBillingHistory(config, 25);
  assert.deepEqual(first.entries.map(entry => entry.status), ["Paid", "Refunded", "Failed", "Unpaid", "Unpaid"]);
  assert.equal(first.entries[0].receipt, "https://squareup.com/receipt/preview/test");
  assert.equal(first.entries[1].receipt, null);
  assert.equal(first.entries[0].amount, 10000);
  assert.equal(first.nextCursor, "inv-2");
  const second = await readBillingHistory(config, 25, first.nextCursor);
  assert.deepEqual(second.entries.map(entry => entry.id), ["inv-1"]);
  assert.equal(second.nextCursor, null);
  await assert.rejects(readBillingHistory(config, 25, "other-invoice"), /history changed/);
  mismatch = true;
  await assert.rejects(readBillingHistory(config, 25), /could not verify an invoice/);
  unavailable = true;
  await assert.rejects(readBillingHistory(config, 25), /SERVICE_UNAVAILABLE/);
});

test("production card setup creates isolated customer profiles and never submits a charge", async t => {
  const { productionPaymentConfig, saveAccountPaymentMethod, listAccountPaymentMethods } = require("../lib/plateau-billing");
  const config = productionPaymentConfig({
    SQUARE_PRODUCTION_APPLICATION_ID: "sq0idp-example",
    SQUARE_PRODUCTION_LOCATION_ID: "Prod123",
    SQUARE_PRODUCTION_ACCESS_TOKEN: "mock-secret",
  });
  const customers = new Map();
  const cards = new Map();
  const requests = [];
  let failCard = true;
  t.mock.method(global, "fetch", async (url, options) => {
    const requestUrl = new URL(url);
    assert.equal(requestUrl.origin, "https://connect.squareup.com");
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    requests.push({ path: requestUrl.pathname, body });
    let data;
    if (requestUrl.pathname === "/v2/customers") {
      const customer = customers.get(body.idempotency_key) || { id: "customer-" + (customers.size + 1) };
      customers.set(body.idempotency_key, customer);
      data = { customer };
    } else {
      assert.equal(requestUrl.pathname, "/v2/cards");
      const card = cards.get(body.idempotency_key) || {
        id: "card-" + (cards.size + 1), customer_id: body.card.customer_id, card_brand: "VISA",
        last_4: body.card.customer_id === "customer-1" ? "1111" : "2222", exp_month: 12, exp_year: 2030,
      };
      cards.set(body.idempotency_key, card);
      if (failCard) { failCard = false; throw new Error("Interrupted response"); }
      data = { card };
    }
    return { ok: true, status: 200, json: async () => data };
  });
  const owner = { id: 41, email: "first@example.test" };
  const other = { id: 42, email: "other@example.test" };
  const card = { sourceId: "cnon:first-token", authorized: true, customerId: "untrusted" };
  assert.deepEqual(await listAccountPaymentMethods(config, owner.id), []);
  await assert.rejects(saveAccountPaymentMethod(config, owner, { ...card, authorized: false }), /authorize Square/);
  await assert.rejects(saveAccountPaymentMethod(config, owner, { ...card, sourceId: "payment-id" }), /authorize Square/);
  assert.equal(requests.length, 0);
  await assert.rejects(saveAccountPaymentMethod(config, owner, card), /Interrupted response/);
  await saveAccountPaymentMethod(config, owner, card);
  assert.equal(requests[1].body.idempotency_key, requests[2].body.idempotency_key);
  await saveAccountPaymentMethod(config, owner, { ...card, sourceId: "cnon:additional-card" });
  await saveAccountPaymentMethod(config, other, { ...card, sourceId: "cnon:other-card" });
  assert.equal(customers.size, 2);
  assert.ok(requests.filter(request => request.path === "/v2/cards").every(request => request.body.card.customer_id !== "untrusted"));
  assert.deepEqual((await listAccountPaymentMethods(config, owner.id)).map(item => item.last4), ["1111", "1111"]);
  assert.deepEqual((await listAccountPaymentMethods(config, other.id)).map(item => item.last4), ["2222"]);
  await assert.rejects(listAccountPaymentMethods({ ...config, locationId: "another" }, owner.id), /different Square location/);
});

test("organization enrollment requires its designated contact, consent, and a future start", async t => {
  const { initDB } = require("../db");
  const { Settings } = require("luxon");
  const {
    productionPaymentConfig, saveAccountPaymentMethod, createOrganizationBillingAccount, listOrganizationBillingAccounts,
    setOrganizationEnrollment, enrollOrganizationBilling, getOrganizationBillingAccount, organizationBillingStatus,
    readOrganizationBillingHistory,
  } = require("../lib/plateau-billing");
  await initDB();
  await run("INSERT INTO users (id, email, username) VALUES (51, 'org-contact@example.test', 'org-contact')");
  const config = productionPaymentConfig({
    SQUARE_PRODUCTION_APPLICATION_ID: "sq0idp-example",
    SQUARE_PRODUCTION_LOCATION_ID: "Org123",
    SQUARE_PRODUCTION_ACCESS_TOKEN: "mock-secret",
  });
  const savedNow = Settings.now;
  Settings.now = () => Date.parse("2026-11-20T20:00:00Z");
  t.after(() => { Settings.now = savedNow; });
  const subscriptionRequests = [];
  let subscription;
  let orderAmount = 11000;
  t.mock.method(global, "fetch", async (url, options) => {
    const path = new URL(url).pathname;
    assert.equal(new URL(url).origin, "https://connect.squareup.com");
    const body = options.body && JSON.parse(options.body);
    let data;
    switch (path) {
      case "/v2/customers": data = { customer: { id: "org-customer" } }; break;
      case "/v2/cards":
      case "/v2/cards/org-card":
        data = { card: { id: "org-card", customer_id: "org-customer", enabled: true, last_4: "1234" } };
        break;
      case "/v2/catalog/object/monthly":
        data = { object: { id: "monthly", type: "SUBSCRIPTION_PLAN_VARIATION", present_at_all_locations: true,
          subscription_plan_variation_data: { subscription_plan_id: "plan", monthly_billing_anchor_date: 1,
            phases: [{ uid: "phase", cadence: "MONTHLY", pricing: { type: "RELATIVE" } }] } } };
        break;
      case "/v2/catalog/object/item":
        data = { object: { id: "item", type: "ITEM_VARIATION",
          item_variation_data: { price_money: { amount: 10000, currency: "USD" }, subscription_plan_ids: ["plan"] } } };
        break;
      case "/v2/orders":
        assert.equal(body.order.state, "DRAFT");
        assert.deepEqual(body.order.line_items, [{ catalog_object_id: "item", quantity: "1" }]);
        data = { order: { id: "draft", state: "DRAFT", total_money: { amount: orderAmount, currency: "USD" } } };
        break;
      case "/v2/subscriptions":
        subscriptionRequests.push(body);
        assert.equal(body.start_date, "2026-12-01");
        assert.equal(body.monthly_billing_anchor_date, 1);
        assert.equal(body.card_id, "org-card");
        assert.deepEqual(body.phases, [{ ordinal: 0, plan_phase_uid: "phase", order_template_id: "draft" }]);
        if (subscriptionRequests.length === 1) throw new Error("Interrupted response");
        subscription = { ...body, id: "org-subscription", status: "PENDING", invoice_ids: [] };
        data = { subscription };
        break;
      case "/v2/subscriptions/org-subscription":
        data = { subscription };
        break;
      default: assert.fail("Unexpected Square endpoint " + path);
    }
    return { ok: true, status: 200, json: async () => data };
  });
  const contact = { id: 51, email: "org-contact@example.test" };
  const setup = { name: "Example Organization", contactUserId: contact.id, variationId: "monthly", itemVariationId: "item" };
  await createOrganizationBillingAccount(config, setup);
  await assert.rejects(createOrganizationBillingAccount(config, { ...setup, name: "example organization" }), /already exists/);
  assert.deepEqual(await listOrganizationBillingAccounts(contact.id), []);
  const [organization] = await listOrganizationBillingAccounts();
  const consent = { organizationId: organization.id, cardId: "org-card", acceptedStart: "2026-12-01", authorized: true };
  await saveAccountPaymentMethod(config, contact, { sourceId: "cnon:org", authorized: true });
  await assert.rejects(enrollOrganizationBilling(config, contact.id, consent), /not found/);
  await setOrganizationEnrollment(config, organization.id, true);
  await assert.rejects(enrollOrganizationBilling(config, 52, consent), /not found/);
  await assert.rejects(enrollOrganizationBilling(config, contact.id, { ...consent, authorized: false }), /confirm/);
  await assert.rejects(enrollOrganizationBilling(config, contact.id, { ...consent, cardId: "someone-elses-card" }), /saved to your account/);
  await assert.rejects(enrollOrganizationBilling(config, contact.id, { ...consent, acceptedStart: "2026-11-01" }), /authorized date/);
  await assert.rejects(enrollOrganizationBilling(config, contact.id, consent), /does not total/);
  assert.equal(subscriptionRequests.length, 0);
  orderAmount = 10000;
  await assert.rejects(enrollOrganizationBilling(config, contact.id, consent), /Interrupted response/);
  await enrollOrganizationBilling(config, contact.id, consent);
  await enrollOrganizationBilling(config, contact.id, consent);
  assert.equal(subscriptionRequests.length, 2);
  assert.deepEqual(subscriptionRequests[0], subscriptionRequests[1]);
  const linked = await getOrganizationBillingAccount(organization.id, contact.id);
  assert.ok(linked.consentedAt);
  assert.equal((await organizationBillingStatus(config, linked)).schedule.nextDate, "2026-12-01");
  assert.deepEqual((await readOrganizationBillingHistory(config, organization.id, contact.id)).entries, []);
  await assert.rejects(readOrganizationBillingHistory(config, organization.id, 52), /not found/);
});
