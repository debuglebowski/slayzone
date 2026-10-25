/**
 * Keys typed between the user asking for a new terminal (Cmd+Shift+N) and that
 * terminal's xterm existing. Focus has nowhere to go in that window — the previous
 * terminal is blurred on purpose (its agent must not get them), the new xterm is
 * not there yet — so a capture-phase listener holds them, and the new terminal's
 * init takes them (`takeEarlyInput`) the moment it focuses its xterm, in the same
 * synchronous block that wires its input, so no key is dropped or doubled.
 */

export interface EarlyKey {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing: boolean
}

const NAMED: Record<string, string> = {
  Enter: '\r',
  Backspace: '\x7f',
  Tab: '\t',
  Escape: '\x1b',
  ArrowUp: '\x1b[A',
  ArrowDown: '\x1b[B',
  ArrowRight: '\x1b[C',
  ArrowLeft: '\x1b[D'
}

/** The bytes a terminal sends for this key, or null for keys left to the app. */
export function keyToTerminalData(e: EarlyKey): string | null {
  if (e.metaKey || e.isComposing) return null
  if (e.ctrlKey) {
    return /^[a-z]$/i.test(e.key)
      ? String.fromCharCode(e.key.toLowerCase().charCodeAt(0) - 96)
      : null
  }
  if (e.key.length === 1) return e.key
  return NAMED[e.key] ?? null
}

/** How long a capture waits for its terminal before discarding what it holds. */
export const EARLY_INPUT_TTL_MS = 3000

export interface EarlyInputHandle {
  /** The terminal session the held keys are for (known once its task exists). */
  bind(sessionId: string): void
  /** No terminal is coming (create failed): discard and stop capturing. */
  cancel(): void
}

export interface EarlyInputCapture {
  start(): EarlyInputHandle
  /** A keydown while capturing: true when it was taken (caller suppresses it). */
  onKey(e: EarlyKey): boolean
  /** The held keys for `sessionId` (ends the capture), or '' when none. */
  take(sessionId: string): string
  /** Whether keys are being held for a terminal that does not exist yet. */
  capturing(): boolean
}

export function createEarlyInputCapture(env: {
  now: () => number
  ttlMs: number
}): EarlyInputCapture {
  let active: { buf: string; sessionId: string | null; at: number } | null = null
  const live = (): boolean => {
    if (active && env.now() - active.at > env.ttlMs) active = null
    return active !== null
  }
  return {
    start() {
      const own = { buf: '', sessionId: null as string | null, at: env.now() }
      active = own
      return {
        bind(sessionId) {
          own.sessionId = sessionId
        },
        cancel() {
          if (active === own) active = null
        }
      }
    },
    onKey(e) {
      if (!live()) return false
      const data = keyToTerminalData(e)
      if (data === null) return false
      active!.buf += data
      return true
    },
    take(sessionId) {
      if (!live() || active!.sessionId !== sessionId) return ''
      const buf = active!.buf
      active = null
      return buf
    },
    capturing: live
  }
}

const capture = createEarlyInputCapture({
  now: () => performance.now(),
  ttlMs: EARLY_INPUT_TTL_MS
})
let listening = false

/**
 * Start holding keystrokes for a terminal about to be created. Keys are taken only
 * while nothing has focus (the page body) — a click into any field ends the window.
 */
export function startEarlyInputCapture(): EarlyInputHandle {
  if (!listening && typeof window !== 'undefined') {
    listening = true
    window.addEventListener(
      'keydown',
      (e) => {
        const focused = document.activeElement
        if (focused && focused !== document.body) return
        if (capture.onKey(e)) {
          e.preventDefault()
          e.stopPropagation()
        }
      },
      { capture: true }
    )
  }
  return capture.start()
}

/**
 * Focus is reserved for a terminal about to be created: nothing else may reclaim
 * it (the focus self-heal would hand the keys back to the previous terminal).
 */
export function isEarlyInputCapturing(): boolean {
  return capture.capturing()
}

/** Called by a terminal as it takes focus: the keys held for its session. */
export function takeEarlyInput(sessionId: string): string {
  return capture.take(sessionId)
}
