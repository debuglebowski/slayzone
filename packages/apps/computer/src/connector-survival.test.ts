import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { startSessionHost, hostControl, type ConnectorGrant } from './session-host'
import { startConnector } from './connector'
import { placeTestProject } from './project-scope.fixture'
import { RpcError, ComputerTransportErrorCodes } from '@slayzone/computer-transport/shared'

it('replaces connector while idle terminal and running job keep their PIDs', async () => {
  const root = mkdtempSync(join(tmpdir(), 'connector-survival-'))
  const previousRoot = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = root
  let rejectHello = false
  const hub = await startLoopbackHub({
    floodLimits: false,
    verifyApiKey: async (key) => {
      if (rejectHello)
        throw new RpcError(ComputerTransportErrorCodes.protocolMismatch, 'upgrade computer')
      return hub.auth.verifyApiKey(key)
    }
  })
  const config = {
    hubUrl: hub.url,
    name: 'survivor',
    allowedRoots: [root],
    capabilities: ['pty', 'proc'],
    joinToken: 'jt-valid'
  }
  placeTestProject(root, hub.url, 'p1', root)
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
    await hub.gateway.request(id, 'chat.request', {
      kind: 'bootstrap',
      value: {
        identity: {
          id: 'chat-store',
          taskId: 'task',
          tabId: 'chat-tab',
          mode: 'claude-chat',
          epoch: 1
        },
        projectId: 'p1',
        cwd: root,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }
    })
    await hub.gateway.request(id, 'pty.spawn', {
      sessionId: 'shell',
      projectId: 'p1',
      command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
      cwd: root
    })
    await hub.gateway.request(id, 'proc.spawn', {
      sessionId: 'job',
      projectId: 'p1',
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
    const rejected = connector.dialer.events.once('error')
    rejectHello = true
    hub.gateway.disconnect(id, 'hub upgrade')
    await rejected
    // Keep local IPC attached while the hub protocol is unavailable.
    // Both hook delivery and stdout/exit occur while the hub connection is unavailable.
    for (const index of [1, 2]) {
      expect(
        (
          await fetch(env.SLAYZONE_AGENT_HOOK_URL, {
            method: 'POST',
            body: JSON.stringify({
              agentId: 'claude-code',
              mode: 'claude-code',
              hookEvent: 'UserPromptSubmit',
              taskId: 'task',
              sessionId: `hook-${index}`,
              raw: { prompt: `private-hook-marker-${index}` }
            })
          })
        ).status
      ).toBe(200)
    }
    writeFileSync(join(root, 'finish'), '')
    await new Promise((resolve) => setTimeout(resolve, 250))
    await connector.stop()
    rejectHello = false
    connector = await launch()
    expect(hub.gateway.listComputers()[0].epoch).toBe(epoch)
    const sessionPids = (value: unknown) =>
      (value as { sessions: Array<{ sessionId: string; pid: number }> }).sessions.map(
        ({ sessionId, pid }) => ({ sessionId, pid })
      )
    expect(sessionPids(await hub.gateway.request(id, 'pty.list'))).toEqual(sessionPids(before))
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
    expect(hooks).toMatchObject([
      { payload: { sessionId: 'hook-1' } },
      { payload: { sessionId: 'hook-2' } }
    ])
    expect(JSON.stringify(hooks)).not.toContain('private-hook-marker')
    expect(
      await hub.gateway.request(id, 'chat.request', { kind: 'prompts', taskId: 'task' })
    ).toMatchObject([
      { cli_session_id: 'hook-1', text: 'private-hook-marker-1' },
      { cli_session_id: 'hook-2', text: 'private-hook-marker-2' }
    ])
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
