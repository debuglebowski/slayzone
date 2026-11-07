/**
 * A standalone computer runs as a session host plus a connector that owns the hub
 * link (connector.ts). Its direct-link identity — the listener's address and whether
 * it answers WebRTC offers — lives in the host, and must still reach the hub's
 * `hello`: the host answers values over its local JSON-RPC, which drops functions.
 * Without this, a remote computer never offered a direct link at all.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { startConnector } from './connector'
import { hostControl, startSessionHost, type ConnectorGrant } from './session-host'

it('a connector-mode computer advertises its direct listener and WebRTC to the hub', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-direct-'))
  const previousRoot = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = root
  const hub = await startLoopbackHub({ floodLimits: false })
  const config = {
    hubUrl: hub.url,
    name: 'remote-box',
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
    const [computer] = hub.gateway.listComputers()
    expect(computer?.directAddress).toMatch(/^127\.0\.0\.1:\d+$/)
    expect(computer?.directRtc).toBe(true)
  } finally {
    await connector?.stop()
    control.close()
    await host.stop()
    await hub.close()
    if (previousRoot === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
