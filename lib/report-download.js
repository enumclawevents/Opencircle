"use strict";

const FORMATS = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv; charset=utf-8",
};

function parseReport(input) {
  const title = typeof input?.title === "string" ? input.title.trim().slice(0, 160) : "";
  if (!title || !Array.isArray(input.sections) || !input.sections.length || input.sections.length > 150) return null;
  let cellCount = 0;
  const sections = [];
  for (const section of input.sections) {
    if (typeof section?.title !== "string" || !Array.isArray(section.rows)) return null;
    const rows = [];
    for (const row of section.rows) {
      if (!Array.isArray(row) || !row.length || row.length > 16) return null;
      cellCount += row.length;
      if (cellCount > 30000) return null;
      rows.push(row.map((cell) => Number.isFinite(cell) ? cell
        : typeof cell === "string" ? cell.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").slice(0, 600) : ""));
    }
    sections.push({ title: section.title.trim().slice(0, 160), chart: section.chart === true, rows });
  }
  const context = Array.isArray(input.context) ? input.context.filter((item) => typeof item === "string").slice(0, 10).map((item) => item.slice(0, 200)) : [];
  return { title, context, sections };
}

function csvCell(value) {
  let text = String(value);
  if (typeof value === "string" && /^(?:[\t\r\n]|[\s\uFEFF]*[=+\-@])/u.test(text)) text = "'" + text;
  return '"' + text.replace(/"/g, '""') + '"';
}

function buildCsv(report) {
  const rows = [[report.title], ...report.context.map((line) => [line])];
  for (const section of report.sections) rows.push([], [section.title], ...section.rows);
  return Buffer.from("\uFEFF" + rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n");
}

async function buildWorkbook(report) {
  const { Workbook } = require("exceljs");
  const workbook = new Workbook();
  workbook.creator = "OpenCircle";
  const sheet = workbook.addWorksheet("Report", { views: [{ state: "frozen", ySplit: 1 }] });
  sheet.addRow([report.title]).font = { size: 16, bold: true };
  for (const context of report.context) sheet.addRow([context]);
  for (const section of report.sections) {
    sheet.addRow([]);
    sheet.addRow([section.title]).font = { bold: true, color: { argb: "FF087D69" } };
    section.rows.forEach((values, index) => {
      const row = sheet.addRow(values);
      row.alignment = { vertical: "top", wrapText: true };
      if (index === 0) row.font = { bold: true };
    });
  }
  sheet.columns.forEach((column, index) => { column.width = index === 0 ? 46 : 23; });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function buildPdf(report) {
  const PDFDocument = require("pdfkit");
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "LETTER", margin: 48, bufferPages: true, info: { Title: report.title, Author: "OpenCircle" } });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("error", reject);
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    const width = doc.page.width - 96;
    const pageBottom = () => doc.page.height - 48;
    const need = (height) => { if (doc.y + height > pageBottom()) doc.addPage(); };
    doc.font("Helvetica-Bold").fontSize(22).fillColor("#142238").text(report.title);
    doc.font("Helvetica").fontSize(10).fillColor("#526178");
    for (const line of report.context) doc.text(line);
    doc.moveDown();

    for (const section of report.sections) {
      need(section.chart ? 215 : 56);
      doc.font("Helvetica-Bold").fontSize(13).fillColor("#087D69").text(section.title);
      doc.moveDown(0.35);
      if (section.chart && section.rows.length > 1) {
        const [header, ...points] = section.rows;
        const colors = ["#087D69", "#2F64C5"];
        const chartTop = doc.y + 20;
        const chartHeight = 92;
        const left = 48;
        const x = (index) => left + width * (points.length === 1 ? 0.5 : index / (points.length - 1));
        for (let line = 0; line <= 4; line++) {
          const y = chartTop + line * chartHeight / 4;
          doc.moveTo(left, y).lineTo(left + width, y).strokeColor("#dce5ee").lineWidth(0.5).stroke();
        }
        header.slice(1, 3).forEach((label, series) => {
          const values = points.map((row) => Number.isFinite(row[series + 1]) ? row[series + 1] : null);
          if (!values.some((value) => value !== null)) return;
          const max = Math.max(1, ...values);
          const color = colors[series];
          doc.font("Helvetica-Bold").fontSize(8).fillColor(color).text(
            `${label} (0–${max})`, left + series * width / 2, chartTop - 15, { width: width / 2, ellipsis: true }
          );
          let started = false;
          values.forEach((value, index) => {
            if (value === null) { started = false; return; }
            const y = chartTop + chartHeight * (1 - value / max);
            if (points.length === 1) doc.circle(x(index), y, 2).fill(color);
            else if (started) doc.lineTo(x(index), y);
            else doc.moveTo(x(index), y);
            started = true;
          });
          if (points.length > 1) doc.strokeColor(color).lineWidth(1.6).stroke();
        });
        doc.x = 48;
        doc.y = chartTop + chartHeight + 10;
      }
      const columns = Math.max(1, ...section.rows.map((row) => row.length));
      const columnWidths = columns === 1 ? [width]
        : columns === 2 ? [width * 0.57, width * 0.43]
        : Array.from({ length: columns }, () => width / columns);
      section.rows.forEach((row, index) => {
        const font = index === 0 ? "Helvetica-Bold" : "Helvetica";
        const options = (column) => ({ width: columnWidths[column] - 12, lineGap: 2 });
        doc.font(font).fontSize(9);
        const height = Math.max(13, ...row.map((cell, column) => doc.heightOfString(String(cell), options(column)))) + 10;
        need(Math.min(height, 150));
        const y = doc.y;
        if (index === 0) doc.rect(48, y, width, height).fill("#edf4f6");
        let x = 48;
        row.forEach((cell, column) => {
          doc.fillColor("#142238").text(String(cell), x + 6, y + 5, { ...options(column), height: Math.min(height - 8, pageBottom() - y - 5), ellipsis: true });
          x += columnWidths[column];
        });
        doc.y = Math.min(y + height, pageBottom());
        doc.moveTo(48, doc.y).lineTo(48 + width, doc.y).strokeColor("#dce5ee").stroke();
      });
      doc.moveDown(0.9);
      doc.x = 48;
    }
    const pages = doc.bufferedPageRange();
    for (let i = 0; i < pages.count; i++) {
      doc.switchToPage(pages.start + i);
      const bottom = doc.page.margins.bottom;
      doc.page.margins.bottom = 20;
      doc.font("Helvetica").fontSize(8).fillColor("#526178")
        .text(`OpenCircle   |   ${i + 1} / ${pages.count}`, 48, doc.page.height - 36, { width, align: "right", lineBreak: false });
      doc.page.margins.bottom = bottom;
    }
    doc.end();
  });
}

async function buildReportDownload(format, input) {
  if (!Object.hasOwn(FORMATS, format)) return null;
  const report = parseReport(input);
  if (!report) return null;
  const content = format === "csv" ? buildCsv(report)
    : format === "xlsx" ? await buildWorkbook(report) : await buildPdf(report);
  const slug = report.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 100);
  return { content, contentType: FORMATS[format], filename: `${slug || "opencircle-report"}.${format}` };
}

module.exports = { buildReportDownload };
