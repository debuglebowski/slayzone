import { describe, expect, it } from 'vitest'
import { RENDERER_CSP_FLOOR, buildRendererCsp } from './renderer-csp'

describe('buildRendererCsp', () => {
  it('names the tRPC WS origin exactly when a port is known', () => {
    const csp = buildRendererCsp(52354)
    expect(csp).toContain('connect-src')
    expect(csp).toContain('ws://127.0.0.1:52354')
    // Exact port — never a wildcard.
    expect(csp).not.toContain('ws://127.0.0.1:*')
  })

  it('omits the tRPC origin when the port is unknown', () => {
    for (const port of [0, undefined]) {
      const csp = buildRendererCsp(port)
      expect(csp).not.toContain('ws://127.0.0.1')
      // Policy is still emitted in full so the document is never left without a CSP.
      expect(csp).toContain("default-src 'self'")
      expect(csp).toContain('connect-src')
    }
  })

  it('keeps the fixed remote origins regardless of port', () => {
    const csp = buildRendererCsp(40000)
    for (const origin of [
      'https://*.posthog.com',
      'wss://*.convex.cloud',
      'https://api.github.com'
    ]) {
      expect(csp).toContain(origin)
    }
  })

  it('emits all static directives', () => {
    const csp = buildRendererCsp(40000)
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
})

describe('RENDERER_CSP_FLOOR', () => {
  it('allows the tRPC WS on any loopback port', () => {
    expect(RENDERER_CSP_FLOOR).toContain('ws://127.0.0.1:*')
  })

  it('shares the static directives and remote origins with the runtime CSP', () => {
    // Floor and runtime policy differ only in the tRPC connect-src entry.
    expect(RENDERER_CSP_FLOOR.replace('ws://127.0.0.1:*', 'ws://127.0.0.1:52354')).toBe(
      buildRendererCsp(52354)
    )
  })
})
