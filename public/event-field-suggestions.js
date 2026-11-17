"use strict";

function initEventFieldSuggestions(input, { accept, exclude } = {}) {
  if (!input.matches("[data-event-suggest]") || input.readOnly || input.hasAttribute("aria-controls")) return;
  const form = input.form;
  const city = form.elements.namedItem("city");
  const list = document.createElement("ul");
  list.id = input.id + "-suggestions";
  list.className = "event-field-suggestion-list";
  list.setAttribute("role", "listbox");
  const label = input.labels?.[0]?.textContent.trim();
  list.setAttribute("aria-label", label ? label + " suggestions" : "Suggestions");
  const status = document.createElement("div");
  status.className = "note";
  status.setAttribute("role", "status");
  input.after(list, status);
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-autocomplete", "list");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("autocomplete", "off");
  let timer;
  let request;
  let active = -1;
  let results = [];
  let hasOpened = false;

  function clearResults() {
    clearTimeout(timer);
    request?.abort();
    active = -1;
    results = [];
    list.replaceChildren();
    list.hidden = true;
    list.removeAttribute("data-suggestion-enter");
    status.textContent = "";
    status.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function close() {
    hasOpened = false;
    clearResults();
  }

  function announce(message) {
    status.hidden = !message;
    status.textContent = message;
  }

  function select(index) {
    const { value } = results[index];
    close();
    if (accept) {
      accept(value);
      return;
    }
    input.value = value;
    form.dispatchEvent(new Event("event-editor-change"));
  }

  function search() {
    clearResults();
    const q = input.value.trim();
    if (q.length < 2 || q.length > 100 || !city.value || document.activeElement !== input) return;
    timer = setTimeout(async () => {
      const controller = new AbortController();
      request = controller;
      announce("Looking for suggestions…");
      try {
        const query = new URLSearchParams({ type: input.dataset.eventSuggest, q, city: city.value });
        const response = await fetch("/admin/event-field-suggestions?" + query, { signal: controller.signal });
        if (!response.ok) throw new Error();
        const { data } = await response.json();
        if (controller.signal.aborted) return;
        results = exclude ? data.filter(item => !exclude(item.value)) : data;
        for (const [index, item] of results.entries()) {
          const option = document.createElement("li");
          option.id = list.id + "-" + index;
          option.setAttribute("role", "option");
          option.setAttribute("aria-selected", "false");
          option.textContent = item.value;
          option.addEventListener("pointerdown", event => event.preventDefault());
          option.addEventListener("click", () => select(index));
          list.append(option);
        }
        if (results.length && !hasOpened) {
          list.setAttribute("data-suggestion-enter", "");
          hasOpened = true;
        }
        list.hidden = !results.length;
        input.setAttribute("aria-expanded", String(!!results.length));
        announce(results.length ? "" : "No matching suggestions.");
      } catch {
        if (!controller.signal.aborted) announce("Suggestions are unavailable. You can keep typing.");
      }
    }, 200);
  }

  close();
  input.addEventListener("input", event => {
    if (event.isTrusted && !event.isComposing) search();
    else close();
  });
  input.addEventListener("compositionend", search);
  input.addEventListener("blur", close);
  city.addEventListener("change", close);
  input.addEventListener("keydown", event => {
    if (event.isComposing) return;
    if (event.key === "Escape") {
      if (!list.hidden) event.preventDefault();
      close();
    } else if (event.key === "Enter" && active >= 0) {
      event.preventDefault();
      select(active);
    } else if (results.length && ["ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      list.children[active]?.setAttribute("aria-selected", "false");
      const direction = event.key === "ArrowDown" ? 1 : -1;
      active = active < 0 ? (direction > 0 ? 0 : results.length - 1) : (active + direction + results.length) % results.length;
      const option = list.children[active];
      option.setAttribute("aria-selected", "true");
      input.setAttribute("aria-activedescendant", option.id);
      option.scrollIntoView({ block: "nearest" });
    }
  });
}

document.querySelectorAll('[data-event-suggest="location"]').forEach(input => initEventFieldSuggestions(input));

document.querySelectorAll("[data-organizer-picker]").forEach(picker => {
  const input = picker.querySelector("[data-organizer-entry]");
  const form = input.form;
  const primary = form.elements.namedItem("organizer");
  const values = picker.querySelector("[data-organizer-values]");
  const tags = picker.querySelector("[data-organizer-tags]");
  const error = picker.querySelector("[data-organizer-error]");
  const locked = picker.hasAttribute("data-primary-locked");
  const limit = Number(picker.dataset.limit);
  const key = value => value.trim().replace(/\s+/g, " ").toLowerCase();
  let additional = [...values.children].map(field => field.value);

  function clearError() {
    error.hidden = true;
    error.textContent = "";
    input.removeAttribute("aria-invalid");
    input.setAttribute("aria-describedby", "eventOrganizerHelp");
  }

  function showError(message) {
    error.hidden = false;
    error.textContent = message;
    input.setAttribute("aria-invalid", "true");
    input.setAttribute("aria-describedby", "eventOrganizerHelp " + error.id);
    input.focus();
    return false;
  }

  function renderTags() {
    input.required = !primary.value;
    tags.replaceChildren();
    [primary.value, ...additional].forEach((name, index) => {
      if (!name) return;
      const tag = document.createElement("span");
      tag.className = "event-organizer-tag";
      const label = document.createElement("span");
      label.className = "event-organizer-tag-name";
      label.textContent = name;
      tag.append(label);
      if (index === 0) {
        const badge = document.createElement("span");
        badge.className = "event-organizer-primary";
        badge.textContent = "Primary";
        tag.append(badge);
      }
      if (index > 0 || !locked) {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "event-organizer-remove";
        remove.setAttribute("aria-label", "Remove organizer " + name);
        remove.textContent = "×";
        remove.addEventListener("click", () => {
          if (index === 0) primary.value = additional.shift() || "";
          else additional.splice(index - 1, 1);
          sync();
          input.focus();
        });
        tag.append(remove);
      }
      tags.append(tag);
    });
  }

  function sync() {
    values.replaceChildren(...additional.map(name => {
      const field = document.createElement("input");
      field.type = "hidden";
      field.name = "additionalOrganizers";
      field.value = name;
      return field;
    }));
    clearError();
    renderTags();
    form.dispatchEvent(new Event("event-editor-change"));
  }

  function isSelected(value) {
    return [primary.value, ...additional].some(name => key(name) === key(value));
  }

  function finalize(value) {
    const name = value.trim();
    if (!name || name.length > input.maxLength || name.includes("\0")) {
      return showError("Enter an organizer name of 1 to " + input.maxLength + " characters.");
    }
    if (isSelected(name)) return showError("Organizer names must be unique within the event.");
    if (!locked && !primary.value) primary.value = name;
    else if (additional.length >= limit) return showError("You can add up to " + limit + " additional organizers.");
    else additional.push(name);
    input.value = "";
    input.dispatchEvent(new Event("input"));
    sync();
    return true;
  }

  input.disabled = false;
  renderTags();
  initEventFieldSuggestions(input, {
    accept: value => { if (finalize(value)) input.focus(); },
    exclude: isSelected,
  });
  input.addEventListener("input", clearError);
  input.addEventListener("keydown", event => {
    if (!event.defaultPrevented && !event.isComposing && event.key === "Enter") {
      event.preventDefault();
      if (input.value.trim()) finalize(input.value);
    }
  });
  form.addEventListener("submit", event => {
    if (!event.defaultPrevented && input.value && !finalize(input.value)) event.preventDefault();
  }, true);

  // Quick Add still fills the primary field through the existing form importer.
  primary.addEventListener("change", () => {
    const duplicate = additional.findIndex(name => key(name) === key(primary.value));
    if (duplicate >= 0) additional.splice(duplicate, 1);
    sync();
  });
});
