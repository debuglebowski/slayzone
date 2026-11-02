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

it('canceled maintenance resumes admission without replacing the host', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cancel-host-maintenance-')),
    hubUrl = 'ws://localhost:1/computers'
  const host = await startSessionHost(root, {
    hubUrl,
    name: 'test',
    allowedRoots: [root],
    capabilities: []
  })
  const control = await hostControl(root)
  const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl })
  const connector = await connectorHost(root, grant, hubUrl, {})
  const request = {
    method: 'fs.pathExists',
    params: { path: root },
    actor: { userId: null, route: null }
  }
  try {
    await control.rpc.request('prepare-maintenance')
    await expect(connector.rpc.request('dispatch', request)).rejects.toThrow('restarting')
    await control.rpc.request('cancel-maintenance')
    await expect(connector.rpc.request('dispatch', request)).resolves.toEqual({ exists: true })
    expect((await control.rpc.request<{ epoch: string }>('health')).epoch).toBe(host.epoch)
  } finally {
    connector.close()
    control.close()
    await host.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

it('a replacement supervisor resumes an abandoned maintenance drain', async () => {
  const root = mkdtempSync(join(tmpdir(), 'recover-host-drain-')),
    hubUrl = 'ws://localhost:1/computers'
  const host = await startSessionHost(root, {
    hubUrl,
    name: 'test',
    allowedRoots: [root],
    capabilities: []
  })
  let control = await hostControl(root)
  const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl })
  const connector = await connectorHost(root, grant, hubUrl, {})
  const request = {
    method: 'fs.pathExists',
    params: { path: root },
    actor: { userId: null, route: null }
  }
  try {
    await control.rpc.request('prepare-maintenance')
    await expect(connector.rpc.request('dispatch', request)).rejects.toThrow('restarting')
    control.close()
    await new Promise((resolve) => setTimeout(resolve, 30))
    control = await hostControl(root)
    await expect(connector.rpc.request('dispatch', request)).resolves.toEqual({ exists: true })
    expect((await control.rpc.request<{ epoch: string }>('health')).epoch).toBe(host.epoch)
  } finally {
    connector.close()
    control.close()
    await host.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
