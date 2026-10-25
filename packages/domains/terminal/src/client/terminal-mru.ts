/**
 * Most-recently-used order of terminal sessions (by "was on screen").
 *
 * Two consumers: the boot-time init queue (hidden terminals initialise in MRU
 * order, so the tabs the user is likeliest to open next are ready first) and the
 * WebGL budget (evicts the least recently used off-screen renderer). Persisted
 * in localStorage so the order survives a renderer reload — the boot is exactly
 * when it is needed and the in-memory order would be empty. Storage failures
 * degrade to in-memory only.
 */

const STORAGE_KEY = 'slayzone:terminal-mru'
/** Sessions remembered — far more than anyone keeps open. */
const CAP = 200
const PERSIST_DELAY_MS = 1000

function load(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    const parsed: unknown = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

let order: string[] = load()
let persistTimer: ReturnType<typeof setTimeout> | null = null

function persist(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(() => {
    persistTimer = null
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(order))
    } catch {
      /* storage unavailable — in-memory order still serves this session */
    }
  }, PERSIST_DELAY_MS)
}

/** Record that `sessionId` is on screen now (moves it to the front). */
export function touchTerminalMru(sessionId: string): void {
  if (order[0] === sessionId) return
  const i = order.indexOf(sessionId)
  if (i >= 0) order.splice(i, 1)
  order.unshift(sessionId)
  if (order.length > CAP) order.length = CAP
  persist()
}

/** 0 = most recent. Sessions never seen rank after every known one. */
export function mruRank(sessionId: string): number {
  const i = order.indexOf(sessionId)
  return i < 0 ? Number.MAX_SAFE_INTEGER : i
}

/** Test seam. */
export function __setTerminalMruForTest(next: string[]): void {
  order = [...next]
}
