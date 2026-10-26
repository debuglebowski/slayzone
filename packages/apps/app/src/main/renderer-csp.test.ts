import { describe, expect, it } from 'vitest'
import { buildCspFloor, buildRendererCsp, hubConnectSources } from './renderer-csp'

describe('buildRendererCsp', () => {
  it('names the tRPC WS origin exactly when one is known', () => {
    const csp = buildRendererCsp('ws://127.0.0.1:52354', false)
    expect(csp).toContain('connect-src')
    expect(csp).toContain('ws://127.0.0.1:52354')
    // Exact origin — never the scheme-wide floor.
    expect(csp).not.toContain('ws: wss:')
  })

  it('supports a remote ws(s) origin (slice 7 remote mode)', () => {
    const csp = buildRendererCsp('wss://backend.example.com:4400', false)
    expect(csp).toContain('wss://backend.example.com:4400')
    expect(csp).not.toContain('ws://127.0.0.1')
  })

  it('omits the tRPC origin when it is unknown', () => {
    const csp = buildRendererCsp('', false)
    expect(csp).not.toContain('ws://127.0.0.1')
    // Policy is still emitted in full so the document is never left without a CSP.
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain('connect-src')
  })

  it('keeps the fixed remote origins regardless of the tRPC origin', () => {
    const csp = buildRendererCsp('ws://127.0.0.1:40000', false)
    for (const origin of [
      'https://*.posthog.com',
      'wss://*.convex.cloud',
      'https://api.github.com'
    ]) {
      expect(csp).toContain(origin)
    }
  })

  it('emits all static directives', () => {
    const csp = buildRendererCsp('ws://127.0.0.1:40000', false)
    for (const directive of [
      "default-src 'self'",
      "script-src 'self'",
      "worker-src 'self' blob:",
      "frame-src 'self' slz-file:",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https: slz-file:"
    ]) {
      expect(csp).toContain(directive)
    }
  })

  it("locks script-src to 'self' in production — no inline, no eval", () => {
    const csp = buildRendererCsp('ws://127.0.0.1:40000', false)
    expect(csp).toContain("script-src 'self';")
    expect(csp).not.toContain("'unsafe-inline' 'unsafe-eval'")
  })

  it('relaxes script-src in dev so Vite can inject its inline Fast Refresh preamble', () => {
    const csp = buildRendererCsp('ws://127.0.0.1:40000', true)
    expect(csp).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
  })
})

describe('buildCspFloor', () => {
  it('allows local loopback (any port) and TLS-only remote', () => {
    const floor = buildCspFloor(false)
    expect(floor).toContain('ws://127.0.0.1:*')
    expect(floor).toContain('wss:')
  })

  it('allows plaintext ws to every loopback NAME the hub scheme rule treats as local', () => {
    // hubUrlFromAddr: 127.0.0.1 / localhost → ws. A hub registered as
    // ws://localhost:<port> must not be blocked by the floor (the runtime
    // header names it exactly; the two are intersected).
    const src = buildCspFloor(false)
      .split('; ')
      .find((d) => d.startsWith('connect-src'))!
      .split(/\s+/)
    expect(src).toContain('ws://localhost:*')
  })

  it('does NOT permit arbitrary plaintext ws to any host', () => {
    // The floor governs only when the exact runtime header is absent — it must
    // not become an arbitrary-host plaintext-ws exfil channel in that fallback.
    const connectSrc = buildCspFloor(false)
      .split('; ')
      .find((d) => d.startsWith('connect-src'))!
    // No bare `ws:` token (which would match any ws:// host). The only ws entry
    // is the loopback wildcard.
    expect(connectSrc.split(/\s+/)).not.toContain('ws:')
  })

  it('shares the static directives and remote origins with the runtime CSP', () => {
    // Floor and runtime policy differ only in the tRPC connect-src entry.
    expect(
      buildCspFloor(false).replace('ws://127.0.0.1:* ws://localhost:* wss:', 'ws://127.0.0.1:52354')
    ).toBe(buildRendererCsp('ws://127.0.0.1:52354', false))
  })

  it('carries the dev script-src relaxation through to the meta-tag floor', () => {
    expect(buildCspFloor(true)).toContain("script-src 'self' 'unsafe-inline' 'unsafe-eval'")
    expect(buildCspFloor(false)).toContain("script-src 'self';")
  })
})

describe('hubConnectSources', () => {
  it('allows the local loopback hub on any port', () => {
    expect(hubConnectSources({ localHub: true, remoteHubUrls: [] })).toBe('ws://127.0.0.1:*')
  })

  it('names every registered remote hub exactly, alongside the local hub (#161)', () => {
    const src = hubConnectSources({
      localHub: true,
      remoteHubUrls: ['wss://hub-a.example.com/trpc', 'wss://hub-b.example.com:8443/trpc']
    }).split(' ')
    expect(src).toContain('ws://127.0.0.1:*')
    expect(src).toContain('wss://hub-a.example.com')
    expect(src).toContain('wss://hub-b.example.com:8443')
    // No scheme-wide or host-wildcard entry — unrelated origins stay blocked.
    expect(src).not.toContain('wss:')
    expect(src.some((s) => s.includes('*.') || s === '*')).toBe(false)
  })

  it("also allows each hub's HTTP(S) origin (same trusted host)", () => {
    const src = hubConnectSources({
      localHub: false,
      remoteHubUrls: ['wss://hub.example.com/trpc', 'ws://10.0.0.5:4400/trpc']
    }).split(' ')
    expect(src).toContain('https://hub.example.com')
    expect(src).toContain('ws://10.0.0.5:4400')
    expect(src).toContain('http://10.0.0.5:4400')
    expect(src).not.toContain('ws://127.0.0.1:*')
  })

  it('drops malformed / non-ws urls and de-duplicates', () => {
    const src = hubConnectSources({
      localHub: false,
      remoteHubUrls: [
        'not a url',
        'javascript:alert(1)',
        'wss://h.example.com/trpc',
        'wss://h.example.com/other'
      ]
    })
    expect(src).toBe('wss://h.example.com https://h.example.com')
  })

  it('feeds buildRendererCsp so multiple hubs land in connect-src', () => {
    const csp = buildRendererCsp(
      hubConnectSources({ localHub: true, remoteHubUrls: ['wss://hub.example.com/trpc'] }),
      false
    )
    const connectSrc = csp.split('; ').find((d) => d.startsWith('connect-src'))!
    expect(connectSrc).toContain('ws://127.0.0.1:* wss://hub.example.com https://hub.example.com')
  })
})
