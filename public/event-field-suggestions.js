"use strict";

document.querySelectorAll("[data-event-suggest]").forEach(input => {
  if (input.readOnly) return;
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

  function close() {
    clearTimeout(timer);
    request?.abort();
    active = -1;
    results = [];
    list.replaceChildren();
    list.hidden = true;
    status.textContent = "";
    status.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
  }

  function announce(message) {
    status.hidden = !message;
    status.textContent = message;
  }

  function select(index) {
    input.value = results[index].value;
    close();
    form.dispatchEvent(new Event("event-editor-change"));
  }

  function search() {
    close();
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
        results = data;
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
});
