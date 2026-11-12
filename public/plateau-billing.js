"use strict";

async function submitBillingChange(action, data) {
  const response = await fetch("/admin/billing/" + action, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  const result = await response.json();
  if (!response.ok || result.ok !== true) {
    const error = new Error(result.error || "Could not confirm the billing change. Reload Billing and try again.");
    error.status = response.status;
    throw error;
  }
}

for (const button of document.querySelectorAll("[data-billing-toggle]")) {
  const panel = document.getElementById(button.getAttribute("aria-controls"));
  if (!panel) continue;
  button.disabled = false;
  button.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    button.setAttribute("aria-expanded", String(!panel.hidden));
  });
}

(async () => {
  const form = document.getElementById("plateauBillingForm");
  if (!form) return;
  const status = document.getElementById("billingStatus");
  const submit = form.querySelector("button[type=submit]");
  const replacing = form.dataset.replaceCard === "1";
  if (replacing) {
    const toggle = document.querySelector('[aria-controls="plateauBillingForm"]');
    await new Promise(resolve => toggle.addEventListener("click", resolve, { once: true }));
    status.textContent = "Loading the Square card form…";
  }
  let card;
  let sourceId;
  if (form.dataset.needsCard === "1") {
    try {
      const payments = window.Square.payments(form.dataset.applicationId, form.dataset.locationId);
      card = await payments.card();
      await card.attach("#squareCard");
      status.textContent = "";
    } catch (_) {
      status.textContent = "Square’s test card form could not load. Reload this page to try again.";
      return;
    }
  }
  submit.disabled = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = replacing ? "Saving the replacement test card…" : "Setting up test autopay…";
    try {
      if (card && !sourceId) {
        const result = await card.tokenize({
          intent: "STORE",
          customerInitiated: true,
          sellerKeyedIn: false,
          billingContact: {
            givenName: "Sandbox",
            familyName: "Tester",
            email: "plateau-billing@example.test",
            phone: "2065550100",
            addressLines: ["123 Main Street"],
            city: "Enumclaw",
            state: "WA",
            postalCode: "98022",
            countryCode: "US",
          },
        });
        if (result.status !== "OK" || !result.token) {
          const codes = (result.errors || []).map((error) => error.code)
            .filter((code) => typeof code === "string" && /^[A-Za-z0-9_-]{1,60}$/.test(code));
          const detail = codes.length ? ` Square code: ${[...new Set(codes)].slice(0, 3).join(", ")}.` : "";
          throw new Error("Square could not verify the Sandbox card. Try test Visa 4800 0000 0000 0004 with CVV 111, a future expiration, and ZIP 98022." + detail);
        }
        sourceId = result.token;
      }
      await submitBillingChange(replacing ? "change-card" : "enroll", {
        sourceId, acceptedStart: form.dataset.startDate, authorized: form.elements.authorized.checked,
      });
      status.textContent = replacing ? "Square confirmed your replacement card. Refreshing Billing…" : "Test autopay authorized. Refreshing your subscription…";
      setTimeout(() => window.location.assign("/admin/billing?sandbox=1"), replacing ? 1200 : 0);
    } catch (error) {
      if (error.status === 422) sourceId = undefined;
      status.textContent = error.message;
      submit.disabled = false;
    }
  });
})();

const billingDayForm = document.getElementById("billingDayForm");
if (billingDayForm) {
  const button = billingDayForm.querySelector("button[type=submit]");
  const status = billingDayForm.querySelector("[role=status]");
  button.disabled = false;
  billingDayForm.addEventListener("change", event => {
    if (event.target === billingDayForm.elements.day) billingDayForm.elements.authorized.checked = false;
  });
  billingDayForm.addEventListener("submit", async event => {
    event.preventDefault();
    button.disabled = true;
    status.textContent = "Asking Square to schedule the billing day change…";
    try {
      await submitBillingChange("change-day", {
        day: Number(billingDayForm.elements.day.value),
        currentDay: Number(billingDayForm.dataset.currentDay),
        nextDate: billingDayForm.dataset.nextDate,
        authorized: billingDayForm.elements.authorized.checked,
      });
      status.textContent = "Square confirmed the scheduled change. Refreshing Billing…";
      setTimeout(() => window.location.assign("/admin/billing?sandbox=1"), 1200);
    } catch (error) {
      status.textContent = error.message;
      button.disabled = false;
    }
  });
}
