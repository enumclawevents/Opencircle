"use strict";

const productionBillingCheck = document.getElementById("productionBillingCheck");
const productionBillingStatus = document.getElementById("productionBillingStatus");

productionBillingCheck.addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = productionBillingCheck.querySelector("button");
  button.disabled = true;
  productionBillingStatus.textContent = "Checking the live Square connection…";
  try {
    const response = await fetch("/admin/billing/production-connection", { cache: "no-store" });
    if (!response.ok) throw new Error("Connection check failed");
    const { status } = await response.json();
    productionBillingStatus.textContent = status;
  } catch (_) {
    productionBillingStatus.textContent = "Could not check the Square connection. Reload Billing and try again.";
  } finally {
    button.disabled = false;
  }
});
