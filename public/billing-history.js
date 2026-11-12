"use strict";

(() => {
  const rows = document.getElementById("billingHistoryRows");
  const status = document.getElementById("billingHistoryStatus");
  const more = document.getElementById("billingHistoryMore");
  const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
  const entries = [];
  let cursor;
  let timezone = "America/Los_Angeles";

  function showMessage(message) {
    const cell = rows.insertRow().insertCell();
    cell.colSpan = 6;
    cell.className = "premium-billing__empty";
    cell.textContent = message;
  }

  function render() {
    rows.replaceChildren();
    if (!entries.length) {
      showMessage("No billing history yet. Your subscription payments and receipts will appear here.");
      return;
    }
    entries.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
    for (const entry of entries) {
      const row = rows.insertRow();
      const date = new Date(entry.date || "");
      const dateLabel = Number.isNaN(date.valueOf()) ? "—" : date.toLocaleDateString("en-US", {
        month: "short", day: "numeric", year: "numeric",
        timeZone: /^\d{4}-\d{2}-\d{2}$/.test(entry.date) ? "UTC" : timezone,
      });
      for (const value of [entry.id, dateLabel, entry.description, entry.amount === null ? "—" : usd.format(entry.amount / 100)]) {
        row.insertCell().textContent = value;
      }
      const paymentStatus = row.insertCell();
      if (entry.status) {
        const badge = document.createElement("span");
        badge.className = "pill premium-billing__badge";
        badge.dataset.tone = { Paid: "positive", Pending: "pending", Failed: "ended" }[entry.status] || "neutral";
        badge.textContent = entry.status;
        paymentStatus.append(badge);
      } else {
        paymentStatus.textContent = "—";
      }
      const receipt = row.insertCell();
      if (entry.receipt) {
        const link = document.createElement("a");
        link.href = entry.receipt;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = "View Receipt";
        receipt.append(link);
      } else {
        receipt.textContent = "—";
      }
    }
  }

  async function load() {
    more.disabled = true;
    status.textContent = "Loading billing history…";
    try {
      const params = new URLSearchParams();
      if (cursor) params.set("cursor", cursor);
      if (rows.dataset.organization) params.set("organization", rows.dataset.organization);
      const endpoint = rows.dataset.endpoint || "/admin/billing/history";
      const response = await fetch(endpoint + (params.size ? "?" + params : ""), { cache: "no-store" });
      if (!response.ok) {
        if (response.status === 409) {
          cursor = undefined;
          entries.length = 0;
        }
        throw new Error("History unavailable");
      }
      const result = await response.json();
      timezone = result.timezone || timezone;
      entries.push(...result.entries);
      cursor = result.nextCursor;
      render();
      status.textContent = "";
      more.textContent = "Load More";
      more.hidden = !cursor;
    } catch (_) {
      if (!entries.length) {
        rows.replaceChildren();
        showMessage("Billing history could not be loaded.");
      }
      status.textContent = entries.length ? "More billing history could not be loaded." : "Try again to retrieve your payments.";
      more.textContent = "Retry";
      more.hidden = false;
    } finally {
      more.disabled = false;
    }
  }

  more.addEventListener("click", load);
  load();
})();
