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
