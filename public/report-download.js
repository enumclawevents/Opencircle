"use strict";

(() => {
  const share = document.querySelector("[data-report-share]");
  if (!share) return;
  const main = share.closest("main");
  const dashboard = document.getElementById("dashboardCommand");
  const analytics = document.getElementById("analyticsPeriodForm");
  const reportArea = dashboard || main;
  const error = share.querySelector("[role=status]");
  const options = [...share.querySelectorAll("[data-report-format]")];

  const text = (node) => (node?.innerText || "").replace(/\s+/g, " ").trim();
  const visible = (node) => !!node?.getClientRects().length && getComputedStyle(node).visibility !== "hidden";
  const number = (value) => /^-?(?:0|[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d+)?$/.test(value)
    ? Number(value.replaceAll(",", "")) : value;
  const selected = (select) => text(select?.selectedOptions[0]) || select?.selectedOptions[0]?.textContent.trim() || "";

  function collectReport() {
    const activeDashboard = dashboard?.reportSummary;
    if (dashboard && (!activeDashboard || dashboard.reportLoading)) throw new Error("Wait for the dashboard to finish loading, then try again.");
    const title = dashboard ? "Dashboard report" : analytics.dataset.reportTitle;
    const range = document.getElementById(dashboard ? "dashboardRange" : "analyticsPeriodRange");
    const grouping = document.getElementById(dashboard ? "dashboardChartGroup" : "analyticsChartGroup");
    const scope = document.getElementById(dashboard ? "dashboardCommunityScope" : "newsletterScopeSelect");
    const context = [
      "Reporting period: " + selected(range),
      dashboard ? text(document.getElementById("dashboardContext")) : analytics.dataset.reportScope,
    ];
    const start = dashboard ? activeDashboard.period.start : analytics.dataset.reportStart;
    const end = dashboard ? activeDashboard.period.end : analytics.dataset.reportEnd;
    if (start && end) {
      const pacificDate = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", dateStyle: "medium" });
      context.push(pacificDate.format(new Date(start)) + " – " + pacificDate.format(new Date(Date.parse(end) - 1)) + " (Pacific time)");
    }
    if (scope) context.push("Community or audience: " + selected(scope));
    if (grouping) context.push("Chart by: " + selected(grouping));
    for (const id of ["venueAnalyticsSelect", "adAnalyticsSelect", "analyticsOrganizer"]) {
      const selector = document.getElementById(id);
      if (selector) context.push("Selected: " + selected(selector));
    }

    const sections = [];
    const add = (heading, rows, chart = false) => {
      if (rows.length > 1) sections.push({ title: heading, rows, chart });
    };
    const headingFor = (node) => {
      const card = node.closest(".card");
      return text(card?.querySelector(".sectionTitle h2, .sectionTitle .chartTitle")) || "Report details";
    };
    const metrics = [...reportArea.querySelectorAll(".metric, .kpi")].filter(visible);
    add("Key metrics", [["Metric", "Value", "Detail"], ...metrics.flatMap((metric) => {
      const name = text(metric.querySelector(".k, .label")).replace(/\s+i$/, "");
      const value = text(metric.querySelector(".v, .value"));
      return name && value ? [[name, number(value), text(metric.querySelector(".dashboard-kpi-detail, .tag"))]] : [];
    })]);

    for (const table of reportArea.querySelectorAll("table")) {
      if (!visible(table)) continue;
      const rows = [...table.rows].filter(visible).map((row) =>
        [...row.cells].map((cell) => cell.tagName === "TH" ? text(cell).replace(/\s+i$/, "") : number(text(cell))));
      add(headingFor(table), rows);
    }

    const groups = new Map();
    for (const row of reportArea.querySelectorAll(".kv, .insight-row, .dashboard-highlight, .dashboard-community-row, .dashboard-attention-item, .newsletter-audience-analytics-row, .stats .stat")) {
      if (!visible(row) || row.closest("table") || row.closest(".dashboard-chart-tooltip")) continue;
      const card = row.closest(".card") || row.parentElement;
      if (!groups.has(card)) groups.set(card, { heading: headingFor(row), rows: [] });
      const label = row.querySelector(".k, .label, .dashboard-attention-copy, .newsletter-audience-analytics-identity, strong");
      const value = row.querySelector(".v, .value, .dashboard-attention-count, .dashboard-community-metrics, .newsletter-audience-analytics-stats")
        || (row.matches(".dashboard-highlight") ? row.querySelector("strong + span") : null);
      if (label && value) groups.get(card).rows.push([text(label), number(text(value))]);
    }
    for (const { heading, rows } of groups.values()) add(heading, [["Item", "Value"], ...rows]);

    function chart(id, heading, primary, secondary, names) {
      const host = document.getElementById(id);
      if (!host || !visible(host.parentElement)) return;
      const data = JSON.parse(host.dataset.chart || "{}");
      const a = data[primary], b = data[secondary];
      const labels = data.tooltips || data.dates || a?.labels || b?.labels || [];
      const values = (series) => Array.isArray(series) ? series : (series?.values || []);
      const showPrimary = id !== "eventsChartData" || !!document.querySelector('#eventsChartLegend [data-legend-metric="events"]');
      add(heading, [
        ["Period", ...(showPrimary ? [names[0]] : []), names[1]],
        ...labels.map((label, index) => [label, ...(showPrimary ? [values(a)[index] ?? ""] : []), values(b)[index] ?? ""]),
      ], true);
    }

    chart("eventsChartData", "Event activity", "events", "views", ["Events", "Views"]);
    chart("organizerChartData", "Organizer performance", "events", "views", ["Events", "Views"]);
    chart("newsletterChartData", "Newsletter performance", "events", "views", ["Emails sent", "Opens"]);
    chart("venueChartData", "Venue performance", "views", "clicks", ["Views", "Clicks"]);
    chart("adChartData", "Ad performance", "views", "clicks", ["Views", "Clicks"]);

    if (activeDashboard) {
      const mode = dashboard.querySelector('[data-dashboard-series][aria-pressed="true"]')?.dataset.dashboardSeries;
      const showEvents = mode !== "views";
      const showViews = mode !== "events" && activeDashboard.availability.eventViewSeries;
      if (showEvents || showViews) add("Activity over time", [
        ["Period", ...(showEvents ? ["Events"] : []), ...(showViews ? ["Views"] : [])],
        ...activeDashboard.series.map((point) => [
          point.tooltip || point.date,
          ...(showEvents ? [point.eventOccurrences] : []),
          ...(showViews ? [point.eventViews] : []),
        ]),
      ], true);
      if (activeDashboard.availability.weekdayViews) add("Views by day of week", [
        ["Day", "Views"],
        ...["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"].map((day, i) => [day, activeDashboard.insights.weekdayViews[i]]),
      ]);
      add("Event categories", [["Category", "Occurrences"], ...activeDashboard.insights.categoryDistribution.map((row) => [row.name, row.count])]);
    }

    return { title, context: context.filter(Boolean), sections };
  }

  share.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && share.open) {
      share.open = false;
      share.querySelector("summary").focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!share.contains(event.target)) share.open = false;
  });

  for (const option of options) option.addEventListener("click", async () => {
    error.textContent = "";
    options.forEach((button) => { button.disabled = true; });
    try {
      const report = collectReport();
      if (!report.sections.length) throw new Error("There is no report data to download.");
      const response = await fetch("/admin/report-download", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: option.dataset.reportFormat, report }),
      });
      if (!response.ok) throw new Error("Could not download the report. Please try again.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1] || "opencircle-report." + option.dataset.reportFormat;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      share.open = false;
      share.querySelector("summary").focus();
    } catch (err) {
      error.textContent = err.message;
    } finally {
      options.forEach((button) => { button.disabled = false; });
    }
  });
})();
