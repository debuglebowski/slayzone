import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startLoopbackHub } from '@slayzone/computer-transport/testing'
import { startSessionHost, hostControl, type ConnectorGrant } from './session-host'
import { startConnector } from './connector'

// A connector whose session-host link closes can no longer serve anything: it stops
// its dialer. It must SAY so (hostLost) — a live process with a dead link otherwise
// sits disconnected forever, because its supervisor relaunches only exited workers.
it('reports hostLost with the reason when the session-host link closes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-host-lost-'))
  const previous = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = root
  const hub = await startLoopbackHub({ floodLimits: false })
  const config = {
    hubUrl: hub.url,
    name: 'host-lost',
    allowedRoots: [root],
    capabilities: ['pty'],
    joinToken: 'jt-valid'
  }
  const host = await startSessionHost(root, config)
  const control = await hostControl(root)
  let connector: Awaited<ReturnType<typeof startConnector>> | undefined
  try {
    const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
    connector = await startConnector(root, config, grant)
    await connector.dialer.events.once('connected')
    expect(connector.hostLost).toBeInstanceOf(Promise)
    let lost: string | undefined
    void connector.hostLost?.then((reason) => {
      lost = reason
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(lost).toBeUndefined()

    // A second reservation revokes this connector: the host closes its link.
    await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
    await expect(connector.hostLost).resolves.toBe('closed by the peer')
    await vi.waitFor(() => expect(connector?.dialer.state).toBe('stopped'))
  } finally {
    await connector?.stop()
    control.close()
    await host.stop()
    await hub.close()
    if (previous === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})

it('does not report hostLost when the connector itself stops', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-host-kept-'))
  const previous = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = root
  const hub = await startLoopbackHub({ floodLimits: false })
  const config = {
    hubUrl: hub.url,
    name: 'host-kept',
    allowedRoots: [root],
    capabilities: ['pty'],
    joinToken: 'jt-valid'
  }
  const host = await startSessionHost(root, config)
  const control = await hostControl(root)
  try {
    const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
    const connector = await startConnector(root, config, grant)
    await connector.dialer.events.once('connected')
    let lost = false
    void connector.hostLost?.then(() => {
      lost = true
    })
    await connector.stop()
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(lost).toBe(false)
  } finally {
    control.close()
    await host.stop()
    await hub.close()
    if (previous === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = previous
    rmSync(root, { recursive: true, force: true })
  }
})
