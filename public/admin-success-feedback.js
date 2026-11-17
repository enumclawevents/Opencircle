"use strict";

// Animate notices on an initial navigation. Reload and history visits can
// display the same confirmed notice without replaying its entrance.
const dashboardNavigation = performance.getEntriesByType("navigation")[0];
if (dashboardNavigation?.type === "navigate") {
  document.querySelectorAll(
    '#admin-content .admin-notice--success[role="status"]:not([hidden], [data-success-immediate])'
  ).forEach(notice => notice.setAttribute("data-success-enter", ""));
}
