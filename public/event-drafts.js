"use strict";

document.querySelectorAll("[data-event-draft-list]").forEach(list => {
  const count = list.querySelector("[data-draft-count]");
  const success = list.querySelector("[data-draft-success]");
  const error = list.querySelector("[data-draft-error]");
  const empty = list.querySelector("[data-draft-empty]");
  let deleting = false;

  list.addEventListener("submit", async event => {
    if (event.defaultPrevented) return;
    const form = event.target;
    const row = form.closest("[data-draft-row]");
    if (!row) return;
    event.preventDefault();
    if (deleting) return;
    deleting = true;
    const button = form.querySelector("button");
    const restoreFocus = form.contains(document.activeElement);
    button.disabled = true;
    success.hidden = error.hidden = true;
    try {
      const response = await fetch(form.action, {
        method: "POST",
        headers: { Accept: "application/json" },
      });
      const result = await response.json().catch(() => null);
      if (!response.ok || result?.ok !== true) {
        throw new Error(result?.error || "Could not delete the draft. Try again.");
      }
      const next = row.nextElementSibling || row.previousElementSibling;
      row.remove();
      const remaining = list.querySelectorAll("[data-draft-row]").length;
      count.textContent = String(remaining);
      empty.hidden = remaining > 0;
      success.hidden = false;
      success.textContent = "Draft deleted.";
      if (restoreFocus) (next?.querySelector("a") || list.querySelector("summary")).focus();
    } catch (failure) {
      error.hidden = false;
      error.textContent = failure instanceof TypeError
        ? "Could not delete the draft. Check your connection and try again."
        : failure.message;
      button.disabled = false;
      if (restoreFocus) button.focus();
    } finally {
      deleting = false;
    }
  });
});
