(() => {
  const content = document.querySelector('[data-page-loading-content]');
  const header = document.querySelector('[data-page-loading-header]');
  const overlay = document.createElement('div');
  const account = !content;
  overlay.className = 'oc-page-loading' + (account ? ' oc-page-loading--account' : '');
  overlay.hidden = true;

  const bar = size => '<span class="oc-page-loading__bar oc-page-loading__bar--' + size + '"></span>';
  const card = '<div class="oc-page-loading__card">' + bar('short') + bar('wide') + '</div>';
  overlay.innerHTML = '<div class="oc-page-loading__status" role="status"></div>'
    + '<div class="oc-page-loading__layout" aria-hidden="true">' + bar('title')
    + (account ? bar('field').repeat(3)
      : bar('short') + '<div class="oc-page-loading__cards">' + card.repeat(3) + '</div>'
        + '<div class="oc-page-loading__card">' + bar('short') + bar('wide').repeat(4) + '</div>')
    + '</div>';
  document.body.append(overlay);
  const status = overlay.querySelector('[role="status"]');
  let showTimer;
  let recoveryTimer;
  let pending;

  function positionOverlay() {
    if (!content || overlay.hidden) return;
    const rect = content.getBoundingClientRect();
    overlay.style.setProperty('--loading-left', Math.max(0, rect.left) + 'px');
    overlay.style.setProperty('--loading-right', Math.max(0, document.documentElement.clientWidth - rect.right) + 'px');
    const top = Math.max(0, header ? header.getBoundingClientRect().bottom : rect.top);
    overlay.style.setProperty('--loading-top', Math.min(top, window.innerHeight * 0.75) + 'px');
  }

  function stop() {
    clearTimeout(showTimer);
    clearTimeout(recoveryTimer);
    pending = null;
    overlay.hidden = true;
    content?.removeAttribute('aria-busy');
    status.textContent = '';
  }

  function isPage(url) {
    if (url.origin !== location.origin) return false;
    const path = url.pathname.replace(/\/$/, '') || '/';
    if (path === '/' || /^\/(?:login|logout|signup|invite|forgot|reset|terms-of-service|privacy-policy)$/.test(path)) return true;
    if (path === '/preview/enumclaw' || path.startsWith('/preview/enumclaw/')) return !path.endsWith('/calendar');
    return (path === '/admin' || path.startsWith('/admin/'))
      && !/(?:^|\/)(?:report-download|export[^/]*|download[^/]*|resume)(?:\/|$)/i.test(path)
      && !/\.(?:pdf|csv|xlsx|zip|ics)$/i.test(path);
  }

  function start(url, signal, event) {
    if (!isPage(url)) return;
    stop();
    const current = {};
    pending = current;
    signal?.addEventListener('abort', () => {
      if (pending === current) stop();
    }, { once: true });
    showTimer = setTimeout(() => {
      if (event.defaultPrevented || signal?.aborted) return stop();
      content?.setAttribute('aria-busy', 'true');
      overlay.hidden = false;
      positionOverlay();
      status.textContent = 'Loading page…';
    }, 150);
    // Recover if the browser keeps the current document, such as after a download.
    recoveryTimer = setTimeout(stop, 15000);
  }

  if (window.navigation) {
    window.navigation.addEventListener('navigate', event => {
      if (event.hashChange || event.destination.sameDocument || event.downloadRequest != null) return;
      start(new URL(event.destination.url), event.signal, event);
    });
    window.navigation.addEventListener('navigateerror', stop);
  } else {
    const opensHere = target => !target || target.toLowerCase() === '_self';
    window.addEventListener('click', event => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const link = event.target.closest?.('a[href]');
      if (!link || link.hasAttribute('download') || !opensHere(link.target)) return;
      const url = new URL(link.href, location.href);
      if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
      start(url, null, event);
    });
    window.addEventListener('submit', event => {
      if (event.defaultPrevented) return;
      const form = event.target;
      const target = event.submitter?.getAttribute('formtarget') ?? form.target;
      const action = event.submitter?.getAttribute('formaction') ?? form.action;
      const method = event.submitter?.getAttribute('formmethod') ?? form.method;
      if (opensHere(target) && method.toLowerCase() !== 'dialog') start(new URL(action, location.href), null, event);
    });
  }
  window.addEventListener('resize', positionOverlay);
  window.addEventListener('scroll', positionOverlay, { passive: true });
  window.addEventListener('pagehide', stop);
  window.addEventListener('pageshow', stop);
})();
