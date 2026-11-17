"use strict";

const reviewToolbar = document.querySelector("[data-report-review-toolbar]");
if (reviewToolbar) {
  const panel = reviewToolbar.querySelector(".event-report-review");
  const description = panel.querySelector(".event-report-review-message");
  const toggle = panel.querySelector(".event-report-review-toggle");

  function updateLayout() {
    const lineHeight = Number.parseFloat(getComputedStyle(description).lineHeight);
    toggle.hidden = description.scrollHeight <= Math.ceil(2 * lineHeight);
    const expanded = panel.hasAttribute("data-description-expanded");
    if (expanded && description.scrollHeight > description.clientHeight) {
      description.tabIndex = 0;
      description.setAttribute("role", "region");
      description.setAttribute("aria-labelledby", "event-report-review-heading");
    } else {
      description.removeAttribute("tabindex");
      description.removeAttribute("role");
      description.removeAttribute("aria-labelledby");
    }
    document.documentElement.style.setProperty(
      "--report-review-scroll-padding", reviewToolbar.offsetHeight + 8 + "px"
    );
  }

  panel.setAttribute("data-description-ready", "");
  toggle.addEventListener("click", () => {
    const expanded = panel.toggleAttribute("data-description-expanded");
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded ? "Show less" : "Show more";
    if (!expanded) description.scrollTop = 0;
    updateLayout();
  });
  const observer = new ResizeObserver(updateLayout);
  observer.observe(reviewToolbar);
  observer.observe(description);
  updateLayout();

  document.getElementById("create").addEventListener("focusin", event => {
    const field = event.target;
    requestAnimationFrame(() => {
      if (document.activeElement !== field) return;
      const toolbarBottom = reviewToolbar.getBoundingClientRect().bottom;
      if (field.getBoundingClientRect().top < toolbarBottom) field.scrollIntoView({ block: "start" });
    });
  });
}
