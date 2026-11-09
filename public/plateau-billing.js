"use strict";

(async () => {
  const form = document.getElementById("plateauBillingForm");
  if (!form) return;
  const status = document.getElementById("billingStatus");
  const submit = form.querySelector("button[type=submit]");
  let card;
  let sourceId;
  if (form.dataset.needsCard === "1") {
    try {
      const payments = window.Square.payments(form.dataset.applicationId, form.dataset.locationId);
      card = await payments.card();
      await card.attach("#squareCard");
    } catch (_) {
      status.textContent = "Square’s test card form could not load. Reload this page to try again.";
      return;
    }
  }
  submit.disabled = false;
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    submit.disabled = true;
    status.textContent = "Setting up test autopay…";
    try {
      if (card && !sourceId) {
        const result = await card.tokenize({
          intent: "STORE",
          currencyCode: "USD",
          customerInitiated: true,
          sellerKeyedIn: false,
          billingContact: { countryCode: "US" },
        });
        if (result.status !== "OK") throw new Error("Check the test card details and try again.");
        sourceId = result.token;
      }
      const response = await fetch("/admin/billing/enroll", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId, acceptedStart: form.dataset.startDate, authorized: form.elements.authorized.checked }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status === 422) sourceId = undefined;
        throw new Error(data.error || "Test autopay setup failed. Please try again.");
      }
      window.location.assign("/admin/billing");
    } catch (error) {
      status.textContent = error.message;
      submit.disabled = false;
    }
  });
})();
