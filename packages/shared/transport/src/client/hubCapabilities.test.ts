/**
 * `hubAllows` — may THIS connection call a procedure on a hub? (#164)
 *
 * A web session (scopes `read`, `tasks`, `agent`) mounts the whole renderer, which
 * pushed `pty.warmSetProjectTabCounts` on every tab change and was refused each time,
 * one `authz.denied` line per push. The hub reports the caller's scopes in
 * `hub.describe`; the client asks once and skips what the scope gate would refuse.
 */
import { describe, expect, it, vi } from 'vitest'
import { hubAllows, hubPermitsTelemetry } from './hubCapabilities'
import type { RuntimeClient } from './runtime'

function fakeClient(
  describe: () => Promise<{
    scopes?: string[] | null
    switches?: { enableTelemetry?: boolean }
  }>
) {
  const query = vi.fn(describe)
  return { client: { hub: { describe: { query } } } as unknown as RuntimeClient, query }
}

describe('hubAllows', () => {
  it('a web session may not push warm-pool counts, but may read settings', async () => {
    const { client } = fakeClient(async () => ({ scopes: ['read', 'tasks', 'agent'] }))
    expect(await hubAllows(client, 'pty.warmSetProjectTabCounts')).toBe(false)
    expect(await hubAllows(client, 'settings.get')).toBe(true)
  })

  it('a full principal may call anything', async () => {
    const { client } = fakeClient(async () => ({ scopes: ['full'] }))
    expect(await hubAllows(client, 'pty.warmSetProjectTabCounts')).toBe(true)
  })

  it('no principal (a hub without login) is unrestricted', async () => {
    const { client } = fakeClient(async () => ({ scopes: null }))
    expect(await hubAllows(client, 'pty.warmSetProjectTabCounts')).toBe(true)
  })

  it('a hub older than the field is unrestricted, as before', async () => {
    const { client } = fakeClient(async () => ({}))
    expect(await hubAllows(client, 'pty.warmSetProjectTabCounts')).toBe(true)
  })

  it('asks the hub once per client', async () => {
    const { client, query } = fakeClient(async () => ({ scopes: ['read'] }))
    await hubAllows(client, 'pty.warmSetProjectTabCounts')
    await hubAllows(client, 'settings.get')
    expect(query).toHaveBeenCalledTimes(1)
  })

  it('a failed describe is not remembered: allowed now, asked again next time', async () => {
    let calls = 0
    const { client, query } = fakeClient(async () => {
      calls += 1
      if (calls === 1) throw new Error('hub down')
      return { scopes: ['read'] }
    })
    expect(await hubAllows(client, 'pty.warmSetProjectTabCounts')).toBe(true)
    expect(await hubAllows(client, 'pty.warmSetProjectTabCounts')).toBe(false)
    expect(query).toHaveBeenCalledTimes(2)
  })
})

/**
 * `hubPermitsTelemetry` — `SLAYZONE_HUB_ENABLE_TELEMETRY` as the hub reports it in
 * `hub.describe`. Fails closed: no answer, no telemetry.
 */
describe('hubPermitsTelemetry', () => {
  it('a hub with telemetry off forbids it', async () => {
    const { client } = fakeClient(async () => ({ switches: { enableTelemetry: false } }))
    expect(await hubPermitsTelemetry(client)).toBe(false)
  })

  it('a hub with telemetry on permits it', async () => {
    const { client } = fakeClient(async () => ({ switches: { enableTelemetry: true } }))
    expect(await hubPermitsTelemetry(client)).toBe(true)
  })

  it('a hub older than the switch permits it (it cannot turn it off)', async () => {
    const { client } = fakeClient(async () => ({ scopes: null }))
    expect(await hubPermitsTelemetry(client)).toBe(true)
  })

  it('a hub that cannot be asked forbids it, and is asked again next time', async () => {
    let calls = 0
    const { client, query } = fakeClient(async () => {
      calls += 1
      if (calls === 1) throw new Error('hub down')
      return { switches: { enableTelemetry: true } }
    })
    expect(await hubPermitsTelemetry(client)).toBe(false)
    expect(await hubPermitsTelemetry(client)).toBe(true)
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('shares the one describe answer with hubAllows', async () => {
    const { client, query } = fakeClient(async () => ({
      scopes: ['read'],
      switches: { enableTelemetry: false }
    }))
    expect(await hubAllows(client, 'settings.get')).toBe(true)
    expect(await hubPermitsTelemetry(client)).toBe(false)
    expect(query).toHaveBeenCalledTimes(1)
  })
})
