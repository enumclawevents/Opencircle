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
    return u.toString();
  } catch (_) {
    return "";
  }
}

function stripHtml(str) {
  return String(str || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function truncatePlainText(str, max) {
  const text = stripHtml(str);
  const limit = Math.max(0, Number(max || 0));
  if (!limit || text.length <= limit) return text;
  return text.slice(0, Math.max(0, limit - 1)).trimEnd() + "...";
}

function firstNonEmpty(...values) {
  for (const value of values) {
    const str = String(value || "").trim();
    if (str) return str;
  }
  return "";
}

function isoOrNull(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? new Date(ts).toISOString() : null;
}

function getRequestBaseUrl(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "https";
  const host = req.headers["x-forwarded-host"] || req.get("host");
  return `${proto}://${host}`;
}

function getPublicSiteBaseUrl(req) {
  const envBase = firstNonEmpty(
    process.env.PUBLIC_SITE_URL,
    process.env.EVENTS_SITE_URL,
    process.env.PUBLIC_BASE_URL
  );
  if (envBase) return envBase.replace(/\/$/, "");
  return getRequestBaseUrl(req).replace(/\/$/, "");
}

function buildPublicUrl(req, pathname) {
  const base = getPublicSiteBaseUrl(req);
  const path = String(pathname || "").startsWith("/") ? String(pathname || "") : `/${String(pathname || "")}`;
  return `${base}${path}`;
}

function buildSeoDescriptor({
  req,
  pathname,
  seoTitle,
  fallbackTitle,
  metaDescription,
  fallbackDescription,
  imageAlt,
  fallbackImageAlt,
  updatedAt,
  createdAt,
  excerptMax = 220,
  indexable = true,
  robots = null,
}) {
  const publicUrl = buildPublicUrl(req, pathname);
  const excerptPlainText = truncatePlainText(
    firstNonEmpty(metaDescription, fallbackDescription),
    excerptMax
  );
  return {
    publicUrl,
    canonicalUrl: publicUrl,
    indexable: Boolean(indexable),
    robots: firstNonEmpty(robots, indexable ? "index,follow" : "noindex,nofollow"),
    seoTitle: firstNonEmpty(seoTitle, fallbackTitle),
    metaDescription: firstNonEmpty(metaDescription, fallbackDescription),
    imageAlt: firstNonEmpty(imageAlt, fallbackImageAlt),
    excerptPlainText,
    lastModified: firstNonEmpty(isoOrNull(updatedAt), isoOrNull(createdAt)) || null,
  };
}

function deriveEventSeoFields(input = {}) {
  const title = firstNonEmpty(input.title);
  const location = firstNonEmpty(input.location);
  const organizer = firstNonEmpty(input.organizer);
  const description = truncatePlainText(input.description || "", 160);
  const seoTitleBase = [title, location].filter(Boolean).join(" | ");
  const seoTitle = truncatePlainText(seoTitleBase || title, 60);
  const metaDescription = description || truncatePlainText(
    [title, location ? `at ${location}` : "", organizer ? `hosted by ${organizer}` : ""]
      .filter(Boolean)
      .join(" "),
    160
  );
  return {
    seoTitle,
    metaDescription,
    imageAlt: truncatePlainText([title, location ? `at ${location}` : ""].filter(Boolean).join(" "), 120),
  };
}

function deriveVenueSeoFields(input = {}) {
  const name = firstNonEmpty(input.name);
  const address = firstNonEmpty(input.address);
  const description = truncatePlainText(input.description || "", 160);
  return {
    seoTitle: truncatePlainText([name, address].filter(Boolean).join(" | ") || name, 60),
    metaDescription: description || truncatePlainText([name, address].filter(Boolean).join(" "), 160),
    imageAlt: truncatePlainText([name, address].filter(Boolean).join(" "), 120),
  };
}

function deriveJobSeoFields(input = {}) {
  const title = firstNonEmpty(input.title);
  const company = firstNonEmpty(input.company);
  const location = firstNonEmpty(input.location);
  const description = truncatePlainText(input.description || "", 160);
  return {
    seoTitle: truncatePlainText([title, company].filter(Boolean).join(" | ") || title, 60),
    metaDescription: description || truncatePlainText([title, company, location].filter(Boolean).join(" "), 160),
    imageAlt: truncatePlainText([title, company].filter(Boolean).join(" "), 120),
  };
}

function buildEventStructuredData(input = {}) {
  const out = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: firstNonEmpty(input.name),
    url: firstNonEmpty(input.url),
    description: stripHtml(input.description || ""),
    startDate: firstNonEmpty(input.startDateTime),
    eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode",
  };

  const endDate = firstNonEmpty(input.endDateTime);
  if (endDate) out.endDate = endDate;

  const imageUrl = normalizeHttpUrl(input.imageUrl || "");
  if (imageUrl) out.image = [imageUrl];

  const locationName = firstNonEmpty(input.locationName);
  if (locationName) {
    out.location = {
      "@type": "Place",
      name: locationName,
      address: locationName,
    };
  }

  const organizerName = firstNonEmpty(input.organizerName);
  if (organizerName) {
    out.organizer = {
      "@type": "Organization",
      name: organizerName,
    };
  }

  if (input.isScheduled) {
    out.eventStatus = "https://schema.org/EventScheduled";
  }

  return out;
}

function buildVenueStructuredData(input = {}) {
  const out = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name: firstNonEmpty(input.name),
    url: firstNonEmpty(input.url),
    description: stripHtml(input.description || ""),
  };

  const imageUrl = normalizeHttpUrl(input.imageUrl || "");
  if (imageUrl) out.image = [imageUrl];

  const phone = firstNonEmpty(input.phone);
  if (phone) out.telephone = phone;

  const address = firstNonEmpty(input.address);
  if (address) out.address = address;

  const website = normalizeHttpUrl(input.website || "");
  if (website) out.sameAs = [website];

  return out;
}

function buildJobStructuredData(input = {}) {
  const out = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: firstNonEmpty(input.title),
    description: stripHtml(input.description || ""),
    url: firstNonEmpty(input.url),
  };

  const datePosted = firstNonEmpty(isoOrNull(input.createdAt), isoOrNull(input.updatedAt));
  if (datePosted) out.datePosted = datePosted;

  const employmentType = firstNonEmpty(input.employmentType);
  if (employmentType) out.employmentType = employmentType;

  const company = firstNonEmpty(input.company);
  if (company) {
    out.hiringOrganization = {
      "@type": "Organization",
      name: company,
    };
  }

  const location = firstNonEmpty(input.location);
  if (location) {
    out.jobLocation = {
      "@type": "Place",
      address: location,
    };
  }

  const applyUrl = normalizeHttpUrl(input.applyUrl || "");
  if (applyUrl) out.directApply = true;

  return out;
}

module.exports = {
  buildEventStructuredData,
  buildJobStructuredData,
  buildPublicUrl,
  buildSeoDescriptor,
  buildVenueStructuredData,
  deriveEventSeoFields,
  deriveJobSeoFields,
  deriveVenueSeoFields,
  getRequestBaseUrl,
  normalizeHttpUrl,
  stripHtml,
  truncatePlainText,
};
