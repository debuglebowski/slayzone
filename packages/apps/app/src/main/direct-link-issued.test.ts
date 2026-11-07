/**
 * What Electron main asks a hub before its renderer's CSP may name a direct address
 * (direct-link-gate.ts): the hub's own list of the addresses it issued to this client.
 */
import { describe, expect, it } from 'vitest'
import type { HubTransport } from '@slayzone/hub-auth/client'
import { fetchIssuedDirectAddresses } from './direct-link-issued'

function transport(status: number, text: string, seen: unknown[] = []): HubTransport {
  return (async (req) => {
    seen.push(req)
    return { status, text, header: () => null }
  }) as HubTransport
}

describe('issued direct addresses (main → hub)', () => {
  it('asks the hub with the bearer and returns exactly the addresses it names', async () => {
    const seen: Array<{ url: string; method: string; headers: Record<string, string> }> = []
    const out = await fetchIssuedDirectAddresses(
      'https://hub.example',
      'tok',
      transport(200, JSON.stringify({ addresses: ['box.example:7443', 5, ''] }), seen)
    )
    expect(out).toEqual(['box.example:7443'])
    expect(seen[0]).toMatchObject({
      method: 'GET',
      url: 'https://hub.example/api/computers/direct-addresses',
      headers: { authorization: 'Bearer tok' }
    })
  })

  it('sends no authorization without a bearer (the desktop hub)', async () => {
    const seen: Array<{ headers: Record<string, string> }> = []
    await fetchIssuedDirectAddresses(
      'http://127.0.0.1:1',
      null,
      transport(200, '{"addresses":[]}', seen)
    )
    expect(seen[0]?.headers.authorization).toBeUndefined()
  })

  it('fails closed: refusal, an old hub without the route, or a bad body name nothing', async () => {
    for (const [status, text] of [
      [401, '{}'],
      [404, 'Not found'],
      [200, 'not json'],
      [200, '{"addresses":"box.example:1"}']
    ] as const) {
      expect(await fetchIssuedDirectAddresses('https://h', 't', transport(status, text))).toEqual(
        []
      )
    }
  })
})
