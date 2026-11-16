/**
 * Network facts the browser panel's guards share (hub, Electron main, renderer).
 *
 * Pure and dependency-free: the lean `@slayzone/platform/browser-network` subpath,
 * safe in renderer bundles.
 */

/**
 * Electron main adds this header to EVERY request a browser-panel / web-panel page
 * makes (`webRequest.onBeforeSendHeaders`, which page script cannot undo). A hub
 * refuses any request carrying it: no page inside SlayZone's own browser may drive a
 * hub's API — that is the loopback pivot (a remote caller loading the desktop's local
 * hub into the panel and running script there).
 */
export const BROWSER_PANEL_REQUEST_HEADER = 'x-slayzone-browser-panel'

function parseV4(s: string): number[] | null {
  const parts = s.split('.')
  if (parts.length !== 4) return null
  const out: number[] = []
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null
    const n = Number(p)
    if (n > 255) return null
    out.push(n)
  }
  return out
}

function v4NonPublic([a, b]: number[]): boolean {
  return (
    a === 0 || // "this network", 0.0.0.0
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // CGNAT
    (a === 169 && b === 254) || // link-local
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 // multicast + reserved
  )
}

/**
 * True for an IP literal that is not on the public internet: loopback, unspecified,
 * private (RFC 1918 / ULA), link-local, CGNAT, multicast; IPv4-mapped IPv6 included.
 * Not an IP literal → false (a hostname is judged by {@link isNonPublicHostname} and,
 * where possible, by resolving it).
 */
export function isNonPublicIp(raw: string): boolean {
  const ip = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  const v4 = parseV4(ip)
  if (v4) return v4NonPublic(v4)
  if (!ip.includes(':')) return false
  const lower = ip.toLowerCase()
  const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
  if (mapped) {
    const m = parseV4(mapped[1])
    return m ? v4NonPublic(m) : true
  }
  if (lower === '::' || lower === '::1') return true
  const first = lower.split(':')[0] ?? ''
  const head = first === '' ? 0 : Number.parseInt(first, 16)
  if (Number.isNaN(head)) return true
  return (
    (head & 0xfe00) === 0xfc00 || // fc00::/7 ULA
    (head & 0xffc0) === 0xfe80 || // fe80::/10 link-local
    (head & 0xff00) === 0xff00 // multicast
  )
}

/**
 * True when a hostname, by its NAME alone, points at this machine or the local
 * network: an IP literal that {@link isNonPublicIp} rejects, `localhost`,
 * `*.localhost`, `*.local` (mDNS). A public-looking name can still resolve to a
 * private address — resolve it too where a resolver exists (Electron main).
 */
export function isNonPublicHostname(raw: string): boolean {
  const host = raw.toLowerCase().replace(/\.$/, '')
  if (isNonPublicIp(host)) return true
  return (
    host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === ''
  )
}
