"use strict";

(async () => {
  const container = document.getElementById("productionSquareCard");
  const status = document.getElementById("productionCardStatus");
  try {
    const payments = window.Square.payments(container.dataset.applicationId, container.dataset.locationId);
    const card = await payments.card();
    await card.attach("#productionSquareCard");
    status.textContent = "Square card form loaded. Leave the fields blank during preview.";
  } catch (_) {
    status.textContent = "Could not load the live Square card form. Check the production Application ID and Location ID and reload.";
  }
})();
