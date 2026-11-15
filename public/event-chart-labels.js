(() => {
  const host = document.querySelector("#eventsChartSvgHost[data-event-days]");
  const svg = host?.querySelector("svg");
  if (!svg) return;

  const labels = [...svg.querySelectorAll("[data-event-day-label]")];
  if (!labels.length) return;

  const groupLabel = labels[0].cloneNode();
  groupLabel.removeAttribute("data-event-day-label");
  const groupedText = host.dataset.eventDays + " event days";
  svg.appendChild(groupLabel);

  function layout() {
    const bounds = svg.getBoundingClientRect();
    const viewBox = svg.viewBox.baseVal;
    if (!bounds.width || !bounds.height) return;
    const scaleX = bounds.width / viewBox.width;
    const scaleY = bounds.height / viewBox.height;
    const markerTop = Number(labels[0].dataset.markerTop);
    const textBounds = labels[0].getBBox();
    const rowHeight = textBounds.height + 4;
    const plotTop = markerTop * scaleY;
    const labelGap = 4;
    const nextStarts = [Infinity, Infinity];
    // Edge clamping keeps the text in bounds. Work right to left so
    // consecutive marker labels can occupy alternating rows.
    const positions = labels.map((label) => ({
      label,
      marker: Number(label.dataset.eventDayLabel) * scaleX,
      width: label.getComputedTextLength(),
    })).sort((a, b) => b.marker - a.marker).map(({ label, marker, width }) => {
      const left = Math.max(labelGap, Math.min(marker - width / 2, bounds.width - width - labelGap));
      const row = width + 2 * labelGap <= bounds.width
        ? nextStarts.findIndex((start) => left + width + labelGap <= start)
        : -1;
      if (row !== -1) nextStarts[row] = left;
      return { label, left, row };
    });
    const grouped = positions.some(({ row }) => row === -1);
    const rows = grouped ? 1 : Math.max(...positions.map(({ row }) => row)) + 1;
    const baseline = plotTop - labelGap;
    host.style.paddingTop = Math.max(0, -textBounds.y + labelGap - baseline + (rows - 1) * rowHeight) + "px";

    function place(label, left, row) {
      const x = left / scaleX;
      const y = (baseline - row * rowHeight) / scaleY;
      // Keep annotations readable while preserving the SVG plot geometry.
      label.setAttribute("transform", "translate(" + x + " " + y + ") scale(" + 1 / scaleX + " " + 1 / scaleY + ")");
      label.removeAttribute("visibility");
    }

    for (const { label, left, row } of positions) {
      if (grouped) label.setAttribute("visibility", "hidden");
      else place(label, left, row);
    }
    groupLabel.setAttribute("visibility", "hidden");
    if (grouped) {
      groupLabel.textContent = groupedText;
      if (groupLabel.getComputedTextLength() + 2 * labelGap > bounds.width) groupLabel.textContent = "Event days";
      const width = groupLabel.getComputedTextLength();
      if (width <= bounds.width) place(groupLabel, (bounds.width - width) / 2, 0);
    }
  }

  layout();
  if (typeof ResizeObserver === "function") new ResizeObserver(layout).observe(svg);
  else window.addEventListener("resize", layout);
  document.fonts?.ready.then(layout);
})();
