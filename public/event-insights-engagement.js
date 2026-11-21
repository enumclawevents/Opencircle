"use strict";
(() => {
  const select = document.getElementById("eventInsightsOccurrence");
  const metrics = document.getElementById("eventInsightsEngagement");
  const status = document.getElementById("eventInsightsEngagementStatus");
  if (!select || !metrics || !status || select.disabled) return;
  let sequence = 0;
  let request;
  async function load() {
    const current = ++sequence;
    request?.abort();
    request = new AbortController();
    metrics.setAttribute("aria-busy", "true");
    metrics.querySelectorAll("[data-engagement]").forEach(node => { node.textContent = "—"; });
    status.textContent = "Loading responses…";
    try {
      const query = new URLSearchParams({ event: select.dataset.eventId, occurrenceId: select.value });
      const response = await fetch("/admin/event-occurrence-engagement?" + query, {
        signal: request.signal, headers: { Accept: "application/json" }, cache: "no-store",
      });
      if (!response.ok) throw new Error("Unavailable");
      const data = await response.json();
      if (current !== sequence) return;
      if (data.occurrenceId !== select.value || ![data.goingCount, data.interestedCount].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error("Invalid response");
      metrics.querySelectorAll("[data-engagement]").forEach(node => { node.textContent = data[node.dataset.engagement].toLocaleString("en-US"); });
      status.textContent = data.scheduled ? "Current responses for this occurrence only." : "Historical responses. This date is no longer scheduled.";
    } catch (error) {
      if (current === sequence && error.name !== "AbortError") status.textContent = "Could not load responses. Choose a date to try again.";
    } finally {
      if (current === sequence) metrics.setAttribute("aria-busy", "false");
    }
  }
  select.addEventListener("change", load);
  load();
})();
