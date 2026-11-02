import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startSessionHost, hostControl, connectorHost, type ConnectorGrant } from './session-host'

it('keeps processes and session epoch when connector attaches are replaced', async () => {
  const root = mkdtempSync(join(tmpdir(), 'persistent-host-'))
  const hubUrl = 'ws://localhost:1/computers'
  const host = await startSessionHost(root, {
    hubUrl,
    name: 'test',
    allowedRoots: [root],
    capabilities: ['proc']
  })
  const control = await hostControl(root)
  try {
    const first = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl })
    const second = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl })
    expect(second.generation).toBeGreaterThan(first.generation)
    expect((await control.rpc.request<{ epoch: string }>('health')).epoch).toBe(host.epoch)
    await expect(
      connectorHost(root, { ...second, token: '0'.repeat(64) }, hubUrl, {})
    ).rejects.toThrow()
    expect((await control.rpc.request<{ epoch: string }>('health')).epoch).toBe(host.epoch)
    await expect(control.rpc.request('dispatch', {})).rejects.toThrow()
  } finally {
    control.close()
    await host.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

it('fences stale connectors and persists increasing generations across host restarts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'host-generation-'))
  const hubUrl = 'ws://localhost:1/computers'
  const config = { hubUrl, name: 'test', allowedRoots: [root], capabilities: [] }
  let host = await startSessionHost(root, config)
  let control = await hostControl(root)
  try {
    const first = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl })
    const connector = await connectorHost(root, first, hubUrl, {})
    const second = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl })
    await expect(connectorHost(root, first, hubUrl, {})).rejects.toThrow()
    connector.close()
    control.close()
    await host.stop()
    host = await startSessionHost(root, config)
    control = await hostControl(root)
    const third = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl })
    expect(third.generation).toBeGreaterThan(second.generation)
    expect(third.health.epoch).not.toBe(first.health.epoch)
  } finally {
    control.close()
    await host.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
