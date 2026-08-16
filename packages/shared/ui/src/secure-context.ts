/**
 * Secure-context guards for browser APIs that throw or are undefined outside
 * `https://` (or `localhost`) — `crypto.randomUUID` and the async Clipboard
 * API. Neither degrades gracefully on its own, and the web shell
 * (`packages/apps/web-shell`) is the first consumer of this renderer tree
 * that can legitimately be reached over plain `http://` (a LAN IP during
 * development, or an operator's own un-terminated reverse proxy). Every call
 * site should route through here rather than calling the raw API directly.
 */

let fallbackUuidCounter = 0

/**
 * `crypto.randomUUID()`, guarded. Falls back to a counter-based id (never
 * colliding within one page's life, which is all any of these call sites
 * need — none persist a client-generated id as a durable primary key across
 * reloads) instead of throwing on a non-secure origin.
 */
export function safeRandomUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  fallbackUuidCounter += 1
  return `insecure-ctx-${Date.now()}-${fallbackUuidCounter}`
}

function hasAsyncClipboardWrite(): boolean {
  return (
    typeof navigator !== 'undefined' &&
    typeof navigator.clipboard !== 'undefined' &&
    typeof navigator.clipboard.writeText === 'function'
  )
}

/**
 * Legacy fallback: a temporary offscreen textarea + `document.execCommand`.
 * Deprecated, but still the only copy path outside a secure context — and
 * unlike the async Clipboard API it doesn't need one.
 */
function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined') return false
  const el = document.createElement('textarea')
  el.value = text
  el.style.position = 'fixed'
  el.style.opacity = '0'
  document.body.appendChild(el)
  el.focus()
  el.select()
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  document.body.removeChild(el)
  return ok
}

/**
 * Copy text to the clipboard. Returns whether it actually succeeded — every
 * call site already either awaits this or fires-and-forgets, and now gets an
 * honest answer instead of an unhandled rejection when the async Clipboard
 * API is unavailable.
 */
export async function safeClipboardWriteText(text: string): Promise<boolean> {
  if (hasAsyncClipboardWrite()) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      return legacyCopy(text)
    }
  }
  return legacyCopy(text)
}

/**
 * Read text from the clipboard. `null` when unsupported — there is no
 * legacy fallback for a programmatic READ (the `execCommand` trick only
 * fires from a real user paste event, not on demand), so a non-secure-context
 * caller gets a clean "nothing to paste" instead of a thrown error.
 */
export async function safeClipboardReadText(): Promise<string | null> {
  if (
    typeof navigator === 'undefined' ||
    typeof navigator.clipboard === 'undefined' ||
    typeof navigator.clipboard.readText !== 'function'
  ) {
    return null
  }
  try {
    return await navigator.clipboard.readText()
  } catch {
    return null
  }
}
