(() => {
  const panel = document.querySelector('.release-notes');
  if (!panel) return;
  const entries = panel.querySelector('[data-release-entries]');
  const status = panel.querySelector('[data-release-status]');
  const more = panel.querySelector('[data-release-more]');
  const previous = panel.querySelector('[data-release-previous]');
  const filters = [...panel.querySelectorAll('[data-release-filter]')];
  let request;

  panel.addEventListener('click', async event => {
    const link = event.target.closest('[data-release-filter], [data-release-more]');
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    const append = link === more;
    if (append && request) return;
    request?.abort();
    const current = new AbortController();
    request = current;
    status.textContent = 'Loading release notes…';
    entries.setAttribute('aria-busy', 'true');
    try {
      const response = await fetch(link.href, {
        headers: { Accept: 'application/json' },
        signal: current.signal,
      });
      if (!response.ok || response.redirected) throw new Error('Release notes unavailable');
      const result = await response.json();
      if (current.signal.aborted) return;
      if (append) entries.insertAdjacentHTML('beforeend', result.html);
      else {
        entries.innerHTML = result.html;
        filters.forEach(filter => {
          if (filter.dataset.releaseFilter === result.category) filter.setAttribute('aria-current', 'true');
          else filter.removeAttribute('aria-current');
        });
        if (previous) previous.hidden = true;
        history.replaceState(history.state, '', link.href);
      }
      const next = new URL(link.href);
      next.searchParams.set('page', String(result.page + 1));
      more.href = next.href;
      more.hidden = !result.hasMore;
      status.textContent = append ? 'Older releases loaded.' : '';
      if (append && more.hidden && document.activeElement === more) {
        const latestEntry = entries.lastElementChild;
        latestEntry?.setAttribute('tabindex', '-1');
        latestEntry?.focus();
      }
    } catch (error) {
      if (!current.signal.aborted) status.textContent = 'Could not load release notes. Try again.';
    } finally {
      if (request === current) {
        request = null;
        entries.removeAttribute('aria-busy');
      }
    }
  });
})();
