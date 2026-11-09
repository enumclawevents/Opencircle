"use strict";

process.env.DB_PATH = ":memory:";

const assert = require("node:assert/strict");
const { test, after } = require("node:test");
const { DateTime } = require("luxon");
const { run, db } = require("../db");
const { readBilling, refreshBilling, replaceBillingCard, changeBillingDay } = require("../lib/plateau-billing");

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
