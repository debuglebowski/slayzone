/**
 * The main-process side of the renderer's direct link (docs/direct-link.md): a
 * socket is only attempted when this document's CSP allows it AND main's HTTP probe
 * reaches the computer — so the renderer never opens a WebSocket that fails.
 */
import { describe, expect, it } from 'vitest'
import { createDirectLinkGate } from './direct-link-gate'

function setup(
  reachable = true,
  issuedByHub: Record<string, string[]> = { h1: ['box.example:7443'] }
) {
  const probed: string[] = []
  const asked: Array<[string, string]> = []
  const gate = createDirectLinkGate({
    probe: async (url) => {
      probed.push(url)
      return reachable
    },
    issuedByHub: async (hubId) => {
      asked.push([hubId, ''])
      if (!(hubId in issuedByHub)) throw new Error('unknown hub')
      return issuedByHub[hubId] ?? []
    }
  })
  return { gate, probed, asked }
}

describe('direct-link gate', () => {
  it('allows the local computer’s loopback listener in a document whose CSP has the local hub', async () => {
    const { gate, probed } = setup()
    gate.recordApplied(1, 'ws://127.0.0.1:* wss://hub.example')
    expect(await gate.prepare(1, 'h1', '127.0.0.1:5001')).toEqual({ ok: true })
    expect(probed).toEqual(['http://127.0.0.1:5001/direct/v1/health'])
  })

  it('refuses loopback where the document has no local hub entry, without probing', async () => {
    const { gate, probed } = setup()
    gate.recordApplied(1, 'wss://hub.example')
    expect(await gate.prepare(1, 'h1', '127.0.0.1:5001')).toEqual({ ok: false, reason: 'csp' })
    expect(await gate.prepare(2, 'h1', '127.0.0.1:5001')).toEqual({ ok: false, reason: 'csp' })
    expect(probed).toEqual([])
  })

  it('names a newly issued public address in the NEXT document’s CSP, relaying until then', async () => {
    const { gate, probed } = setup()
    gate.recordApplied(1, 'ws://127.0.0.1:*')
    expect(await gate.prepare(1, 'h1', 'box.example:7443')).toEqual({ ok: false, reason: 'csp' })
    expect(gate.connectSources()).toEqual(['wss://box.example:7443'])
    gate.recordApplied(1, `ws://127.0.0.1:* ${gate.connectSources().join(' ')}`)
    expect(await gate.prepare(1, 'h1', 'box.example:7443')).toEqual({ ok: true })
    expect(probed).toEqual(['https://box.example:7443/direct/v1/health'])
  })

  it('reports an unreachable computer', async () => {
    const { gate } = setup(false)
    gate.recordApplied(1, 'ws://127.0.0.1:*')
    expect(await gate.prepare(1, 'h1', '127.0.0.1:5001')).toEqual({
      ok: false,
      reason: 'unreachable'
    })
  })

  it('refuses a value that is not a bare authority, and never lists it', async () => {
    const { gate, probed } = setup()
    gate.recordApplied(1, 'ws://127.0.0.1:*')
    for (const bad of ['ws://box:1', 'box:1/x', '*', '']) {
      expect(await gate.prepare(1, 'h1', bad)).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(gate.connectSources()).toEqual([])
    expect(probed).toEqual([])
  })

  it('names a public address only once the renderer’s hub confirms it issued it (fail closed)', async () => {
    const { gate, probed } = setup(true, { h1: ['box.example:7443'], h2: [] })
    gate.recordApplied(1, 'ws://127.0.0.1:*')
    // A renderer reporting an address no hub issued never opens the CSP to it.
    expect(await gate.prepare(1, 'h1', 'evil.example:8443')).toEqual({
      ok: false,
      reason: 'not-issued'
    })
    expect(await gate.prepare(1, 'h2', 'box.example:7443')).toEqual({
      ok: false,
      reason: 'not-issued'
    })
    // The hub cannot be asked (unknown, offline): refused.
    expect(await gate.prepare(1, 'nope', 'box.example:7443')).toEqual({
      ok: false,
      reason: 'not-issued'
    })
    expect(gate.connectSources()).toEqual([])
    expect(await gate.prepare(1, 'h1', 'box.example:7443')).toEqual({ ok: false, reason: 'csp' })
    expect(gate.connectSources()).toEqual(['wss://box.example:7443'])
    expect(probed).toEqual([])
  })

  it('keeps a bounded set of issued origins', async () => {
    const many = Array.from({ length: 100 }, (_, i) => `box${i}.example:1`)
    const { gate } = setup(true, { h1: many })
    gate.recordApplied(1, 'ws://127.0.0.1:*')
    for (const a of many) await gate.prepare(1, 'h1', a)
    expect(gate.connectSources().length).toBeLessThanOrEqual(32)
    expect(gate.connectSources()).toContain('wss://box99.example:1')
  })
})
