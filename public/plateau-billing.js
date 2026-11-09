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
