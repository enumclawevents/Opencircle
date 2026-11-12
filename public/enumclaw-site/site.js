"use strict";

const slides = [...document.querySelectorAll(".hero-slide")];
let activeSlide = 0;
for (const button of document.querySelectorAll("[data-hero-step]")) {
  button.addEventListener("click", () => {
    slides[activeSlide].hidden = true;
    activeSlide = (activeSlide + Number(button.dataset.heroStep) + slides.length) % slides.length;
    slides[activeSlide].hidden = false;
    document.querySelector("[data-hero-count]").textContent = (activeSlide + 1) + " / " + slides.length;
  });
}

for (const form of document.querySelectorAll("[data-newsletter], [data-event-submit], [data-job-apply]")) {
  form.addEventListener("submit", async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    if (button.disabled) return;
    const status = form.querySelector("[role=status]");
    button.disabled = true;
    status.textContent = "Sending…";
    try {
      const multipart = form.hasAttribute("data-job-apply");
      const response = await fetch(form.action, {
        method: "POST",
        ...(multipart ? {} : { headers: { "Content-Type": "application/json" } }),
        body: multipart ? new FormData(form) : JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const result = await response.json();
      if (!response.ok || result.ok !== true) throw new Error(result.error || "Please try again.");
      status.textContent = form.hasAttribute("data-newsletter") ? "You’re signed up. Thanks for joining!" : result.message;
      form.reset();
    } catch (error) {
      status.textContent = error.message || "Could not send your request. Please try again.";
    } finally {
      button.disabled = false;
    }
  });
}

const menuButton = document.querySelector("[data-menu-toggle]");
const navigation = document.querySelector("#siteNavigation");
if (menuButton && navigation) {
  menuButton.hidden = false;
  document.documentElement.classList.add("has-mobile-menu");
  function closeMenu() {
    menuButton.setAttribute("aria-expanded", "false");
    navigation.classList.remove("is-open");
  }
  menuButton.addEventListener("click", () => {
    const open = menuButton.getAttribute("aria-expanded") !== "true";
    menuButton.setAttribute("aria-expanded", String(open));
    navigation.classList.toggle("is-open", open);
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && menuButton.getAttribute("aria-expanded") === "true") {
      closeMenu();
      menuButton.focus();
    }
  });
  navigation.addEventListener("click", event => {
    if (event.target.closest("a")) closeMenu();
  });
}

for (const button of document.querySelectorAll("[data-share-event]")) {
  button.addEventListener("click", async () => {
    const status = document.querySelector("[data-share-status]");
    try {
      if (navigator.share) {
        await navigator.share({ title: document.title, url: location.href });
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(location.href);
        status.textContent = "Event link copied.";
      } else {
        status.textContent = "Copy this event link: " + location.href;
      }
    } catch (error) {
      if (error.name !== "AbortError") status.textContent = "Copy this event link: " + location.href;
    }
  });
}
