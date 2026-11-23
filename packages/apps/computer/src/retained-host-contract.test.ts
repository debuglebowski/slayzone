import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, test, vi } from 'vitest'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { placeTestProject } from './project-scope.fixture'
import { HOST_CONTRACT_VERSION } from '@slayzone/computer-runtime'
import { COMPUTER_PROTOCOL_VERSION, DuplexRpc } from '@slayzone/computer-transport/shared'
import { startConnector } from './connector'
import {
  connectorHost,
  hostControl,
  startSessionHost,
  type ConnectorGrant,
  type HostHealth
} from './session-host'
import { superviseUpgrades } from './upgrade-runtime'
import { DEFAULT_CAPABILITIES } from './config'

const actor = { userId: null, route: null }

/** Existing standalone bundle, restored to the actual v2 payload contract.
 * No fixture compilation: all IPC/auth/process dispatch still runs in a real
 * retained host; only the historical contract number/payload schemas differ. */
function retainedEntry(root: string, contract: number) {
  let source = readFileSync(resolve(import.meta.dirname, '../dist/bin.cjs'), 'utf8')
    .replace(/\b((?:var )?HOST_CONTRACT_VERSION) = \d+;/, `$1 = ${contract};`)
    .replace(
      /\bCOMPUTER_PROTOCOL_VERSION = \d+;/,
      `COMPUTER_PROTOCOL_VERSION = ${COMPUTER_PROTOCOL_VERSION - 1};`
    )
  expect(source.includes(`HOST_CONTRACT_VERSION = ${contract};`)).toBe(true)
  expect(source).toContain(`COMPUTER_PROTOCOL_VERSION = ${COMPUTER_PROTOCOL_VERSION - 1};`)
  // The bundler renames colliding top-level names (`id` → `id2`), so match any identifier.
  source = source
    .replace(
      /getTabState: external_exports\.tuple\(\[(\w+), (\w+)\.optional\(\)\]\),/,
      'getTabState: external_exports.tuple([$1]),'
    )
    .replace(
      /saveTabDraft: external_exports\.tuple\(\[(\w+), (\w+), (\w+)\.optional\(\)\]\),/,
      'saveTabDraft: external_exports.tuple([$1, $2]),'
    )
  expect(source).toMatch(/getTabState: external_exports\.tuple\(\[\w+\]\),/)
  expect(source).toMatch(/saveTabDraft: external_exports\.tuple\(\[\w+, \w+\]\),/)
  const queue = /(?:var )?queueOptions = ([\s\S]*?)\n\s*(?:var )?chatQueueOperationSchemas/.exec(
    source
  )
  expect(queue).not.toBeNull()
  source = source.replace(queue![0], queue![0].replace(/^[ \t]+expectedMode:.*\n/m, ''))
  const entry = join(root, `retained-v${contract}.cjs`)
  writeFileSync(entry, source)
  return entry
}

async function exitChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = once(child, 'exit')
  child.kill('SIGTERM')
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5000)
  await exited
  clearTimeout(timeout)
}

test('the standalone connector reports host limits and carries queued starts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'retained-health-'))
  const previousRoot = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = root
  const health = vi.fn()
  const hub = await startLoopbackHub({ floodLimits: false, onComputerHealth: health })
  placeTestProject(root, hub.url, 'p1', root)
  const config = {
    hubUrl: hub.url,
    name: 'retained-health',
    allowedRoots: [root],
    capabilities: ['proc'],
    joinToken: 'jt-valid',
    autoUpgrade: false
  }
  const host = await startSessionHost(root, { ...config, agentResources: { maxLiveAgents: 1 } })
  const control = await hostControl(root)
  const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
  const localRequests = vi.spyOn(DuplexRpc.prototype, 'request')
  let connector: Awaited<ReturnType<typeof startConnector>> | undefined
  try {
    connector = await startConnector(root, config, grant)
    await vi.waitFor(
      () => {
        expect(health).toHaveBeenCalledWith(
          'computer-1',
          expect.objectContaining({ cap: 1, memoryTotal: expect.any(Number), live: 0 }),
          expect.any(Number)
        )
      },
      { timeout: 3_000 }
    )

    const start = (sessionId: string) =>
      hub.gateway.request(
        'computer-1',
        'proc.spawn',
        {
          sessionId,
          projectId: 'p1',
          command: process.execPath,
          args: ['-e', 'setInterval(() => {}, 1000)'],
          cwd: root,
          // Background: a foreground start is never held back by the cap.
          admission: 'background'
        },
        0
      )
    await expect(start('running')).resolves.toMatchObject({ pid: expect.any(Number) })
    const queued = start('queued')
    void queued.catch(() => undefined)
    await vi.waitFor(async () => {
      const status = await hub.gateway.request('computer-1', 'proc.prioritize', {
        sessionId: 'queued'
      })
      expect(status).toMatchObject({ queued: true })
    })
    expect(localRequests.mock.calls.filter(([method]) => method === 'dispatch')).toContainEqual([
      'dispatch',
      expect.objectContaining({
        method: 'proc.spawn',
        params: expect.objectContaining({ sessionId: 'queued' })
      }),
      0,
      undefined,
      expect.any(AbortSignal)
    ])
    // Prioritized, it is a foreground start: admitted past the cap at once.
    await expect(queued).resolves.toMatchObject({ pid: expect.any(Number) })
    await hub.gateway.request('computer-1', 'proc.kill', { sessionId: 'running' })
    await hub.gateway.request('computer-1', 'proc.kill', { sessionId: 'queued' })
  } finally {
    localRequests.mockRestore()
    await connector?.stop()
    control.close()
    await host.stop()
    await hub.close()
    if (previousRoot === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = previousRoot
    rmSync(root, { recursive: true, force: true })
  }
})

test.each([false, true])(
  'new connectors keep busy retained host on chat fallbacks at enroll and hello; raw controls=%s',
  async (rawControls) => {
    const root = mkdtempSync(join(tmpdir(), 'retained-chat-capabilities-'))
    const require = createRequire(import.meta.url)
    symlinkSync(
      dirname(dirname(require.resolve('node-pty/package.json'))),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const hub = await startLoopbackHub({ floodLimits: false })
    placeTestProject(root, hub.url, 'p1', root)
    const config = {
      hubUrl: hub.url,
      name: 'retained-chat-capabilities',
      allowedRoots: [root],
      capabilities: ['proc'],
      joinToken: 'jt-valid',
      autoUpgrade: false
    }
    writeFileSync(
      join(root, 'computer.config.json'),
      JSON.stringify({
        hubUrl: hub.url,
        computerName: config.name,
        allowedRoots: [root],
        autoUpgrade: false
      })
    )
    // Same local contract: the connector may be upgraded while this host stays
    // busy. Restore its historical identity and chat request schemas.
    const entry = retainedEntry(root, HOST_CONTRACT_VERSION)
    let source = readFileSync(entry, 'utf8').replace(
      /^[ \t]+(?:chatHistoryPages|chatTimelineRowSlices|promptSummariesAll|chatStorageCompaction|chatProcessControls|chatControlInvocations|chatControlLeases): true,\n/gm,
      (line) => (rawControls && line.includes('chatProcessControls') ? line : '')
    )
    const tuple = /^([ \t]+)timelinePages: external_exports\.tuple\(\[[\s\S]*?\n\1\]\),/m.exec(
      source
    )
    expect(tuple).not.toBeNull()
    const oldTuple = tuple![0].replace(
      /,\n[ \t]+external_exports\.number\(\)\.int\(\)\.nonnegative\(\)\.optional\(\),\n[ \t]+[^\n]+\.optional\(\)/,
      ''
    )
    expect(oldTuple).not.toBe(tuple![0])
    source = source.replace(tuple![0], oldTuple)
    const summaries =
      /^([ \t]+)external_exports.object\(\{\n[ \t]+kind: external_exports.literal\("prompt.summaries"\),[\s\S]*?\n\1\}\)(?:\.refine\([\s\S]*?\n\1\}\))?,/m.exec(
        source
      )
    expect(summaries).not.toBeNull()
    source = source.replace(
      summaries![0],
      `  external_exports.object({
    kind: external_exports.literal("prompt.summaries"),
    taskId: external_exports.string(),
    conversationIds: external_exports.array(external_exports.string()).max(500)
  }),`
    )
    const pagedReads = /^[ \t]+(?:getReplayPage|getEventPage): external_exports\.tuple.*\n/gm
    expect(source.match(pagedReads)).toHaveLength(2)
    source = source.replace(pagedReads, '')
    writeFileSync(entry, source)
    let output = ''
    const child = spawn(process.execPath, [entry, '--session-host'], {
      env: {
        ...process.env,
        SLAYZONE_ROOT: root,
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: join(root, '.config')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout!.on('data', (chunk) => {
      output += chunk
    })
    child.stderr!.on('data', (chunk) => {
      output += chunk
    })
    const previousRoot = process.env.SLAYZONE_ROOT
    process.env.SLAYZONE_ROOT = root
    let control: Awaited<ReturnType<typeof hostControl>> | undefined
    let native: Awaited<ReturnType<typeof connectorHost>> | undefined
    let connector: Awaited<ReturnType<typeof startConnector>> | undefined
    try {
      await vi.waitFor(
        async () => {
          control = await hostControl(root)
        },
        { timeout: 10000 }
      )
      const initial = await control!.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
      native = await connectorHost(root, initial, hub.url, {})
      const identity = await native.rpc.request<Record<string, unknown>>('identity')
      for (const feature of ['chatHistoryPages', 'chatTimelineRowSlices', 'promptSummariesAll'])
        expect(identity[feature]).toBeUndefined()
      await native.rpc.request('connected', { computerId: 'retained-fixture', mode: 'hello' })
      // Simulate the connector's authenticated identity delivery before scoped work.
      await native.rpc.request('connected', { computerId: 'computer-1', mode: 'hello' })
      await native.rpc.request('dispatch', {
        method: 'proc.spawn',
        actor,
        params: {
          sessionId: 'busy-host',
          projectId: 'p1',
          command: 'node',
          args: ['-e', 'setInterval(()=>{},1000)'],
          cwd: root
        }
      })
      const health = await control!.rpc.request<HostHealth>('health')
      expect(health).toMatchObject({ contract: HOST_CONTRACT_VERSION, idle: false })
      const timeline = (args: unknown[]) => ({
        kind: 'invoke',
        value: { route: { id: 'old-chat', epoch: 1 }, target: 'ops', method: 'timelinePages', args }
      })
      await expect(
        native.rpc.request('dispatch', {
          method: 'chat.request',
          actor,
          params: timeline(['tab', [], -1, 0, 0])
        })
      ).rejects.toThrow(/too_big|<=4|at most|Too big/i)
      await expect(
        native.rpc.request('dispatch', {
          method: 'chat.request',
          actor,
          params: { kind: 'prompt.summaries', taskId: 'task', all: true }
        })
      ).rejects.toThrow(/conversationIds/)
      await expect(
        native.rpc.request('dispatch', {
          method: 'chat.request',
          actor,
          params: {
            kind: 'invoke',
            value: {
              route: { id: 'old-chat', epoch: 1 },
              target: 'ops',
              method: 'getReplayPage',
              args: ['tab', -1]
            }
          }
        })
      ).rejects.toThrow('Unknown chat operation')
      native.close()
      native = undefined
      for (const mode of ['enroll', 'hello']) {
        const grant = await control!.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
        connector = await startConnector(root, config, grant)
        expect((await connector.dialer.events.once('connected')).mode).toBe(mode)
        const [computer] = hub.gateway.listComputers()
        expect(computer, output).toMatchObject({
          chatRuntimeReady: true,
          chatHistoryPages: false,
          chatTimelineRowSlices: false,
          promptSummariesAll: false,
          chatStorageCompaction: false,
          chatProcessControls: rawControls,
          chatControlInvocations: false,
          chatControlLeases: false
        })
        expect(await control!.rpc.request('health')).toMatchObject({
          pid: health.pid,
          epoch: health.epoch,
          idle: false
        })
        if (mode === 'enroll')
          await hub.gateway.request(computer.computerId, 'chat.request', {
            kind: 'bootstrap',
            value: {
              identity: {
                id: 'old-chat',
                taskId: 'task',
                tabId: 'tab',
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
        await expect(
          hub.gateway.request(computer.computerId, 'chat.request', timeline(['tab', [], -1, 0]))
        ).resolves.toMatchObject({ expired: true })
        await expect(
          hub.gateway.request(computer.computerId, 'chat.request', {
            kind: 'invoke',
            value: {
              route: { id: 'old-chat', epoch: 1 },
              target: 'ops',
              method: 'getReplay',
              args: ['tab', -1]
            }
          })
        ).resolves.toBeDefined()
        await expect(
          hub.gateway.request(computer.computerId, 'chat.request', {
            kind: 'prompt.summaries',
            taskId: 'task',
            conversationIds: []
          })
        ).resolves.toEqual([])
        await connector.stop()
        connector = undefined
        await vi.waitFor(() => expect(hub.gateway.listComputers()).toHaveLength(0))
      }
      expect(hub.auth.enrollCalls).toHaveLength(1)
      expect(hub.auth.helloCalls).toHaveLength(1)
    } finally {
      await connector?.stop()
      native?.close()
      await control?.rpc.request('stop', { force: true }).catch(() => undefined)
      control?.close()
      await exitChild(child)
      if (previousRoot === undefined) delete process.env.SLAYZONE_ROOT
      else process.env.SLAYZONE_ROOT = previousRoot
      await hub.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  },
  30000
)

test.each([1, 2])(
  'new connector restricts a real busy retained v%s host until idle replacement',
  async (contract) => {
    const root = mkdtempSync(join(tmpdir(), 'retained-host-contract-'))
    const require = createRequire(import.meta.url)
    symlinkSync(
      dirname(dirname(require.resolve('node-pty/package.json'))),
      join(root, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const hub = await startLoopbackHub({ floodLimits: false })
    placeTestProject(root, hub.url, 'p1', root)
    const config = {
      hubUrl: hub.url,
      name: 'retained-contract-test',
      allowedRoots: [root],
      capabilities: ['proc'],
      joinToken: 'jt-valid',
      autoUpgrade: false
    }
    mkdirSync(join(root, 'computer-runtime'), { recursive: true })
    writeFileSync(
      join(root, 'computer.config.json'),
      JSON.stringify({
        hubUrl: hub.url,
        computerName: config.name,
        allowedRoots: [root],
        autoUpgrade: false
      })
    )
    const entry = retainedEntry(root, contract)
    let output = ''
    const child = spawn(process.execPath, [entry, '--session-host'], {
      env: {
        ...process.env,
        SLAYZONE_ROOT: root,
        HOME: root,
        USERPROFILE: root,
        XDG_CONFIG_HOME: join(root, '.config')
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout!.on('data', (chunk) => {
      output += chunk
    })
    child.stderr!.on('data', (chunk) => {
      output += chunk
    })
    const previousRoot = process.env.SLAYZONE_ROOT
    process.env.SLAYZONE_ROOT = root
    let control: Awaited<ReturnType<typeof hostControl>> | undefined
    let native: Awaited<ReturnType<typeof connectorHost>> | undefined
    let connector: Awaited<ReturnType<typeof startConnector>> | undefined
    let replacement: Awaited<ReturnType<typeof startSessionHost>> | undefined
    try {
      await vi.waitFor(
        async () => {
          control = await hostControl(root)
        },
        { timeout: 10000 }
      )
      const first = await control!.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
      expect(first.health.contract).toBe(contract)
      native = await connectorHost(root, first, hub.url, {})
      expect(await native.rpc.request('identity')).toMatchObject({
        contract,
        protocolVersion: COMPUTER_PROTOCOL_VERSION - 1
      })
      await native.rpc.request('connected', { computerId: 'retained-fixture', mode: 'hello' })
      // Simulate the connector's authenticated identity delivery before scoped work.
      await native.rpc.request('connected', { computerId: 'computer-1', mode: 'hello' })
      await native.rpc.request('dispatch', {
        method: 'proc.spawn',
        params: {
          sessionId: 'running-native',
          projectId: 'p1',
          command: process.execPath,
          args: ['-e', 'setInterval(()=>{},1000)'],
          cwd: root
        },
        actor
      })
      const oldHealth = await control!.rpc.request<HostHealth>('health')
      expect(oldHealth.idle).toBe(false)
      const invoke = (method: string, args: unknown[]) =>
        native!.rpc.request('dispatch', {
          method: 'chat.request',
          actor,
          params: {
            kind: 'invoke',
            value: { route: { id: 'old-chat', epoch: 1 }, target: 'ops', method, args }
          }
        })
      await expect(invoke('getTabState', ['tab', { expectedMode: 'claude-chat' }])).rejects.toThrow(
        /too_big|<=1|at most|Too big/i
      )
      // Simulate the connector's authenticated identity delivery before scoped work.
      await native.rpc.request('connected', { computerId: 'computer-1', mode: 'hello' })
      await native.rpc.request('dispatch', {
        method: 'chat.request',
        actor,
        params: {
          kind: 'bootstrap',
          value: {
            identity: {
              id: 'old-chat',
              taskId: 'task',
              tabId: 'tab',
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
        }
      })
      const stripped = await native.rpc.request('dispatch', {
        method: 'chat.request',
        actor,
        params: {
          kind: 'invoke',
          value: {
            route: { id: 'old-chat', epoch: 1 },
            target: 'queue',
            method: 'push',
            args: [
              'tab',
              'historical admission',
              'historical admission',
              { id: 'old-queue', expectedMode: 'codex-chat' }
            ],
            operationId: 'old-admission'
          }
        }
      })
      expect(stripped).toMatchObject({ id: 'old-queue' })
      const grant = await control!.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
      native.close()
      native = undefined
      connector = await startConnector(root, config, grant)
      await vi.waitFor(() => expect(hub.gateway.listComputers(), output).toHaveLength(1), {
        timeout: 10000
      })
      const retained = hub.gateway.listComputers()[0]
      expect(retained.chatRuntimeReady).toBe(false)
      expect(await control!.rpc.request('health')).toMatchObject({
        pid: oldHealth.pid,
        epoch: oldHealth.epoch,
        idle: false,
        contract
      })
      await expect(
        hub.gateway.request(retained.computerId, 'chat.request', {
          kind: 'conversation.transition',
          value: {}
        })
      ).rejects.toThrow(/update pending/i)
      await expect(
        hub.gateway.request(retained.computerId, 'chat.request', {
          kind: 'invoke',
          value: {
            route: { id: 'old-chat', epoch: 1 },
            target: 'ops',
            method: 'getTabState',
            args: ['tab', { expectedMode: 'claude-chat' }]
          }
        })
      ).rejects.toThrow(/update pending/i)
      await expect(
        hub.gateway.request(retained.computerId, 'proc.spawn', {
          sessionId: 'new-work',
          projectId: 'p1',
          command: process.execPath,
          args: ['-e', 'process.exit(0)'],
          cwd: root
        })
      ).rejects.toThrow(/update pending/i)
      await expect(
        hub.gateway.request(retained.computerId, 'chat.request', {
          kind: 'invoke',
          value: {
            route: { id: 'old-chat', epoch: 1 },
            target: 'queue',
            method: 'clear',
            args: ['tab'],
            operationId: 'maintenance-clear'
          }
        })
      ).resolves.toBe(1)
      await hub.gateway.request(retained.computerId, 'proc.kill', { sessionId: 'running-native' })
      await vi.waitFor(async () =>
        expect((await control!.rpc.request<HostHealth>('health')).idle).toBe(true)
      )
      await connector.stop()
      connector = undefined
      const exited = once(child, 'exit')
      await control!.rpc.request('prepare-maintenance')
      await control!.rpc.request('stop', { force: false })
      await exited
      control!.close()
      control = undefined
      replacement = await startSessionHost(root, config)
      control = await hostControl(root)
      const updated = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
      expect(updated.health.contract).toBe(HOST_CONTRACT_VERSION)
      expect(updated.health.epoch).not.toBe(oldHealth.epoch)
      connector = await startConnector(root, config, updated)
      await vi.waitFor(() => expect(hub.gateway.listComputers()[0]?.chatRuntimeReady).toBe(true), {
        timeout: 10000
      })
      expect(hub.gateway.listComputers()[0].computerId).toBe(retained.computerId)
      expect(hub.auth.enrollCalls).toHaveLength(1)
      await expect(
        hub.gateway.request(retained.computerId, 'chat.request', { kind: 'inventory' })
      ).resolves.toBeInstanceOf(Array)
    } finally {
      await connector?.stop()
      native?.close()
      await replacement?.stop()
      await control?.rpc.request('stop', { force: true }).catch(() => undefined)
      control?.close()
      await exitChild(child)
      if (previousRoot === undefined) delete process.env.SLAYZONE_ROOT
      else process.env.SLAYZONE_ROOT = previousRoot
      await hub.close()
      rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
    }
  },
  30000
)

test('supervisor defers retained v2 replacement while busy, then publishes v3 host at idle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'retained-host-supervisor-'))
  const require = createRequire(import.meta.url)
  symlinkSync(
    dirname(dirname(require.resolve('node-pty/package.json'))),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const hub = await startLoopbackHub({ floodLimits: false })
  placeTestProject(root, hub.url, 'p1', root)
  const config = {
    hubUrl: hub.url,
    name: 'retained-supervisor',
    allowedRoots: [root],
    capabilities: [...DEFAULT_CAPABILITIES],
    joinToken: 'jt-valid',
    autoUpgrade: false
  }
  mkdirSync(join(root, 'computer-runtime'), { recursive: true })
  writeFileSync(
    join(root, 'computer.config.json'),
    JSON.stringify({
      hubUrl: hub.url,
      computerName: config.name,
      allowedRoots: [root],
      autoUpgrade: false
    })
  )
  const oldEntry = retainedEntry(root, 2)
  writeFileSync(
    oldEntry,
    readFileSync(oldEntry, 'utf8').replace(
      /\b((?:var )?COMPUTER_VERSION) = [^;]+;/,
      '$1 = "1.0.0";'
    )
  )
  const candidate = join(root, 'current-v3.cjs')
  const current = readFileSync(resolve(import.meta.dirname, '../dist/bin.cjs'), 'utf8')
    .replace(/\b((?:var )?HOST_CONTRACT_VERSION) = \d+;/, `$1 = ${HOST_CONTRACT_VERSION};`)
    .replace(/\b((?:var )?COMPUTER_VERSION) = [^;]+;/, '$1 = "1.0.0";')
  writeFileSync(candidate, current)
  let output = ''
  const child = spawn(process.execPath, [oldEntry, '--session-host'], {
    env: {
      ...process.env,
      SLAYZONE_ROOT: root,
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, '.config')
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout!.on('data', (chunk) => {
    output += chunk
  })
  child.stderr!.on('data', (chunk) => {
    output += chunk
  })
  const previousRoot = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = root
  const argvLength = process.argv.length
  process.argv.push('--supervisor')
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`fixture supervisor exit ${code}`)
  })
  let control: Awaited<ReturnType<typeof hostControl>> | undefined
  let native: Awaited<ReturnType<typeof connectorHost>> | undefined
  let supervisor: Awaited<ReturnType<typeof superviseUpgrades>> | undefined
  try {
    await vi.waitFor(
      async () => {
        control = await hostControl(root)
      },
      { timeout: 10000 }
    )
    const grant = await control!.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
    native = await connectorHost(root, grant, hub.url, {})
    // Simulate the connector's authenticated identity delivery before scoped work.
    await native.rpc.request('connected', { computerId: 'computer-1', mode: 'hello' })
    await native.rpc.request('dispatch', {
      method: 'proc.spawn',
      actor,
      params: {
        sessionId: 'retained-native',
        projectId: 'p1',
        command: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: root
      }
    })
    const health = await control!.rpc.request<HostHealth>('health')
    expect(health).toMatchObject({ idle: false, contract: 2 })
    supervisor = await superviseUpgrades(
      config,
      { entry: candidate, version: '1.0.0' },
      root,
      () => {},
      { intervalMs: 30, probationMs: 0 }
    )
    await vi.waitFor(() => expect(hub.gateway.listComputers(), output).toHaveLength(1), {
      timeout: 10000
    })
    const connected = hub.gateway.listComputers()[0]
    expect(connected.chatRuntimeReady).toBe(false)
    expect(await control!.rpc.request('health')).toMatchObject({
      pid: health.pid,
      epoch: health.epoch,
      contract: 2,
      idle: false
    })
    expect(exit).not.toHaveBeenCalled()
    const key = new URL(hub.url).host.replace(/[^a-zA-Z0-9.-]/g, '_')
    await vi.waitFor(() =>
      expect(
        JSON.parse(
          readFileSync(join(root, 'computer-runtime', 'hubs', key, 'upgrade-status.json'), 'utf8')
        ).maintenanceReason
      ).toMatch(/waiting|waits/i)
    )
    await hub.gateway.request(connected.computerId, 'proc.kill', { sessionId: 'retained-native' })
    await vi.waitFor(() => expect(exit, output).toHaveBeenCalledWith(75), { timeout: 10000 })
    expect(
      JSON.parse(readFileSync(join(root, 'computer-runtime', 'host-release.json'), 'utf8')).current
    ).toEqual({ entry: candidate, version: '1.0.0' })
    await vi.waitFor(() => expect(child.exitCode, output).toBe(0))
    expect(hub.auth.enrollCalls).toHaveLength(1)
  } finally {
    await supervisor?.stop(false)
    native?.close()
    await control?.rpc.request('stop', { force: true }).catch(() => undefined)
    control?.close()
    await exitChild(child)
    exit.mockRestore()
    process.argv.length = argvLength
    if (previousRoot === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = previousRoot
    await hub.close()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
}, 30000)
