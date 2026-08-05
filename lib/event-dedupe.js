"use strict";

function normalizeHttpUrl(input) {
  const raw = String(input || "").trim();
  if (!raw) return "";
  if (/^(none|null|undefined)$/i.test(raw)) return "";

  let out = raw;
  if (out.startsWith("//")) out = "https:" + out;
  else if (!/^https?:\/\//i.test(out) && /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[\/:?#].*)?$/i.test(out)) out = "https://" + out;
  out = out.replace(/^http:\/\//i, "https://");

  try {
    const u = new URL(out);
    if (!/^https?:$/i.test(u.protocol)) return "";
    u.hash = "";
    const dropKeys = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"];
    dropKeys.forEach((key) => u.searchParams.delete(key));
    let text = u.toString();
    text = text.replace(/\/$/, "");
    text = text.replace(/^https?:\/\/(www\.)?/i, "");
    return text.toLowerCase();
  } catch (_) {
    return "";
  }
}

function normalizeText(value) {
  let out = String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

  const replacements = [
    [/\bw\/\b/g, " with "],
    [/\b&\b/g, " and "],
    [/\bnite\b/g, " night "],
    [/\bmt\b/g, " mount "],
    [/\bst\b/g, " street "],
    [/\bave\b/g, " avenue "],
    [/\brd\b/g, " road "],
    [/\bdr\b/g, " drive "],
    [/\bctr\b/g, " center "],
    [/\bco\.\b/g, " company "],
    [/\bint'l\b/g, " international "],
  ];
  for (const [pattern, replacement] of replacements) {
    out = out.replace(pattern, replacement);
  }

  return out
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function bigrams(text) {
  const src = ` ${String(text || "")} `;
  const out = [];
  for (let i = 0; i < src.length - 1; i++) out.push(src.slice(i, i + 2));
  return out;
}

function diceCoefficient(a, b) {
  const aa = bigrams(a);
  const bb = bigrams(b);
  if (!aa.length || !bb.length) return 0;
  const counts = new Map();
  for (const item of aa) counts.set(item, (counts.get(item) || 0) + 1);
  let matches = 0;
  for (const item of bb) {
    const n = counts.get(item) || 0;
    if (n > 0) {
      matches++;
      counts.set(item, n - 1);
    }
  }
  return (2 * matches) / (aa.length + bb.length);
}

function tokenJaccard(a, b) {
  const aa = new Set(String(a || "").split(" ").filter(Boolean));
  const bb = new Set(String(b || "").split(" ").filter(Boolean));
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  for (const token of aa) {
    if (bb.has(token)) intersection++;
  }
  const union = aa.size + bb.size - intersection;
  return union ? intersection / union : 0;
}

function textSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  return Math.max(diceCoefficient(a, b), tokenJaccard(a, b));
}

function parseTs(value) {
  const ts = Date.parse(String(value || ""));
  return Number.isFinite(ts) ? ts : null;
}

function sameCalendarDay(aTs, bTs) {
  if (!Number.isFinite(aTs) || !Number.isFinite(bTs)) return false;
  const a = new Date(aTs);
  const b = new Date(bTs);
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate()
  );
}

function buildReason(label, value) {
  return value ? `${label}: ${value}` : label;
}

function scoreCandidate(submitted, candidate) {
  const submittedTitle = normalizeText(submitted.title);
  const candidateTitle = normalizeText(candidate.title);
  const submittedLocation = normalizeText(submitted.location);
  const candidateLocation = normalizeText(candidate.location);
  const submittedOrganizer = normalizeText(submitted.organizer);
  const candidateOrganizer = normalizeText(candidate.organizer);
  const submittedUrl = normalizeHttpUrl(submitted.ticketUrl || submitted.eventLink || submitted.sourceUrl);
  const candidateUrl = normalizeHttpUrl(candidate.ticketUrl || candidate.eventLink || candidate.sourceUrl);
  const submittedStartTs = parseTs(submitted.startDateTime);
  const candidateStartTs = parseTs(candidate.startDateTime);

  const titleSimilarity = textSimilarity(submittedTitle, candidateTitle);
  const locationSimilarity = textSimilarity(submittedLocation, candidateLocation);
  const organizerSimilarity = textSimilarity(submittedOrganizer, candidateOrganizer);
  const sameDay = sameCalendarDay(submittedStartTs, candidateStartTs);
  const hourDiff = Number.isFinite(submittedStartTs) && Number.isFinite(candidateStartTs)
    ? Math.abs(submittedStartTs - candidateStartTs) / (60 * 60 * 1000)
    : null;

  let score = 0;
  const reasons = [];

  if (submittedUrl && candidateUrl && submittedUrl === candidateUrl) {
    score += 65;
    reasons.push(buildReason("Same ticket/source URL", candidateUrl));
  }

  if (submittedTitle && candidateTitle) {
    if (submittedTitle === candidateTitle) {
      score += 42;
      reasons.push("Exact normalized title match");
    } else if (titleSimilarity >= 0.93) {
      score += 34;
      reasons.push(`Very similar title (${Math.round(titleSimilarity * 100)}%)`);
    } else if (titleSimilarity >= 0.84) {
      score += 24;
      reasons.push(`Similar title (${Math.round(titleSimilarity * 100)}%)`);
    } else if (titleSimilarity >= 0.72) {
      score += 14;
      reasons.push(`Somewhat similar title (${Math.round(titleSimilarity * 100)}%)`);
    }
  }

  if (submittedLocation && candidateLocation) {
    if (submittedLocation === candidateLocation) {
      score += 18;
      reasons.push("Same normalized location");
    } else if (locationSimilarity >= 0.9) {
      score += 12;
      reasons.push(`Very similar location (${Math.round(locationSimilarity * 100)}%)`);
    } else if (locationSimilarity >= 0.78) {
      score += 7;
      reasons.push(`Similar location (${Math.round(locationSimilarity * 100)}%)`);
    }
  }

  if (submittedOrganizer && candidateOrganizer) {
    if (submittedOrganizer === candidateOrganizer) {
      score += 10;
      reasons.push("Same organizer");
    } else if (organizerSimilarity >= 0.9) {
      score += 6;
      reasons.push(`Very similar organizer (${Math.round(organizerSimilarity * 100)}%)`);
    }
  }

  if (sameDay) {
    score += 14;
    reasons.push("Same calendar day");
  }

  if (hourDiff != null) {
    if (hourDiff <= 2) {
      score += 18;
      reasons.push("Start time within 2 hours");
    } else if (hourDiff <= 6) {
      score += 14;
      reasons.push("Start time within 6 hours");
    } else if (hourDiff <= 12) {
      score += 10;
      reasons.push("Start time within 12 hours");
    } else if (hourDiff <= 24) {
      score += 4;
      reasons.push("Start time within 24 hours");
    }
  }

  if (submittedTitle && candidateTitle && submittedTitle === candidateTitle && sameDay) {
    score += 14;
  }
  if (titleSimilarity >= 0.84 && sameDay && submittedLocation && candidateLocation && submittedLocation === candidateLocation) {
    score += 10;
  }

  const isLikelyDuplicate =
    (submittedUrl && candidateUrl && submittedUrl === candidateUrl) ||
    score >= 62 ||
    (score >= 52 && titleSimilarity >= 0.84 && (sameDay || (hourDiff != null && hourDiff <= 12)));

  return {
    ...candidate,
    titleSimilarity,
    locationSimilarity,
    organizerSimilarity,
    score,
    reasons,
    sameDay,
    hourDiff,
    isLikelyDuplicate,
  };
}

function findLikelyEventDuplicates(submitted, candidates) {
  const rows = [];
  for (const candidate of candidates || []) {
    const scored = scoreCandidate(submitted, candidate);
    if (!scored.isLikelyDuplicate) continue;
    rows.push(scored);
  }
  return rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(b.startDateTime || "").localeCompare(String(a.startDateTime || ""));
  });
}

module.exports = {
  normalizeEventTextForDuplicate: normalizeText,
  normalizeEventUrlForDuplicate: normalizeHttpUrl,
  findLikelyEventDuplicates,
};
