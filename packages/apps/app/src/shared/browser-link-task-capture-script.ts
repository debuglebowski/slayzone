export const BROWSER_CREATE_TASK_FROM_LINK_BRIDGE_KEY = '__slzBrowserCreateTaskFromLink'
export const BROWSER_CREATE_TASK_FROM_LINK_INSTALLED_KEY = '__slzBrowserCreateTaskFromLinkInstalled'

const BROWSER_CREATE_TASK_FROM_LINK_CAPTURE_SCRIPT_TEMPLATE = `
(() => {
  const bridgeKey = __SLZ_BRIDGE_KEY__;
  const installedKey = __SLZ_INSTALLED_KEY__;
  const bridgeWindow = window;
  if (bridgeWindow[installedKey] === document) return;

  const isClosestCapableTarget = (value) =>
    typeof value === 'object' && value !== null && typeof value.closest === 'function';

  const readAnchorHref = (anchor) => {
    if ('href' in anchor && typeof anchor.href === 'string') return anchor.href;
    return anchor.getAttribute('href') || '';
  };

  const readAnchorText = (anchor) => {
    if ('innerText' in anchor && typeof anchor.innerText === 'string' && anchor.innerText.trim()) return anchor.innerText;
    return anchor.textContent || anchor.getAttribute('aria-label') || '';
  };

  const findNearestAnchor = (event) => {
    const candidates = [event.target];
    if (typeof event.composedPath === 'function') {
      for (const node of event.composedPath()) candidates.push(node);
    }
    if (
      Number.isFinite(event.clientX) &&
      Number.isFinite(event.clientY) &&
      typeof document.elementFromPoint === 'function'
    ) {
      candidates.push(document.elementFromPoint(event.clientX, event.clientY));
    }

    for (const candidate of candidates) {
      if (!isClosestCapableTarget(candidate)) continue;
      try {
        const anchor = candidate.closest('a[href]');
        if (anchor) return anchor;
      } catch {
        // Ignore cross-realm access errors and continue scanning candidates.
      }
    }
    return null;
  };

  const extractCreateTaskFromLinkPayload = (event) => {
    if (!event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey) return null;
    if (event.button !== 0) return null;

    const anchor = findNearestAnchor(event);
    if (!anchor) return null;

    let href = '';
    try {
      href = readAnchorHref(anchor);
    } catch {
      return null;
    }
    if (!/^https?:\\/\\//i.test(href)) return null;

    let linkText = '';
    try {
      linkText = readAnchorText(anchor);
    } catch {
      linkText = '';
    }

    return {
      url: href,
      linkText: linkText.replace(/\\s+/g, ' ').trim() || undefined,
    };
  };

  let lastForwardedSignature = '';
  let lastForwardedAt = 0;
  const forwardPayload = (payload) => {
    const signature = payload.url + '::' + (payload.linkText || '');
    const now = Date.now();
    if (signature === lastForwardedSignature && now - lastForwardedAt < 750) return;
    lastForwardedSignature = signature;
    lastForwardedAt = now;

    const bridge = bridgeWindow[bridgeKey];
    if (typeof bridge === 'function') {
      bridge(payload);
    }
  };

  const onMouse = (event) => {
    const payload = extractCreateTaskFromLinkPayload(event);
    if (!payload) return;

    // Chromium can decide modifier-based link actions on mouse down.
    // Prevent here so Alt+Shift+Click never escapes into a new BrowserWindow.
    event.preventDefault();
    event.stopPropagation();
    forwardPayload(payload);
  };

  document.addEventListener('mousedown', onMouse, true);
  document.addEventListener('click', onMouse, true);
  bridgeWindow[installedKey] = document;
})();
`

export function buildBrowserCreateTaskFromLinkCaptureScript(bridgeKey: string, installedKey: string): string {
  return BROWSER_CREATE_TASK_FROM_LINK_CAPTURE_SCRIPT_TEMPLATE
    .replace('__SLZ_BRIDGE_KEY__', JSON.stringify(bridgeKey))
    .replace('__SLZ_INSTALLED_KEY__', JSON.stringify(installedKey))
}
