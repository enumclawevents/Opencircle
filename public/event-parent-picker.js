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
    const selection = picker.querySelector('[data-parent-selection]');
    const change = picker.querySelector('[data-parent-change]');
    const clearButton = picker.querySelector('[data-parent-clear]');
    const search = picker.querySelector('[data-parent-search]');
    const dropdown = picker.querySelector('[data-parent-dropdown]');
    const city = form.elements.namedItem('city');
    let changing = false;
    const announce = message => {
      status.textContent = message;
      if (dropdown) dropdown.hidden = !message && !results.children.length;
    };
    let request;
    let debounce;
    const cancelSearch = () => {
      clearTimeout(debounce);
      request?.abort();
      results.replaceChildren();
    };
    const display = item => {
      const timestamp = Date.parse(item.startDateTime);
      return Number.isFinite(timestamp) ? `${item.title} · ${date.format(timestamp)}` : item.title;
    };
    const update = () => {
      panel.hidden = !toggle.checked;
      if (selection && search) {
        selection.hidden = !value.value || changing;
        search.hidden = !selection.hidden;
      }
      input.required = toggle.checked && !value.value;
      input.setCustomValidity(input.required ? 'Choose a larger event from the search results.' : '');
    };
    const clear = () => {
      value.value = '';
      selected.textContent = '';
    };
    const closeSearch = () => {
      cancelSearch();
      input.value = '';
      changing = false;
      announce('');
      update();
    };
    change?.addEventListener('click', () => {
      changing = true;
      update();
      input.focus();
    });
    clearButton?.addEventListener('click', () => {
      clear();
      closeSearch();
      input.focus();
    });
    toggle.addEventListener('change', () => {
      if (!toggle.checked) clear();
      closeSearch();
      if (toggle.checked) (value.value && change ? change : input).focus();
    });
    city?.addEventListener('change', () => {
      clear();
      closeSearch();
      if (toggle.checked) announce('Choose a larger event for this area.');
    });
    if (search) {
      search.addEventListener('focusout', event => {
        if (event.relatedTarget && !search.contains(event.relatedTarget)) closeSearch();
      });
      document.addEventListener('pointerdown', event => {
        if (!search.hidden && !search.contains(event.target)) closeSearch();
      });
    }
    input.addEventListener('input', () => {
      cancelSearch();
      const query = input.value.trim();
      if (query.length < 2) {
        announce(query ? 'Enter at least two characters.' : '');
        return;
      }
      announce('Searching…');
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
            if (!/^[1-9]\d*$/.test(String(item?.id)) || typeof item.title !== 'string'
                || String(item.id) === picker.dataset.eventId) continue;
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = display(item);
            button.addEventListener('click', () => {
              value.value = String(item.id);
              selected.textContent = selection ? display(item) : `Selected: ${display(item)}`;
              closeSearch();
              (change || input).focus();
            });
            const li = document.createElement('li');
            li.append(button);
            results.append(li);
          }
          announce(results.children.length
            ? `${results.children.length} results. Use Tab or Down Arrow to choose one.`
            : 'No matching published events.');
        } catch (error) {
          if (!signal.aborted) announce('Event lookup failed. Edit the search to try again.');
        }
      }, 250);
    });
    const advanced = picker.closest('.event-form-advanced');
    advanced?.addEventListener('invalid', event => {
      let section = event.target.closest('details');
      while (section && advanced.contains(section)) {
        section.open = true;
        section = section.parentElement.closest('details');
      }
    }, true);
    const dismiss = event => {
      event.preventDefault();
      closeSearch();
      (value.value && change ? change : input).focus();
    };
    input.addEventListener('keydown', event => {
      const first = results.querySelector('button');
      if (event.key === 'Escape') {
        dismiss(event);
      } else if (event.key === 'ArrowDown' && first) {
        event.preventDefault();
        first.focus();
      } else if (event.key === 'Enter' && search && !event.isComposing) {
        event.preventDefault();
        first?.click();
      }
    });
    results.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        dismiss(event);
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
        closeSearch();
      }, 0);
    });
    // WordPress uses novalidate to run its existing submission flow.
    form.addEventListener('submit', event => {
      if (!["saveDraft", "saveChangesDraft"].includes(event.submitter?.name) && toggle.checked && !value.value) {
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
  const deleteDraft = form.querySelector('[data-delete-event-draft]');
  const deleteError = form.querySelector('[data-draft-delete-error]');
  const unsaved = form.closest('#create')?.querySelector('[data-event-unsaved]');
  const generatedFields = new Set(['startDateTimeISO', 'endDateTimeISO', 'recurrenceDatesJson',
    'multiDayScheduleJson', 'recurrenceRuleChanged', 'lifecycleAction', 'lifecycleReason',
    'confirmRecurringLifecycle', 'recurrenceChoice']);
  const snapshot = () => JSON.stringify(Array.from(new FormData(form))
    .filter(([name, value]) => !generatedFields.has(name) && (typeof value === 'string' || value.name))
    .map(([name, value]) => [name, typeof value === 'string' ? value : [value.name, value.size, value.lastModified]]));
  let savedForm;
  if (unsaved) {
    savedForm = snapshot();
    const updateUnsaved = () => { unsaved.hidden = snapshot() === savedForm; };
    const checkUserEdit = event => {
      if (event.isTrusted) queueMicrotask(updateUnsaved);
    };
    form.addEventListener('input', checkUserEdit);
    form.addEventListener('change', checkUserEdit);
    // Picker controls also change hidden values or add and remove date rows.
    form.addEventListener('click', event => {
      if (event.target.closest('button, [role="button"], #multiDayUseCustomDates')) checkUserEdit(event);
    });
    form.addEventListener('event-editor-change', updateUnsaved);
    form.addEventListener('reset', event => {
      if (event.isTrusted) queueMicrotask(updateUnsaved);
    });
  }
  let busy = false;
  let force = false;
  deleteDraft?.addEventListener('click', async () => {
    if (busy || !window.confirm('Permanently delete this draft?')) return;
    busy = true;
    deleteDraft.disabled = true;
    deleteError.hidden = true;
    try {
      const response = await fetch(deleteDraft.dataset.deleteEventDraft, {
        method: 'POST',
        headers: { Accept: 'application/json' },
      });
      const result = await response.json().catch(() => null);
      if (response.ok && result?.ok === true) {
        window.location.assign(deleteDraft.dataset.afterDelete);
        return;
      }
      deleteError.textContent = result?.error || 'Could not delete the draft. Try again.';
    } catch {
      deleteError.textContent = 'Could not delete the draft. Check your connection and try again.';
    }
    deleteError.hidden = false;
    deleteDraft.disabled = false;
    deleteDraft.focus();
    busy = false;
  });
  retry.addEventListener('click', () => {
    force = true;
    form.requestSubmit(form.querySelector("[data-event-publish]") || undefined);
    force = false;
  });
  form.addEventListener('submit', async event => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    if (busy) return;
    busy = true;
    if (deleteDraft) deleteDraft.disabled = true;
    retry.hidden = true;
    const savingDraft = ['saveDraft', 'saveChangesDraft'].includes(event.submitter?.name);
    const publishing = /^Publish /.test((event.submitter || form.querySelector('[data-event-publish]'))?.textContent.trim());
    const action = savingDraft ? 'Saving draft' : publishing ? 'Publishing' : 'Saving';
    status.textContent = action + '…';
    const body = new FormData(form, event.submitter);
    if (force) body.set('forceDuplicateSave', '1');
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        body,
        credentials: 'same-origin',
        headers: { Accept: 'application/json', 'X-OpenCircle-Event-Editor': '1' },
      });
      if (response.redirected && response.ok && new URL(response.url).pathname === '/admin/create-events') {
        if (unsaved) unsaved.hidden = true;
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
        status.textContent = publishing ? 'Publication could not be confirmed. Check your session and try again.'
          : 'Save could not be confirmed. Check your session and try again.';
      }
    } catch {
      status.textContent = publishing ? 'Publication could not be confirmed. Check your connection and try again.'
        : 'Save could not be confirmed. Check your connection and try again.';
    } finally {
      busy = false;
      if (deleteDraft) deleteDraft.disabled = false;
    }
  });
});
