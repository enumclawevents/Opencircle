/* Used by the WordPress submission form and OpenCircle's event editor. */
(() => {
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'America/Los_Angeles' });
  document.querySelectorAll('[data-oc-event-parent]').forEach(picker => {
    const form = picker.closest('form');
    const toggle = picker.querySelector('[data-parent-toggle]');
    const panel = picker.querySelector('[data-parent-panel]');
    const input = picker.querySelector('[data-parent-query]');
    const selected = picker.querySelector('[data-parent-selected]');
    const value = picker.querySelector('[name=parentEventId]');
    const results = picker.querySelector('[data-parent-results]');
    const status = picker.querySelector('[data-parent-status]');
    const city = form.elements.namedItem('city');
    let request;
    let debounce;
    const cancelSearch = () => {
      clearTimeout(debounce);
      request?.abort();
      results.replaceChildren();
    };
    const display = item => {
      const timestamp = Date.parse(item.startDateTime);
      return Number.isFinite(timestamp) ? `${item.title} — ${date.format(timestamp)}` : item.title;
    };
    const update = () => {
      panel.hidden = !toggle.checked;
      input.required = toggle.checked && !value.value;
      input.setCustomValidity(input.required ? 'Choose a larger event from the search results.' : '');
    };
    const clear = () => {
      value.value = '';
      selected.textContent = '';
    };
    toggle.addEventListener('change', () => {
      cancelSearch();
      input.value = '';
      if (!toggle.checked) clear();
      status.textContent = '';
      update();
      if (toggle.checked) input.focus();
    });
    city?.addEventListener('change', () => {
      cancelSearch();
      clear();
      input.value = '';
      status.textContent = toggle.checked ? 'Choose a larger event for this area.' : '';
      update();
    });
    input.addEventListener('input', () => {
      cancelSearch();
      const query = input.value.trim();
      if (query.length < 2) {
        status.textContent = 'Enter at least two characters.';
        return;
      }
      status.textContent = 'Searching…';
      debounce = setTimeout(async () => {
        request = new AbortController();
        const signal = request.signal;
        try {
          const cities = picker.dataset.parentCities?.split('|') || [city?.value || picker.dataset.parentCity];
          const items = await Promise.all(cities.map(async scope => {
            const url = new URL(picker.dataset.parentEndpoint, window.location.href);
            url.searchParams.set('q', query);
            url.searchParams.set('city', scope);
            if (picker.dataset.eventId) url.searchParams.set('eventId', picker.dataset.eventId);
            const response = await fetch(url, { signal, headers: { Accept: 'application/json' } });
            if (!response.ok) throw new Error('Lookup failed');
            const payload = await response.json();
            if (!Array.isArray(payload.data)) throw new Error('Unexpected response');
            return payload.data;
          }));
          if (signal.aborted) return;
          for (const item of items.flat()) {
            if (!/^[1-9]\d*$/.test(String(item?.id)) || typeof item.title !== 'string') continue;
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = display(item);
            button.addEventListener('click', () => {
              value.value = String(item.id);
              selected.textContent = `Selected: ${display(item)}`;
              status.textContent = '';
              cancelSearch();
              input.value = '';
              update();
              input.focus();
            });
            const li = document.createElement('li');
            li.append(button);
            results.append(li);
          }
          status.textContent = results.children.length
            ? `${results.children.length} results. Use Tab or Down Arrow to choose one.`
            : 'No matching published events.';
        } catch (error) {
          if (!signal.aborted) status.textContent = 'Event lookup failed. Edit the search to try again.';
        }
      }, 250);
    });
    input.addEventListener('invalid', () => {
      const advanced = picker.closest('details');
      if (advanced) advanced.open = true;
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' && results.firstElementChild) {
        event.preventDefault();
        results.querySelector('button').focus();
      }
    });
    results.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        input.focus();
        cancelSearch();
        status.textContent = '';
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const item = event.target.closest('li');
        const next = event.key === 'ArrowDown' ? item?.nextElementSibling : item?.previousElementSibling;
        if (next) next.querySelector('button').focus();
        else if (event.key === 'ArrowUp') input.focus();
      }
    });
    form.addEventListener('reset', () => {
      cancelSearch();
      setTimeout(() => {
        selected.textContent = picker.dataset.initialLabel || '';
        status.textContent = '';
        update();
      }, 0);
    });
    // WordPress uses novalidate to run its existing submission flow.
    form.addEventListener('submit', event => {
      if (toggle.checked && !value.value) {
        event.preventDefault();
        event.stopImmediatePropagation();
        input.reportValidity();
      }
    }, true);
    update();
  });
})();

// Save through the authenticated editor's existing form action and handlers.
document.querySelectorAll('[data-parent-save-status]').forEach(status => {
  const form = status.closest('form');
  const retry = form.querySelector('[data-parent-save-anyway]');
  let busy = false;
  let force = false;
  retry.addEventListener('click', () => {
    force = true;
    form.requestSubmit();
    force = false;
  });
  form.addEventListener('submit', async event => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    retry.hidden = true;
    status.textContent = 'Saving…';
    const body = new FormData(form);
    if (force) body.set('forceDuplicateSave', '1');
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body,
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-OpenCircle-Event-Editor': '1' },
      });
      if (response.redirected && response.ok && new URL(response.url).pathname === '/admin/create-events') {
        window.location.assign(response.url);
        return;
      }
      const isJson = response.headers.get('content-type')?.includes('application/json');
      const payload = isJson ? await response.json() : null;
      if (response.status === 409 && Array.isArray(payload?.duplicates)) {
        status.textContent = `${payload.error} ${payload.duplicates.filter(Boolean).join(', ')}`;
        retry.hidden = false;
      } else if (!response.redirected && response.status >= 400 && response.status < 500) {
        status.textContent = payload?.error || (await response.text()).slice(0, 400);
      } else {
        status.textContent = 'Save could not be confirmed. Check your session and try again.';
      }
    } catch {
      status.textContent = 'Save could not be confirmed. Check your connection and try again.';
    } finally {
      busy = false;
    }
  });
});
