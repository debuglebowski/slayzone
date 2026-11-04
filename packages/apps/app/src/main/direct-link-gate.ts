/**
 * Main-process gate for the renderer's direct links (docs/direct-link.md).
 *
 * Two reasons this lives in main and not in the renderer:
 *  - **The probe.** Chromium throttles every new WebSocket a renderer opens by
 *    that renderer's recent FAILED connects, the hub's socket included. So the
 *    renderer opens a direct socket only after main's plain-HTTP probe reached the
 *    computer, and `connect-src` never needs an `http(s)` entry.
 *  - **The CSP.** A document's `connect-src` is fixed when it loads. A socket the
 *    CSP would block is never attempted. A newly issued public address joins the
 *    header from the next document load, and until then the terminal uses the
 *    relay. Only exact `wss://` origins of addresses a hub issued are ever added
 *    (`directLinkConnectSources`). Loopback adds nothing: the local hub's
 *    `ws://127.0.0.1:*` already covers the local computer.
 */
import { directLinkConnectSources } from './renderer-csp'

const HEALTH_PATH = '/direct/v1/health'
const LOOPBACK_ENTRY = 'ws://127.0.0.1:*'

export type DirectLinkPrepareResult =
  | { ok: true }
  | { ok: false; reason: 'invalid' | 'csp' | 'unreachable' }

export interface DirectLinkGate {
  /** `connect-src` entries for the next document load. */
  connectSources(): string[]
  /** What `connect-src` a webContents' document was given. */
  recordApplied(webContentsId: number, connectSrc: string): void
  /** May this webContents open a socket to `address` now? */
  prepare(webContentsId: number, address: string): Promise<DirectLinkPrepareResult>
}

export async function probeDirectHealth(url: string, deadlineMs = 3_000): Promise<boolean> {
  const abort = new AbortController()
  const timer = setTimeout(() => abort.abort(), deadlineMs)
  try {
    const res = await fetch(url, { signal: abort.signal, cache: 'no-store' })
    return res.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export function createDirectLinkGate(
  deps: { probe?: (url: string) => Promise<boolean> } = {}
): DirectLinkGate {
  const probe = deps.probe ?? ((url: string) => probeDirectHealth(url))
  const issued = new Set<string>()
  const applied = new Map<number, Set<string>>()

  return {
    connectSources: () => directLinkConnectSources([...issued]),
    recordApplied(webContentsId, connectSrc) {
      applied.set(webContentsId, new Set(connectSrc.split(/\s+/).filter(Boolean)))
    },
    async prepare(webContentsId, address) {
      if (typeof address !== 'string' || address === '' || /[\s/*]/.test(address) || address.includes('://'))
        return { ok: false, reason: 'invalid' }
      let host: string
      try {
        const u = new URL(`http://${address}`)
        if (u.host !== address || u.username !== '' || u.password !== '')
          return { ok: false, reason: 'invalid' }
        host = u.hostname
      } catch {
        return { ok: false, reason: 'invalid' }
      }
      const sources = applied.get(webContentsId) ?? new Set<string>()
      const loopback = host === '127.0.0.1'
      if (loopback) {
        if (!sources.has(LOOPBACK_ENTRY)) return { ok: false, reason: 'csp' }
      } else {
        const [origin] = directLinkConnectSources([address])
        if (!origin) return { ok: false, reason: 'invalid' }
        if (!sources.has(origin)) {
          issued.add(address)
          return { ok: false, reason: 'csp' }
        }
      }
      const url = `${loopback ? 'http' : 'https'}://${address}${HEALTH_PATH}`
      return (await probe(url)) ? { ok: true } : { ok: false, reason: 'unreachable' }
    }
  }
}
