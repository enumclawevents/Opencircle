"use strict";

(async () => {
  const form = document.getElementById("accountPaymentMethodForm");
  const status = document.getElementById("productionCardStatus");
  const button = form.querySelector("button[type=submit]");
  let card;
  let sourceId;

  try {
    const container = document.getElementById("productionSquareCard");
    const payments = window.Square.payments(container.dataset.applicationId, container.dataset.locationId);
    card = await payments.card();
    await card.attach("#productionSquareCard");
    status.textContent = "";
  } catch (_) {
    status.textContent = "The payment form could not load. Reload Billing to try again.";
    return;
  }

  form.addEventListener("input", () => { sourceId = undefined; });
  button.disabled = false;
  form.addEventListener("submit", async event => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    status.textContent = "Saving your card with Square…";
    try {
      if (!sourceId) {
        const details = form.elements;
        const result = await card.tokenize({
          intent: "STORE",
          customerInitiated: true,
          sellerKeyedIn: false,
          billingContact: {
            givenName: details.givenName.value.trim(),
            familyName: details.familyName.value.trim(),
            email: form.dataset.email,
            addressLines: [details.address.value.trim()],
            city: details.city.value.trim(),
            state: details.region.value.trim().toUpperCase(),
            postalCode: details.postalCode.value.trim(),
            countryCode: "US",
          },
        });
        if (result.status !== "OK" || !result.token) throw new Error("Square could not verify this card. Check your details and try again.");
        sourceId = result.token;
      }
      const response = await fetch("/admin/billing/payment-methods", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceId,
          authorized: form.elements.authorized.checked,
        }),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) {
        if (response.status === 422) sourceId = undefined;
        throw new Error(result.error || "Could not confirm the saved card. Please try again.");
      }
      status.textContent = "Square saved your card. Refreshing Payment Methods…";
      window.location.assign("/admin/billing");
    } catch (error) {
      status.textContent = error.message || "Could not confirm the saved card. Please try again.";
      button.disabled = false;
    }
  });
})();


const organizationEnrollment = document.getElementById("organizationEnrollmentForm");
if (organizationEnrollment) {
  const button = organizationEnrollment.querySelector('button[type="submit"]');
  organizationEnrollment.addEventListener("submit", () => {
    button.disabled = true;
    document.getElementById("organizationEnrollmentStatus").textContent = "Confirming your subscription with Square…";
  });
  window.addEventListener("pageshow", () => {
    button.disabled = false;
    document.getElementById("organizationEnrollmentStatus").textContent = "";
  });
}
