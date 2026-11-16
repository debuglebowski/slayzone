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

/** WHATWG-style IPv4 number part: decimal, `0x` hex or leading-`0` octal. */
function v4Part(p: string): number | null {
  if (p === '') return null
  let n: number
  if (/^0x[0-9a-f]*$/i.test(p)) n = p.length === 2 ? 0 : Number.parseInt(p.slice(2), 16)
  else if (/^0[0-7]+$/.test(p)) n = Number.parseInt(p.slice(1), 8)
  else if (/^(0|[1-9]\d*)$/.test(p)) n = Number(p)
  else return null
  return Number.isSafeInteger(n) ? n : null
}

/** IPv4 in every form a URL or resolver may give: `a.b.c.d`, `a.b.c`, `a.b`, `a`, each
 *  part decimal, octal or hex (WHATWG host parsing). */
function parseV4(s: string): Uint8Array | null {
  const raw = s.endsWith('.') ? s.slice(0, -1) : s
  const parts = raw.split('.')
  if (parts.length < 1 || parts.length > 4) return null
  const nums: number[] = []
  for (const p of parts) {
    const n = v4Part(p)
    if (n === null) return null
    nums.push(n)
  }
  const last = nums[nums.length - 1]
  for (let i = 0; i < nums.length - 1; i++) if (nums[i] > 255) return null
  if (last >= 256 ** (5 - nums.length)) return null
  let value = last
  for (let i = 0; i < nums.length - 1; i++) value += nums[i] * 256 ** (3 - i)
  return new Uint8Array([
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255
  ])
}

/** IPv6 (with `::`, an embedded dotted IPv4 tail, brackets and a zone id) to 16 bytes. */
function parseV6(s: string): Uint8Array | null {
  let t = s.startsWith('[') && s.endsWith(']') ? s.slice(1, -1) : s
  const zone = t.indexOf('%')
  if (zone >= 0) t = t.slice(0, zone)
  if (!t.includes(':')) return null
  const halves = t.split('::')
  if (halves.length > 2) return null
  const words = (part: string): number[] | null => {
    if (part === '') return []
    const out: number[] = []
    const groups = part.split(':')
    for (let i = 0; i < groups.length; i++) {
      const g = groups[i]
      if (i === groups.length - 1 && g.includes('.')) {
        if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(g)) return null
        const v4 = parseV4(g)
        if (!v4) return null
        out.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
      out.push(Number.parseInt(g, 16))
    }
    return out
  }
  const head = words(halves[0])
  const tail = halves.length === 2 ? words(halves[1]) : []
  if (!head || !tail) return null
  let all: number[]
  if (halves.length === 2) {
    const fill = 8 - head.length - tail.length
    if (fill < 1) return null
    all = [...head, ...new Array<number>(fill).fill(0), ...tail]
  } else {
    all = head
  }
  if (all.length !== 8) return null
  const bytes = new Uint8Array(16)
  all.forEach((w, i) => {
    bytes[i * 2] = w >> 8
    bytes[i * 2 + 1] = w & 255
  })
  return bytes
}

/**
 * Parse an IP literal in ANY textual form to its bytes (4 for IPv4, 16 for IPv6), or
 * null when the text is not an IP literal. Every classification below runs on these
 * numbers, never on the text — so `::ffff:7f00:1`, `0x7f.1` and `2130706433` are
 * all 127.0.0.1.
 */
export function parseIp(raw: string): Uint8Array | null {
  const s = raw.trim()
  if (s === '') return null
  return s.includes(':') ? parseV6(s) : parseV4(s)
}

function v4NonPublic(b: Uint8Array): boolean {
  const [a, c] = [b[0], b[1]]
  return (
    a === 0 || // "this network"
    a === 10 ||
    a === 127 ||
    (a === 100 && c >= 64 && c <= 127) || // CGNAT
    (a === 169 && c === 254) || // link-local
    (a === 172 && c >= 16 && c <= 31) ||
    (a === 192 && c === 168) ||
    (a === 192 && c === 0 && b[2] === 0) || // IETF protocol assignments
    (a === 192 && c === 0 && b[2] === 2) || // TEST-NET-1
    (a === 198 && (c === 18 || c === 19)) || // benchmarking
    (a === 198 && c === 51 && b[2] === 100) || // TEST-NET-2
    (a === 203 && c === 0 && b[2] === 113) || // TEST-NET-3
    a >= 224 // multicast, reserved, broadcast
  )
}

function v6NonPublic(b: Uint8Array): boolean {
  const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0)
  const embedded = (at: number): Uint8Array => b.slice(at, at + 4)
  // ::/96 — unspecified, loopback and IPv4-compatible (deprecated): judge the IPv4.
  if (zeros(0, 12)) return v4NonPublic(embedded(12)) || zeros(12, 15)
  // ::ffff:0:0/96 — IPv4-mapped.
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return v4NonPublic(embedded(12))
  // 64:ff9b::/96 — NAT64: judge the IPv4 it translates to.
  if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) {
    return v4NonPublic(embedded(12))
  }
  // 64:ff9b:1::/48 — local-use NAT64.
  if (
    b[0] === 0x00 &&
    b[1] === 0x64 &&
    b[2] === 0xff &&
    b[3] === 0x9b &&
    b[4] === 0 &&
    b[5] === 1
  ) {
    return true
  }
  // 2002::/16 — 6to4: judge the IPv4 in bytes 2-5.
  if (b[0] === 0x20 && b[1] === 0x02) return v4NonPublic(embedded(2))
  // 2001::/32 Teredo, 2001:db8::/32 documentation.
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x00 && b[3] === 0x00) return true
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true
  // 100::/64 discard.
  if (b[0] === 0x01 && b[1] === 0x00 && zeros(2, 8)) return true
  return (
    (b[0] & 0xfe) === 0xfc || // fc00::/7 ULA
    (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) || // fe80::/10 link-local
    (b[0] === 0xfe && (b[1] & 0xc0) === 0xc0) || // fec0::/10 site-local
    b[0] === 0xff // multicast
  )
}

/**
 * True for an IP literal (any textual form, see {@link parseIp}) that is not on the
 * public internet: loopback, unspecified, private (RFC 1918 / ULA), link-local,
 * site-local, CGNAT, multicast, documentation/benchmark ranges, and every IPv6 form
 * that embeds one of those IPv4 addresses (mapped, compatible, NAT64, 6to4). Not an IP
 * literal → false (a hostname is judged by {@link isNonPublicHostname} and, where
 * possible, by resolving it).
 */
export function isNonPublicIp(raw: string): boolean {
  const bytes = parseIp(raw)
  if (!bytes) return false
  return bytes.length === 4 ? v4NonPublic(bytes) : v6NonPublic(bytes)
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
