"use strict";

const pageLoadingAssets = require("../lib/page-loading");

const express = require("express");
const { DateTime } = require("luxon");
const { esc } = require("../lib/html");
const { stripHtml, normalizeHttpUrl } = require("../lib/public-seo");
const { EVENT_CATEGORIES, DEFAULT_TZ } = require("../lib/admin-constants");
const content = require("../data/enumclaw-site-content.json");
const events = require("./events");
const venues = require("./venues");
const jobs = require("./jobs");
const updates = require("./updates");
const { JOB_APPLICATION_FIELDS } = require("../lib/job-utils");
const router = express.Router();
const BASE = "/preview/enumclaw";
const CITY = "Enumclaw";
const empty = '<p class="site-empty">Nothing to show here yet. Check back soon.</p>';

function safeUrl(value) {
  const raw = String(value || "");
  if (raw.startsWith("/uploads/") || raw.startsWith("/assets/")) return raw;
  return normalizeHttpUrl(raw);
}

function text(value) {
  return esc(stripHtml(value));
}

function localDate(value, format = "MMMM d, yyyy") {
  const date = DateTime.fromISO(String(value || ""), { zone: "utc" }).setZone(DEFAULT_TZ);
  return date.isValid ? date.toFormat(format) : "";
}

function eventHref(event) {
  const key = event.slug || event.id;
  const occurrence = event.isOccurrence && event.startDateTime
    ? "?" + new URLSearchParams({ date: event.startDateTime }) : "";
  return BASE + "/events/" + encodeURIComponent(key) + occurrence;
}

// Reuse public route handlers in-process. Queries are constructed by this
// router, and the internal requests never inherit an admin identity.
function publicData(publicRouter, path, query, request, method = "GET", body) {
  return new Promise((resolve, reject) => {
    const req = Object.create(request);
    for (const [key, value] of Object.entries({
      url: path, originalUrl: path, baseUrl: "", method, query, body, user: undefined,
      publicEventProjection: true,
    })) Object.defineProperty(req, key, { value, configurable: true, writable: true });
    let statusCode = 200;
    const res = {
      locals: {},
      status(code) { statusCode = code; return this; },
      set() { return this; }, setHeader() {}, type() { return this; },
      json(payload) {
        if (statusCode >= 400) {
          const error = new Error(payload?.error || "Content is temporarily unavailable.");
          error.status = statusCode;
          reject(error);
        } else resolve(payload);
        return this;
      },
      send(payload) { return this.json(payload); },
    };
    publicRouter.handle(req, res, error => reject(error || Object.assign(new Error("Page not found."), { status: 404 })));
  });
}

function eventList(req, query = {}) {
  return publicData(events, "/", { city: CITY, expand: "1", status: "upcoming", limit: "12", ...query }, req);
}

function eventCard(event, badge = "") {
  const image = safeUrl(event.imageUrl);
  return `<article class="event-card">
    <a href="${esc(eventHref(event))}" class="event-card-image">
      ${image ? `<img src="${esc(image)}" alt="${esc(event.imageAlt || event.title)}" loading="lazy">` : '<span class="image-placeholder" aria-hidden="true">EE</span>'}
      <time class="date-stamp" datetime="${esc(event.startDateTime)}"><strong>${esc(localDate(event.startDateTime, "d"))}</strong>${esc(localDate(event.startDateTime, "MMM"))}</time>
      ${badge ? `<span class="event-badge">${esc(badge)}</span>` : ""}
    </a>
    <div class="event-card-body"><h3><a href="${esc(eventHref(event))}">${text(event.title)}</a></h3>
      <p class="event-meta">${esc(event.occurrenceLabel || localDate(event.startDateTime))} · ${esc(localDate(event.startDateTime, "h:mm a"))}</p>
      ${event.venueName || event.location ? `<p class="event-meta">${text(event.venueName || event.location)}</p>` : ""}
    </div>
  </article>`;
}

function eventSection(title, result, href, badge = "") {
  return `<section class="content-section"><div class="section-heading"><h2>${esc(title)}</h2>${href ? `<a href="${esc(href)}">See more <span aria-hidden="true">→</span></a>` : ""}</div>
    <div class="event-grid">${result.data?.length ? result.data.map(event => eventCard(event, badge)).join("") : empty}</div></section>`;
}

function newsletter() {
  return `<section class="newsletter" aria-labelledby="newsletterTitle">
    <div><p class="eyebrow">Your community, delivered</p><h2 id="newsletterTitle">Stay in the loop</h2><p>Get local event highlights and community updates in your inbox.</p></div>
    <form data-newsletter action="/newsletter/subscribe" method="post">
      <input type="hidden" name="city" value="${CITY}">
      <label for="newsletterEmail">Email address</label>
      <div class="input-button"><input id="newsletterEmail" type="email" name="email" autocomplete="email" placeholder="you@example.com" required><button class="button" type="submit">Sign up</button></div>
      <p role="status" class="form-status"></p>
    </form>
  </section>`;
}

function layout(title, body, { description = "Events, places, and local happenings in Enumclaw, Washington.", active = "" } = {}) {
  const nav = [
    ["Events", "/events"], ["Venues", "/venues"], ["About", "/about"],
    ["Promote", "/promote-with-us"], ["Jobs", "/jobs"], ["Updates", "/updates"],
  ];
  return `<!doctype html><html lang="en"><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${esc(title)} | Enumclaw Events</title><meta name="description" content="${esc(description)}">
    <meta name="robots" content="noindex,nofollow">
    ${pageLoadingAssets}
    <link rel="stylesheet" href="/assets/enumclaw-site/site.css?v=3">
    <script src="/assets/enumclaw-site/site.js?v=2" defer></script>
  </head><body><a class="skip-link" href="#content">Skip to content</a>
    <div class="preview-banner">Enumclaw Events preview <span>Powered by the existing OpenCircle API</span><a href="https://enumclawevents.org/" target="_blank" rel="noopener noreferrer">Compare with current site ↗</a></div>
    <header class="site-header"><div class="site-width header-inner">
      <a class="site-brand" href="${BASE}" aria-label="Enumclaw Events home">${content.logo ? `<img src="${esc(content.logo)}" alt="Enumclaw Events">` : "EnumclawEvents.org"}</a>
      <button type="button" class="menu-toggle button button-light" data-menu-toggle aria-controls="siteNavigation" aria-expanded="false" hidden>Menu</button>
      <nav id="siteNavigation" aria-label="Main navigation">${nav.map(([name, href]) => `<a href="${BASE + href}"${active === href ? ' aria-current="page"' : ""}>${name}</a>`).join("")}</nav>
      <a class="button button-dark" href="${BASE}/submit-event">Add your event</a>
    </div></header>
    <main id="content" data-page-loading-content>${body}</main>
    <div class="site-width">${newsletter()}</div>
    <footer class="site-footer"><div class="site-width footer-grid"><div><a class="footer-brand" href="${BASE}">EnumclawEvents<span>.org</span></a><h2>Discover local happenings</h2>
      <p>A locally run events calendar for Enumclaw and the Plateau. Find festivals, markets, music, family activities, and community events.</p></div>
      <nav aria-label="Footer navigation"><a href="${BASE}/events">Upcoming events</a><a href="${BASE}/events?period=past">Past events</a><a href="${BASE}/get-involved">Get involved</a><a href="${BASE}/event-planning">Event planning</a><a href="${BASE}/privacy">Privacy policy</a><a href="${BASE}/terms">Terms and conditions</a></nav>
      <div><h2>Made for our community</h2><p>Free event listings help neighbors discover what’s happening. Paid promotions support the calendar.</p><a href="${BASE}/promote-with-us">Promote with us →</a></div>
    </div><div class="site-width footer-bottom">EnumclawEvents.org · Powered by OpenCircle</div></footer>
  </body></html>`;
}

function pageHeader(title, description, eyebrow = "Discover Enumclaw") {
  return `<div class="page-heading"><p class="eyebrow">${esc(eyebrow)}</p><h1>${esc(title)}</h1>${description ? `<p>${esc(description)}</p>` : ""}</div>`;
}

function pagination(meta, query, path) {
  if (!meta || (!meta.hasMore && !meta.offset)) return "";
  const previous = Math.max(0, meta.offset - meta.limit);
  const href = offset => BASE + path + "?" + new URLSearchParams({ ...query, offset: String(offset) });
  return `<nav class="pagination" aria-label="Pagination">${meta.offset ? `<a class="button button-light" href="${esc(href(previous))}">← Previous</a>` : "<span></span>"}
    <span>Page ${Math.floor(meta.offset / meta.limit) + 1} · ${meta.total} results</span>
    ${meta.hasMore ? `<a class="button button-light" href="${esc(href(meta.nextOffset))}">Next →</a>` : "<span></span>"}</nav>`;
}

router.use((req, res, next) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.set("Cache-Control", "public, max-age=30");
  res.set("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' https:; frame-ancestors 'self'; base-uri 'self'; form-action 'self' https://*.square.site https://square.link; object-src 'none'");
  next();
});

router.get("/", async (req, res, next) => {
  try {
    const now = DateTime.now().setZone(DEFAULT_TZ);
    const [featured, upcoming, trending, recent, posts] = await Promise.all([
      eventList(req, { featured: "1", expand: "0", limit: "6" }),
      eventList(req, { limit: "9" }),
      eventList(req, { sort: "trending", from: now.startOf("day").toUTC().toISO(), to: now.plus({ days: 7 }).endOf("day").toUTC().toISO(), limit: "6" }),
      eventList(req, { sort: "recent", expand: "0", limit: "6" }),
      communityPosts(req),
    ]);
    const slides = featured.data || [];
    const hero = slides.length ? `<section class="hero" aria-label="Featured events">
      <div class="hero-slides">${slides.map((event, index) => `<article class="hero-slide"${index ? " hidden" : ""}>
        ${safeUrl(event.imageUrl) ? `<img class="hero-image" src="${esc(safeUrl(event.imageUrl))}" alt=""${index ? ' loading="lazy"' : ' fetchpriority="high"'}>` : ""}
        <div class="hero-copy"><p class="eyebrow">Featured in Enumclaw</p><h1>${text(event.title)}</h1><p>${esc(event.occurrenceLabel || localDate(event.startDateTime))} · ${esc(localDate(event.startDateTime, "h:mm a"))} · ${text(event.location)}</p><a class="button button-outline" href="${esc(eventHref(event))}">View event</a></div>
      </article>`).join("")}</div>
      ${slides.length > 1 ? `<div class="hero-controls"><button type="button" data-hero-step="-1" aria-label="Previous featured event">←</button><span data-hero-count aria-live="polite">1 / ${slides.length}</span><button type="button" data-hero-step="1" aria-label="Next featured event">→</button></div>` : ""}
    </section>` : `<section class="hero hero-empty">${pageHeader("Discover what’s happening in Enumclaw", "Your local guide to events, places, and community.")}<a class="button" href="${BASE}/events">Explore events</a></section>`;
    const body = `<div class="site-tagline">Enumclaw Events Calendar | Discover What’s Happening Now</div>${hero}<div class="site-width">
      ${eventSection("Featured Events", featured, BASE + "/events?featured=1", "Featured")}
      ${eventSection("Upcoming Events", upcoming, BASE + "/events")}
      ${eventSection("Trending This Week", trending, BASE + "/events?sort=trending&period=week", "Trending")}
      <section class="content-section"><div class="section-heading"><h2>Explore Categories</h2></div><div class="category-grid">${EVENT_CATEGORIES.map(category => `<a href="${BASE}/events?category=${category.slug}">${esc(category.name)} <span aria-hidden="true">↗</span></a>`).join("")}</div></section>
      ${eventSection("Recently Added", recent, BASE + "/events?sort=recent", "New")}
      ${postList("Updates From Us", posts.slice(0, 3))}
    </div>`;
    res.send(layout("Discover what’s happening", body));
  } catch (error) { next(error); }
});

router.get("/events", async (req, res, next) => {
  try {
    const scalar = key => typeof req.query[key] === "string" ? req.query[key] : "";
    const period = scalar("period");
    const filters = {
      q: scalar("q"), category: scalar("category"), venue: scalar("venue"), sort: scalar("sort") || (period === "past" ? "latest" : "soonest"),
      featured: scalar("featured") === "1" ? "1" : "0", offset: scalar("offset") || "0", limit: "18",
      status: period === "past" ? "past" : "upcoming",
    };
    const now = DateTime.now().setZone(DEFAULT_TZ);
    if (["today", "weekend", "week"].includes(period)) {
      const start = period === "weekend" ? now.startOf("day").plus({ days: Math.max(0, 6 - now.weekday) }) : now.startOf("day");
      const end = period === "weekend" ? start.plus({ days: 7 - start.weekday }).endOf("day") : period === "week" ? start.plus({ days: 7 }).endOf("day") : start.endOf("day");
      filters.from = start.toUTC().toISO();
      filters.to = end.toUTC().toISO();
    }
    const result = await eventList(req, filters);
    const query = { q: filters.q, category: filters.category, ...(filters.venue ? { venue: filters.venue } : {}), sort: filters.sort, period, ...(filters.featured === "1" ? { featured: "1" } : {}) };
    const title = period === "past" ? "Past Events in Enumclaw" : "Upcoming Events in Enumclaw";
    res.send(layout(title, `<div class="site-width">${pageHeader(title, "Find festivals, live music, markets, family activities, workshops, and more.")}
      <nav class="quick-filters" aria-label="Event dates">${[["All upcoming", ""], ["Today", "today"], ["This weekend", "weekend"], ["This week", "week"], ["Past events", "past"]].map(([label, value]) => `<a class="filter-chip" href="${esc(BASE + "/events?" + new URLSearchParams({ ...query, period: value }))}"${period === value ? ' aria-current="page"' : ""}>${label}</a>`).join("")}</nav>
      <form class="event-filters" method="get" action="${BASE}/events">
        <input type="hidden" name="period" value="${esc(period)}">
        ${filters.featured === "1" ? '<input type="hidden" name="featured" value="1">' : ""}
        ${filters.venue ? `<input type="hidden" name="venue" value="${esc(filters.venue)}">` : ""}
        <label>Search events<input name="q" value="${esc(filters.q)}" placeholder="Search events…"></label>
        <label>Category<select name="category"><option value="">All categories</option>${EVENT_CATEGORIES.map(category => `<option value="${category.slug}"${filters.category === category.slug ? " selected" : ""}>${esc(category.name)}</option>`).join("")}</select></label>
        <label>Sort by<select name="sort">${[["soonest", "Soonest"], ["latest", "Latest date"], ["recent", "Recently added"], ["trending", "Trending"]].map(([value, label]) => `<option value="${value}"${filters.sort === value ? " selected" : ""}>${label}</option>`).join("")}</select></label>
        <button class="button button-dark" type="submit">Search</button><a href="${BASE}/events">Reset</a>
      </form>
      <p class="results-count">${result.meta.total} events found</p>
      <div class="event-grid listing-grid">${result.data.length ? result.data.map(event => eventCard(event)).join("") : '<p class="site-empty">No events match these filters. Try another date or category.</p>'}</div>
      ${pagination(result.meta, query, "/events")}</div>`, { active: "/events" }));
  } catch (error) { next(error); }
});

async function eventDetail(req) {
  const result = await publicData(events, "/slug/" + encodeURIComponent(req.params.key), { track: "0" }, req)
    .catch(error => {
      if (error.status === 404 && /^\d+$/.test(req.params.key)) return publicData(events, "/" + req.params.key, { track: "0" }, req);
      throw error;
    });
  const event = result.data;
  if (event.city !== CITY || event.lifecycle?.state === "archived") throw Object.assign(new Error("Event not found."), { status: 404 });
  const requestedDate = typeof req.query.date === "string" ? req.query.date : "";
  const occurrence = event.occurrencesUpcoming?.find(item => item.startDateTime === requestedDate);
  return { event, display: occurrence ? { ...event, ...occurrence } : event };
}

function occurrenceQuery(display, event) {
  return display.startDateTime !== event.startDateTime ? "?" + esc(new URLSearchParams({ date: display.startDateTime })) : "";
}

function calendarText(value) {
  return stripHtml(String(value || "")).replace(/\\/g, "\\\\").replace(/\r?\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

// Fold on UTF-8 byte boundaries so long titles and descriptions remain valid ICS.
function calendarLine(line) {
  const chunks = [];
  let current = "";
  for (const character of line) {
    if (Buffer.byteLength(current + character) > 74) { chunks.push(current); current = " "; }
    current += character;
  }
  return [...chunks, current].join("\r\n");
}

router.get("/events/:key/calendar", async (req, res, next) => {
  try {
    const { event, display } = await eventDetail(req);
    const stamp = value => DateTime.fromISO(String(value || ""), { zone: "utc" }).toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'");
    if (!DateTime.fromISO(display.startDateTime).isValid) throw Object.assign(new Error("Event date unavailable."), { status: 400 });
    const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//OpenCircle//Enumclaw Events//EN", "CALSCALE:GREGORIAN", "BEGIN:VEVENT",
      "UID:" + calendarText(event.id + "-" + stamp(display.startDateTime) + "@enumclaw.opencircle"),
      "DTSTAMP:" + stamp(DateTime.utc().toISO()), "DTSTART:" + stamp(display.startDateTime),
      ...(display.endDateTime && DateTime.fromISO(display.endDateTime).isValid ? ["DTEND:" + stamp(display.endDateTime)] : []),
      "SUMMARY:" + calendarText(event.title), "DESCRIPTION:" + calendarText(event.description), "LOCATION:" + calendarText(event.location),
      "END:VEVENT", "END:VCALENDAR"];
    res.set("Content-Disposition", 'attachment; filename="enumclaw-event.ics"');
    res.type("text/calendar").send(lines.map(calendarLine).join("\r\n") + "\r\n");
  } catch (error) { next(error); }
});

router.get("/events/:key", async (req, res, next) => {
  try {
    const { event, display } = await eventDetail(req);
    const ticketUrl = safeUrl(event.ticketTrackedUrl || event.ticketUrl || event.eventLink);
    res.send(layout(event.title, `<div class="site-width detail-page">
      <a class="back-link" href="${BASE}/events">← All events</a>
      <div class="detail-grid"><article><p class="eyebrow">${(event.categories || []).map(esc).join(" · ")}</p><h1>${text(event.title)}</h1>
        ${event.lifecycle?.notice ? `<p class="status-notice">${text(event.lifecycle.notice)}</p>` : ""}
        ${safeUrl(event.imageUrl) ? `<img class="detail-image" src="${esc(safeUrl(event.imageUrl))}" alt="${esc(event.imageAlt || event.title)}">` : ""}
        <div class="prose">${paragraphs(event.description)}</div>
        ${event.eventDetails ? `<h2>Event details</h2><div class="prose">${paragraphs(event.eventDetails)}</div>` : ""}
        ${event.goodToKnow ? `<h2>Good to know</h2><div class="prose">${paragraphs(event.goodToKnow)}</div>` : ""}
        ${event.occurrencesUpcoming?.length > 1 ? `<details class="upcoming-dates"><summary>Upcoming dates</summary><ul>${event.occurrencesUpcoming.slice(0, 16).map(item => `<li><a href="${esc(eventHref({ ...event, ...item, isOccurrence: true }))}">${esc(item.label || localDate(item.startDateTime) + " · " + localDate(item.startDateTime, "h:mm a"))}</a></li>`).join("")}</ul></details>` : ""}
      </article><aside class="detail-aside"><h2>Plan your visit</h2><p>${esc(display.occurrenceLabel || display.label || localDate(display.startDateTime))}</p><p>${esc(localDate(display.startDateTime, "h:mm a"))}${display.endDateTime ? " – " + esc(localDate(display.endDateTime, "h:mm a")) : ""}</p><hr><p><strong>Location</strong><br>${event.venueName ? text(event.venueName) + "<br>" : ""}${text(event.location)}</p>${event.organizer ? `<p><strong>Organizer</strong><br>${text(event.organizer)}</p>` : ""}${ticketUrl ? `<a class="button" href="${esc(ticketUrl)}" target="_blank" rel="noopener noreferrer">${esc(event.ticketLabel || "Event website")}</a>` : ""}<div class="event-actions"><a class="button button-light" href="${BASE}/events/${encodeURIComponent(event.slug || event.id)}/calendar${occurrenceQuery(display, event)}">Add to calendar</a><button class="button button-light" type="button" data-share-event>Share event</button></div><p class="form-status" data-share-status role="status"></p>${event.location ? `<a class="text-link" href="https://www.google.com/maps/search/?${esc(new URLSearchParams({ api: "1", query: stripHtml(event.location) }))}" target="_blank" rel="noopener noreferrer">Get directions ↗</a>` : ""}<a class="button button-light" href="${BASE}/events">Explore more events</a></aside></div>
    </div>`, { active: "/events", description: stripHtml(event.description).slice(0, 160) }));
  } catch (error) { next(error); }
});

function paragraphs(value) {
  return String(value || "").replace(/<\/(?:p|h[1-6]|li)>/gi, "\n\n").split(/\n\s*\n/).map(paragraph => `<p>${esc(stripHtml(paragraph))}</p>`).join("");
}

function postList(title, posts) {
  return `<section class="content-section"><div class="section-heading"><h2>${esc(title)}</h2><a href="${BASE}/updates">All updates →</a></div><div class="post-grid">${posts.map(post => `
    <article class="post-card">${post.image ? `<a href="${BASE}/updates/${esc(post.slug)}"><img src="${esc(post.image)}" alt="" loading="lazy"></a>` : ""}
      <p class="eyebrow">${esc(localDate(post.date))}</p><h3><a href="${BASE}/updates/${esc(post.slug)}">${esc(post.title)}</a></h3><p>${text(post.excerpt).slice(0, 200)}…</p><a class="text-link" href="${BASE}/updates/${esc(post.slug)}">Read more →</a></article>`).join("") || empty}</div></section>`;
}

async function communityPosts(req) {
    const live = await publicData(updates, "/", { city: CITY, limit: "100" }, req);
    return [...(live.data || []).map(item => ({
      slug: item.slug, title: item.title, excerpt: item.summary, date: item.publishedAt,
      image: safeUrl(item.featuredImageUrl),
    })), ...content.posts].filter((post, index, all) => all.findIndex(other => other.slug === post.slug) === index).sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

router.get("/updates", async (req, res, next) => {
  try {
    const posts = await communityPosts(req);
    res.send(layout("Updates", `<div class="site-width">${pageHeader("Updates From Us", "News, improvements, and stories from the community.")}${postList("Latest updates", posts)}</div>`, { active: "/updates" }));
  } catch (error) { next(error); }
});

router.get("/updates/:slug", async (req, res, next) => {
  try {
    let update;
    try {
      ({ data: update } = await publicData(updates, "/" + encodeURIComponent(req.params.slug), { city: CITY, track: "0" }, req));
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    if (update) return res.send(layout(update.title, `<article class="site-width article-page">${pageHeader(update.title, localDate(update.publishedAt), "Updates From Us")}<div class="prose">${paragraphs(update.bodyHtml)}</div></article>`, { active: "/updates" }));
    const imported = content.posts.find(post => post.slug === req.params.slug);
    if (!imported) return next(Object.assign(new Error("Update not found."), { status: 404 }));
    res.send(layout(imported.title, `<article class="site-width article-page">${pageHeader(imported.title, localDate(imported.date), "Updates From Us")}${imported.image ? `<img class="article-image" src="${esc(imported.image)}" alt="">` : ""}<div class="prose">${imported.html}</div></article>`, { active: "/updates" }));
  } catch (error) { next(error); }
});

router.get("/venues", async (req, res, next) => {
  try {
    const q = typeof req.query.q === "string" ? req.query.q.slice(0, 200) : "";
    const offset = /^\d{1,6}$/.test(String(req.query.offset || "")) ? req.query.offset : "0";
    const result = await publicData(venues, "/", { city: CITY, q, limit: "24", offset }, req);
    res.send(layout("Venues", `<div class="site-width">${pageHeader("Venues in Enumclaw", "Explore local places to gather, celebrate, and connect.")}
      <form class="event-filters" method="get"><label>Find a venue<input name="q" value="${esc(q)}" placeholder="Name or address"></label><button class="button" type="submit">Search</button></form>
      <div class="event-grid">${result.data.map(venue => `<article class="event-card">
        <a class="event-card-image" href="${BASE}/venues/${encodeURIComponent(venue.slug || venue.id)}">${safeUrl(venue.imageUrl) ? `<img src="${esc(safeUrl(venue.imageUrl))}" alt="${esc(venue.name)}" loading="lazy">` : '<span class="image-placeholder" aria-hidden="true">EE</span>'}</a>
        <div class="event-card-body"><h3><a href="${BASE}/venues/${encodeURIComponent(venue.slug || venue.id)}">${text(venue.name)}</a></h3><p class="event-meta">${text(venue.address)}</p></div>
      </article>`).join("") || empty}</div>${pagination(result.meta, { q }, "/venues")}</div>`, { active: "/venues" }));
  } catch (error) { next(error); }
});

router.get("/venues/:key", async (req, res, next) => {
  try {
    const { data: venue } = await publicData(venues, /^\d+$/.test(req.params.key) ? "/" + req.params.key : "/slug/" + encodeURIComponent(req.params.key), { city: CITY, track: "0" }, req);
    if (venue.city !== CITY) return next(Object.assign(new Error("Venue not found."), { status: 404 }));
    const offset = typeof req.query.offset === "string" ? req.query.offset : "0";
    const upcoming = await publicData(venues, "/" + venue.id + "/events", { city: CITY, limit: "12", offset }, req);
    res.send(layout(venue.name, `<div class="site-width detail-page">${pageHeader(venue.name, venue.address, "Enumclaw venues")}
      ${safeUrl(venue.imageUrl) ? `<img class="article-image" src="${esc(safeUrl(venue.imageUrl))}" alt="${esc(venue.name)}">` : ""}<div class="prose">${paragraphs(venue.description)}</div>
      ${safeUrl(venue.website) ? `<a class="button" href="${esc(safeUrl(venue.website))}" target="_blank" rel="noopener noreferrer">Visit website</a>` : ""}
      ${eventSection("Upcoming events here", upcoming)}${pagination(upcoming.meta, {}, "/venues/" + encodeURIComponent(req.params.key))}</div>`, { active: "/venues" }));
  } catch (error) { next(error); }
});

router.get("/jobs", async (req, res, next) => {
  try {
    const offset = typeof req.query.offset === "string" && /^\d{1,6}$/.test(req.query.offset) ? Number(req.query.offset) : 0;
    const page = String(Math.floor(offset / 20) + 1);
    const result = await publicData(jobs, "/", { city: CITY, page, limit: "20" }, req);
    res.send(layout("Jobs", `<div class="site-width">${pageHeader("Work in Enumclaw", "Discover job opportunities with local businesses.", "Local opportunities")}
      <div class="job-list">${result.data.map(job => `<article class="job-card"><div><p class="eyebrow">${text(job.company)}</p><h2><a href="${BASE}/jobs/${encodeURIComponent(job.slug || job.id)}">${text(job.title)}</a></h2><p>${text([job.location, job.employmentType, job.salaryRange].filter(Boolean).join(" · "))}</p></div><a class="button button-light" href="${BASE}/jobs/${encodeURIComponent(job.slug || job.id)}">View job →</a></article>`).join("") || empty}</div>
      ${pagination({ total: result.pagination.total, limit: 20, offset: (result.pagination.page - 1) * 20, hasMore: result.pagination.page < result.pagination.totalPages, nextOffset: result.pagination.page * 20 }, {}, "/jobs")}</div>`, { active: "/jobs" }));
  } catch (error) { next(error); }
});

router.get("/jobs/:key", async (req, res, next) => {
  try {
    const { data: job } = await publicData(jobs, "/" + encodeURIComponent(req.params.key), { city: CITY, track: "0" }, req);
    if (job.city !== CITY) return next(Object.assign(new Error("Job not found."), { status: 404 }));
    const applicationForm = job.acceptsWebsiteApplications ? `
      <section class="content-section" aria-labelledby="jobApplicationTitle"><h2 id="jobApplicationTitle">Apply for this job</h2>
        <form class="submission-form" data-job-apply method="post" action="/jobs/${encodeURIComponent(job.slug || job.id)}/apply" enctype="multipart/form-data">
          ${JOB_APPLICATION_FIELDS.filter(field => job.applicationFields[field.key] !== "off").map(field => `
            <label>${esc(field.label)}${job.applicationFields[field.key] === "required" ? " *" : ""}
              ${field.key === "coverLetter" ? `<textarea name="coverLetter" rows="6"${job.applicationFields[field.key] === "required" ? " required" : ""}></textarea>`
                : `<input name="${field.key === "resume" ? "resumeFile" : field.key}" type="${({ email: "email", phone: "tel", resume: "file" }[field.key] || "text")}"${field.key === "resume" ? ' accept=".pdf,.doc,.docx,.txt"' : ""}${job.applicationFields[field.key] === "required" ? " required" : ""}>`}
            </label>`).join("")}
          <input type="hidden" name="source" value="opencircle_site_preview">
          <p class="field-hint">Resume files may be PDF, DOC, DOCX, or TXT, up to 8 MB.</p>
          <button class="button" type="submit">Submit application</button><p class="form-status" role="status"></p>
        </form>
      </section>` : "";
    res.send(layout(job.title, `<article class="site-width article-page">${pageHeader(job.title, [job.company, job.location, job.employmentType].filter(Boolean).join(" · "), "Local opportunities")}<div class="prose">${paragraphs(job.description)}</div>
      ${safeUrl(job.applyUrl) ? `<a class="button" href="${esc(safeUrl(job.applyUrl))}" target="_blank" rel="noopener noreferrer">Apply for this job</a>` : job.acceptsWebsiteApplications ? "" : `<p>Contact ${text(job.company)} for application information.</p>`}${applicationForm}</article>`, { active: "/jobs" }));
  } catch (error) { next(error); }
});

router.get("/submit-event", async (req, res) => {
  let venueOptions = "";
  try {
    let offset = 0;
    while (offset !== null) {
      const { data, meta } = await publicData(venues, "/", { city: CITY, limit: "100", offset: String(offset) }, req);
      venueOptions += data.map(venue => `<option value="${esc(venue.id)}">${esc(venue.name)}${venue.address ? " — " + esc(venue.address) : ""}</option>`).join("");
      offset = meta.nextOffset;
    }
  } catch (error) {
    console.error("[community preview venues]", error.message);
  }
  res.send(layout("Add your event", `<div class="site-width article-page">${pageHeader("Add Your Event", "Share your local event with the community. Submissions are reviewed before publishing.", "Free community listings")}
    <form class="submission-form" data-event-submit method="post" action="${BASE}/submit-event">
      <label>Event title<input name="title" maxlength="250" required></label>
      <label>Your email<input name="submitterEmail" type="email" autocomplete="email" required></label>
      <div class="form-grid form-grid--location">
        <label>Address<input name="location" maxlength="300" required></label>
        <label>Organizer<input name="organizer" maxlength="200" required></label>
        <label>Add a Venue (optional)<select name="venueId"><option value="">No venue</option>${venueOptions}</select></label>
      </div>
      <div class="form-grid"><label>Start date and time<input name="start" type="datetime-local" required></label><label>End date and time<input name="end" type="datetime-local" required></label></div>
      <p class="field-hint">All times are local to Enumclaw (Pacific time).</p>
      <label>Category<select name="category" required>${EVENT_CATEGORIES.map(category => `<option value="${esc(category.name)}">${esc(category.name)}</option>`).join("")}</select></label>
      <label>Tell us about your event<textarea name="description" rows="7" maxlength="15000" required></textarea></label>
      <label>Event or ticket website<input name="ticketUrl" type="url" placeholder="https://"></label>
      <label>Event image URL (optional)<input name="imageUrl" type="url" placeholder="https://"></label>
      <button class="button" type="submit">Submit for review</button><p role="status" class="form-status"></p>
    </form></div>`));
});

router.post("/submit-event", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const body = req.body || {};
    const start = DateTime.fromISO(String(body.start || ""), { zone: DEFAULT_TZ });
    const end = DateTime.fromISO(String(body.end || ""), { zone: DEFAULT_TZ });
    if (!start.isValid || !end.isValid || end <= start) return res.status(400).json({ error: "Please choose a valid start and end time." });
    if (!EVENT_CATEGORIES.some(category => category.name === body.category)) return res.status(400).json({ error: "Please choose a valid category." });
    const payload = {
      title: String(body.title || "").slice(0, 250), description: String(body.description || "").slice(0, 15000),
      location: String(body.location || "").slice(0, 300), organizer: String(body.organizer || "").slice(0, 200),
      venueId: body.venueId,
      venueName: body.venueName,
      submitterEmail: String(body.submitterEmail || "").slice(0, 254), city: CITY,
      startDateTime: start.toUTC().toISO(), endDateTime: end.toUTC().toISO(), categories: [body.category],
      ticketUrl: safeUrl(body.ticketUrl), imageUrl: safeUrl(body.imageUrl), source: "opencircle_site_preview",
    };
    const result = await publicData(events, "/submit", {}, req, "POST", payload);
    res.json({ ok: result.ok, message: "Thank you! Your event has been submitted for review." });
  } catch (error) { res.status(error.status || 500).json({ error: error.status < 500 ? error.message : "Could not submit your event. Please try again." }); }
});

router.get("/:slug", (req, res, next) => {
  const page = content.pages.find(item => item.slug === req.params.slug);
  if (!page) return next();
  res.send(layout(page.title, `<article class="site-width article-page">${pageHeader(page.title)}<div class="prose">${page.html}</div></article>`, { active: req.params.slug === "about" ? "/about" : "" }));
});

router.use((req, res) => res.status(404).send(layout("Page not found", `<div class="site-width article-page">${pageHeader("We couldn’t find that page", "Explore the latest local events instead.")}<a class="button" href="${BASE}/events">Browse events</a></div>`)));
router.use((error, req, res, _next) => {
  const code = [400, 404].includes(error.status) ? error.status : 503;
  if (code === 503) console.error("[community preview]", error.message);
  res.status(code).send(layout(code === 404 ? "Page not found" : "Content unavailable", `<div class="site-width article-page">${pageHeader(code === 404 ? "This listing wasn’t found" : "We couldn’t load this content", code === 400 ? error.message : "Please try again or explore another page.")}
    <a class="button" href="${BASE}/events">Browse events</a></div>`));
});

module.exports = router;
