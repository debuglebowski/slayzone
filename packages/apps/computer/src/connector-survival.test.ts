import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { startSessionHost, hostControl, type ConnectorGrant } from './session-host'
import { startConnector } from './connector'

it('replaces connector while idle terminal and running job keep their PIDs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-survival-'))
  const previousRoot = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = root
  const hub = await startLoopbackHub({ floodLimits: false })
  const config = {
    hubUrl: hub.url,
    name: 'survivor',
    allowedRoots: [root],
    capabilities: ['pty', 'proc'],
    joinToken: 'jt-valid'
  }
  const host = await startSessionHost(root, config)
  const control = await hostControl(root)
  let connector: Awaited<ReturnType<typeof startConnector>> | undefined
  try {
    const launch = async () => {
      const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
      const next = await startConnector(root, config, grant)
      await next.dialer.events.once('connected')
      return next
    }
    connector = await launch()
    const id = hub.gateway.listComputers()[0].computerId
    await hub.gateway.request(id, 'pty.spawn', {
      sessionId: 'shell',
      command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      cwd: root
    })
    await hub.gateway.request(id, 'proc.spawn', {
      sessionId: 'job',
      command: process.execPath,
      args: [
        '-e',
        `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(join(root, 'env.json'))}, JSON.stringify(process.env)); setInterval(()=> {if(fs.existsSync(${JSON.stringify(join(root, 'finish'))})) {console.log('output-during-handover');process.exit(7)}},50)`
      ],
      cwd: root
    })
    const before = await hub.gateway.request('computer-1', 'pty.list')
    const jobs = await hub.gateway.request('computer-1', 'proc.list')
    const epoch = hub.gateway.listComputers()[0].epoch
    await vi.waitFor(
      () =>
        expect(readFileSync(join(root, 'env.json'), 'utf8')).toContain('SLAYZONE_AGENT_HOOK_URL'),
      { timeout: 10_000 }
    )
    const env = JSON.parse(readFileSync(join(root, 'env.json'), 'utf8'))
    const hooks: unknown[] = []
    hub.gateway.events.on('event', (event) => {
      hooks.push(event)
    })
    await connector.stop()
    // Both hook delivery and stdout/exit occur with no connector attached.
    for (const index of [1, 2]) {
      expect(
        (
          await fetch(env.SLAYZONE_AGENT_HOOK_URL, {
            method: 'POST',
            body: JSON.stringify({ index })
          })
        ).status
      ).toBe(200)
    }
    writeFileSync(join(root, 'finish'), '')
    await new Promise((resolve) => setTimeout(resolve, 250))
    connector = await launch()
    expect(hub.gateway.listComputers()[0].epoch).toBe(epoch)
    expect(await hub.gateway.request(id, 'pty.list')).toEqual(before)
    expect((jobs as { sessions: Array<{ pid: number }> }).sessions[0].pid).toBeGreaterThan(0)
    await vi.waitFor(
      async () => {
        expect(await hub.gateway.request(id, 'proc.list')).toMatchObject({
          exited: [{ sessionId: 'job', exitCode: 7 }]
        })
        expect(hooks).toHaveLength(2)
      },
      { timeout: 10_000 }
    )
    const replay = await hub.gateway.request(id, 'proc.getBufferSince', {
      sessionId: 'job',
      seq: -1
    })
    expect(JSON.stringify(replay)).toContain('output-during-handover')
    expect(hooks).toMatchObject([{ payload: { index: 1 } }, { payload: { index: 2 } }])
    expect(hub.auth.enrollCalls).toHaveLength(1)
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
