import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { expect, test, vi } from 'vitest'
import {
  resolveMissingFromRef,
  snapshotPath
} from '../../../shared/test-utils/git-snapshot-resolve'
import { HOST_CONTRACT_VERSION } from '@slayzone/computer-runtime'
import { createMemoryCredentialStore, HubDialer } from '@slayzone/computer-transport/client'
import {
  COMPUTER_PROTOCOL_VERSION,
  ComputerTransportErrorCodes
} from '@slayzone/computer-transport/shared'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { startConnector } from '../../computer/src/connector'
import { ensureSessionHost, superviseUpgrades } from '../../computer/src/upgrade-runtime'
import { createChatRuntimeHandlers } from '../../computer/src/handlers/chat-runtime'
import { connectorHost, type ConnectorGrant } from '../../computer/src/session-host'
import { createComputerChatCommandBarrier } from './computer-chat-maintenance'
import { createFakeClaude } from '../../../shared/test-utils/fake-claude'
import { createTestHarness } from '../../../shared/test-utils/ipc-harness'
import { createDbChatDataOps } from '@slayzone/terminal/server'
import { taskSessionStore } from '@slayzone/task/server'
import { createComputerChatServices } from './computer-chat'
import Database from 'better-sqlite3'
import { readdirSync } from 'node:fs'

// Actual prefeature source, not an imitation of its dispatch table. The bundle
// stays in memory; only native addons use this worktree's installed dependencies.
// No checked-out source, build output, live HOME or provider process is touched.
const root = resolve(import.meta.dirname, '../../../..')
const legacyRef = '6bd86bfd0^'
const computerDir = join(root, 'packages/apps/computer')
const requireComputer = createRequire(join(computerDir, 'package.json'))
const hostBundles = new Map<string, Promise<typeof import('../../computer/src/session-host')>>()
function historicalHost(ref = legacyRef, version = '0.36.3') {
  const cached = hostBundles.get(ref)
  if (cached) return cached
  const pending = (async () => {
    const esbuild = requireComputer('esbuild') as typeof import('esbuild')
    const result = await esbuild.build({
      stdin: {
        contents: 'export { startSessionHost, hostControl } from "./session-host"',
        resolveDir: join(computerDir, 'src'),
        sourcefile: 'remote-third-prefeature-entry.ts',
        loader: 'ts'
      },
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      target: 'node24',
      define: { __SLAYZONE_COMPUTER_VERSION__: JSON.stringify(version) },
      external: ['node-pty', 'better-sqlite3', 'bufferutil', 'utf-8-validate'],
      logLevel: 'silent',
      plugins: [
        {
          name: 'isolated-prefeature-snapshot',
          setup(build) {
            build.onResolve({ filter: /\?raw$/ }, (args) => ({
              path: requireComputer.resolve(args.path.slice(0, -4), { paths: [args.resolveDir] }),
              namespace: 'snapshot-raw'
            }))
            build.onLoad({ filter: /.*/, namespace: 'snapshot-raw' }, (args) => ({
              contents: execFileSync('git', ['show', `${ref}:${relative(root, args.path)}`], {
                cwd: root,
                encoding: 'utf8'
              }),
              loader: 'text'
            }))
            // A module the old release imported may be gone from disk since: resolve it
            // from the ref, so the build depends only on that ref.
            build.onResolve({ filter: /^\.\.?\// }, (args) =>
              resolveMissingFromRef(root, ref, args)
            )
            build.onLoad({ filter: /\.(ts|tsx|js|mjs|json)$/ }, (args) => {
              const path = snapshotPath(args.path, realpathSync)
              if (!path.startsWith(root + '/') || path.includes('/node_modules/')) return
              const source = execFileSync('git', ['show', `${ref}:${relative(root, path)}`], {
                cwd: root,
                encoding: 'utf8'
              })
              return {
                contents: source,
                loader:
                  extname(path) === '.json' ? 'json' : extname(path) === '.tsx' ? 'tsx' : 'ts',
                resolveDir: dirname(path)
              }
            })
          }
        }
      ]
    })
    const module = { exports: {} }
    new Function(
      'require',
      'module',
      'exports',
      '__filename',
      '__dirname',
      result.outputFiles[0].text
    )(
      requireComputer,
      module,
      module.exports,
      join(computerDir, 'remote-third-prefeature.cjs'),
      computerDir
    )
    return module.exports as typeof import('../../computer/src/session-host')
  })()
  hostBundles.set(ref, pending)
  return pending
}
const prefeatureHost = () => historicalHost()

test('remote third control: real websocket refuses an older wire protocol before authentication', async () => {
  const hub = await startLoopbackHub({ floodLimits: false })
  const { WebSocket } = requireComputer('ws') as typeof import('ws')
  const ws = new WebSocket(hub.url)
  try {
    await new Promise<void>((done, reject) => {
      ws.once('open', done)
      ws.once('error', reject)
    })
    const response = new Promise<{ error?: { code?: number }; result?: unknown }>((done) =>
      ws.once('message', (raw) => done(JSON.parse(raw.toString())))
    )
    ws.send(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'enroll',
        params: {
          joinToken: 'jt-valid',
          name: 'old',
          platform: 'darwin-arm64',
          version: '0.36.3',
          capabilities: ['pty', 'proc'],
          protocolVersion: COMPUTER_PROTOCOL_VERSION - 1
        }
      })
    )
    expect(await response).toMatchObject({
      error: { code: ComputerTransportErrorCodes.protocolMismatch }
    })
    expect(hub.auth.enrollCalls).toEqual([])
    expect(hub.gateway.listComputers()).toEqual([])
  } finally {
    ws.terminate()
    await hub.close()
  }
})

test('remote third: rolling upgrade preserves hub stop controls through a declared maintenance bridge', async () => {
  const legacy = await prefeatureHost()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'remote-third-upgrade-'))
  const previousRoot = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = dir
  let barrier: ReturnType<typeof createComputerChatCommandBarrier> | undefined
  const hub = await startLoopbackHub({
    floodLimits: false,
    beforeRequest: async (id, method) => {
      await barrier?.(id, method)
    }
  })
  const config = {
    hubUrl: hub.url,
    name: 'old-session-host',
    allowedRoots: [dir],
    capabilities: ['pty', 'proc'],
    joinToken: 'jt-valid',
    autoUpgrade: false
  }
  const journal = join(
    dir,
    'computer-runtime',
    'hooks-' + createHash('sha256').update(hub.url).digest('hex').slice(0, 16) + '.json'
  )
  mkdirSync(dirname(journal), { recursive: true })
  writeFileSync(
    journal,
    JSON.stringify([
      {
        id: 'pending-native-hook',
        params: {
          name: 'agent-hook',
          payload: {
            taskId: 'legacy-task',
            raw: { prompt: 'maintenance-native-prompt-marker' }
          }
        }
      }
    ])
  )
  let relayedHooks = 0
  hub.gateway.events.on('event', (event) => {
    if (event.name === 'agent-hook') relayedHooks++
  })
  const host = await legacy.startSessionHost(dir, config)
  const release = { entry: join(computerDir, 'dist/bin.cjs'), version: '0.36.4' }
  const control = await ensureSessionHost(config, release, dir)
  let native: Awaited<ReturnType<typeof connectorHost>> | undefined
  let supervisor: Awaited<ReturnType<typeof superviseUpgrades>> | undefined
  const argvLength = process.argv.length
  process.argv.push('--supervisor')
  const exit = vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error('test supervisor exit ' + code)
  })
  try {
    const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
    expect(grant.health.contract).toBe(1)
    expect(grant.health.version).toBe('0.36.3')
    native = await connectorHost(dir, grant, hub.url, {})
    const dispatch = (method: string, params: unknown) =>
      native!.rpc.request('dispatch', {
        method,
        params,
        actor: { userId: null, route: null }
      })
    await dispatch('proc.spawn', {
      sessionId: 'legacy-job',
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      // The computer strips ELECTRON_RUN_AS_NODE from inherited env, so under the
      // Electron-run harness this would start a GUI Electron: alive on macOS, but
      // exiting at once on a headless Linux runner, leaving the host idle. The
      // spawn's own env keeps the busy job a real Node process on every runtime.
      env: { ELECTRON_RUN_AS_NODE: '1' },
      cwd: dir
    })
    expect(await control.rpc.request('health')).toMatchObject({ idle: false, version: '0.36.3' })
    await expect(
      startConnector(dir, config, { ...grant, health: { ...grant.health, contract: 0 } })
    ).rejects.toThrow(/contract incompatible/)
    expect(HOST_CONTRACT_VERSION).not.toBe(grant.health.contract)
    expect(hub.auth.enrollCalls).toHaveLength(0)
    expect(hub.gateway.listComputers()).toHaveLength(0)

    // A maintenance-only wire adapter advertises unavailable chat explicitly,
    // allowing authenticated stop controls through the real hub gateway while
    // the historical host still owns native work.
    supervisor = await superviseUpgrades(config, release, dir, () => {}, { intervalMs: 20 })
    const key = new URL(hub.url).host.replace(/[^a-zA-Z0-9.-]/g, '_')
    await vi.waitFor(() => expect(hub.gateway.listComputers()).toHaveLength(1), { timeout: 10_000 })
    const connected = hub.gateway.listComputers()[0]
    expect(connected).toMatchObject({
      chatRuntimeReady: false,
      protocolVersion: COMPUTER_PROTOCOL_VERSION
    })
    expect(hub.auth.enrollCalls[0]).toMatchObject({ chatRuntimeReady: false })
    const epoch = connected.epoch
    hub.gateway.disconnect(connected.computerId, 'maintenance bridge reconnect')
    await vi.waitFor(
      () =>
        expect(hub.gateway.listComputers()[0]).toMatchObject({
          computerId: connected.computerId,
          epoch,
          chatRuntimeReady: false
        }),
      { timeout: 10_000 }
    )
    expect(hub.auth.enrollCalls).toHaveLength(1)
    expect(hub.auth.helloCalls.length).toBeGreaterThan(0)
    expect(exit).not.toHaveBeenCalled()
    // Let the historical host's one-second ACK retry run. An unready bridge
    // must retain native prompts for the replacement host's durable capture.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    expect(readFileSync(journal, 'utf8')).toContain('maintenance-native-prompt-marker')
    expect(relayedHooks).toBe(0)
    await vi.waitFor(
      () => {
        const status = JSON.parse(
          readFileSync(join(dir, 'computer-runtime/hubs', key, 'upgrade-status.json'), 'utf8')
        )
        expect(status.phase).toBe('connected')
        expect(status.maintenanceReason).toBeDefined()
      },
      { timeout: 10_000 }
    )
    barrier = createComputerChatCommandBarrier({
      recover: async () => {
        throw new Error('Chat recovery pending')
      },
      lifecycle: async () => {
        throw new Error('must not reach lifecycle')
      }
    })
    await expect(barrier('pc', 'fs.pathExists')).rejects.toThrow('Chat recovery pending')
    await barrier('pc', 'pty.kill')
    await barrier('pc', 'proc.kill')
    await expect(
      hub.gateway.request(connected.computerId, 'chat.request', { kind: 'inventory' })
    ).rejects.toThrow(/update|maintenance/i)
    await expect(
      hub.gateway.request(connected.computerId, 'proc.spawn', {
        sessionId: 'forbidden-new-job',
        command: process.execPath,
        args: ['-e', ''],
        cwd: dir
      })
    ).rejects.toThrow(/pending|update|maintenance/i)
    expect(await hub.gateway.request(connected.computerId, 'proc.list')).toMatchObject({
      sessions: [{ sessionId: 'legacy-job' }]
    })
    await hub.gateway.request(connected.computerId, 'proc.kill', { sessionId: 'legacy-job' })
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(75), { timeout: 10_000 })
    await host.closed
    expect(readFileSync(journal, 'utf8')).toContain('maintenance-native-prompt-marker')
    expect(
      JSON.parse(readFileSync(join(dir, 'computer-runtime/host-release.json'), 'utf8')).current
    ).toEqual(release)
  } finally {
    await supervisor?.stop(false)
    native?.close()
    control.close()
    await host.stop()
    process.argv.length = argvLength
    exit.mockRestore()
    await hub.close()
    if (previousRoot === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = previousRoot
    rmSync(dir, { recursive: true, force: true })
  }
}, 30_000)

test('remote third control: timed-out websocket draft commit replays one receipt across reconnect', async () => {
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'remote-third-timeout-'))
  const hub = await startLoopbackHub({ floodLimits: false })
  const store = createMemoryCredentialStore()
  let dropReply = true
  let committed!: () => void
  const didCommit = new Promise<void>((done) => {
    committed = done
  })
  const computer = createChatRuntimeHandlers({
    stateDir: dir,
    hubScope: 'timeout-audit',
    computerId: () => 'computer-1',
    getProjectPaths: () => null,
    ctx: {
      config: {
        hubUrl: hub.url,
        name: 'timeout-audit',
        allowedRoots: [dir],
        capabilities: ['proc']
      },
      dialer: { notify: () => true },
      log: () => {}
    }
  })
  const dialer = new HubDialer({
    url: hub.url,
    identity: {
      name: 'timeout-audit',
      platform: 'darwin-arm64',
      version: '0.36.4',
      capabilities: ['proc']
    },
    credentialStore: store,
    joinToken: 'jt-valid',
    heartbeatIntervalMs: 0,
    backoff: { initialDelayMs: 5, maxDelayMs: 5, jitterRatio: 0 },
    onHubRequest: async (method, raw) => {
      if (method !== 'chat.request') throw new Error('unexpected method')
      const result = await computer.request(raw)
      if (dropReply && (raw as { kind: string }).kind === 'invoke') {
        committed()
        // A real accepted request whose response will never arrive on this socket.
        await new Promise<void>(() => {})
      }
      return result
    }
  })
  try {
    dialer.start()
    await vi.waitFor(() => expect(dialer.state).toBe('connected'))
    const id = dialer.computerId!
    await hub.gateway.request(id, 'chat.request', {
      kind: 'bootstrap',
      value: {
        identity: { id: 'storage', taskId: 'task', tabId: 'tab', mode: 'claude-chat', epoch: 1 },
        projectId: null,
        cwd: dir,
        revision: 0,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }
    })
    const call = {
      kind: 'invoke',
      value: {
        route: { id: 'storage', epoch: 1 },
        target: 'ops',
        method: 'saveTabDraft',
        operationId: 'stable-draft-operation',
        args: ['tab', { text: 'saved over a slow link', attachments: [] }]
      }
    }
    const first = hub.gateway.request(id, 'chat.request', call, 25)
    const firstCheck = expect(first).rejects.toThrow(/timed out/)
    await didCommit
    await firstCheck
    dropReply = false
    const reconnect = dialer.events.once('connected')
    hub.gateway.disconnect(id, 'isolated link restart')
    await reconnect
    expect(await hub.gateway.request(id, 'chat.request', call)).toEqual({ rev: 1 })
    expect(
      await hub.gateway.request(id, 'chat.request', {
        kind: 'invoke',
        value: {
          route: { id: 'storage', epoch: 1 },
          target: 'ops',
          method: 'getTabState',
          args: ['tab']
        }
      })
    ).toMatchObject({ draft: { text: 'saved over a slow link', rev: 1 } })
    expect(hub.auth.enrollCalls).toHaveLength(1)
    expect(hub.auth.helloCalls).toHaveLength(1)
  } finally {
    await dialer.stop()
    await computer.close()
    await hub.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('released contract1 chat host accepts maintenance UI Stop without spawning or popping history', async () => {
  const legacy = await historicalHost('ed9673300', '0.36.4')
  const h = await createTestHarness()
  const dir = mkdtempSync(join(realpathSync(tmpdir()), 'maintenance-chat-stop-'))
  const previousRoot = process.env.SLAYZONE_ROOT
  process.env.SLAYZONE_ROOT = dir
  const fake = createFakeClaude({ root: join(dir, 'fake') })
  const epoch = fake.setScenario({ processes: [{ defaultTurn: [{ hang: true }] }] })
  const hub = await startLoopbackHub({ floodLimits: false })
  const config = {
    hubUrl: hub.url,
    name: 'legacy-chat',
    allowedRoots: [dir],
    capabilities: ['proc'],
    binOverrideDir: fake.binDir,
    joinToken: 'jt-valid'
  }
  const host = await legacy.startSessionHost(dir, config)
  const control = await legacy.hostControl(dir)
  const original = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
  const peer = await connectorHost(dir, original, hub.url, {
    request: async () => {
      throw new Error('Hold old notifications')
    }
  })
  const dispatch = (params: unknown) =>
    peer.rpc.request('dispatch', {
      method: 'chat.request',
      params,
      actor: { userId: null, route: null }
    })
  const identity = {
    id: 'legacy-chat-store',
    taskId: 't',
    tabId: 'tab',
    mode: 'claude-chat',
    epoch: 1
  }
  let connector: Awaited<ReturnType<typeof startConnector>> | undefined
  try {
    await peer.rpc.request('connected', { computerId: 'computer-1', mode: 'hello' })
    await dispatch({
      kind: 'bootstrap',
      value: {
        identity,
        projectId: null,
        cwd: dir,
        revision: 1,
        providerConfig: {},
        defaultFlags: null,
        env: {}
      }
    })
    const invoke = (method: string, args: unknown[], operationId: string) =>
      dispatch({
        kind: 'invoke',
        value: { route: { id: identity.id, epoch: 1 }, target: 'ops', method, args, operationId }
      })
    const context = { taskId: 't', tabId: 'tab', mode: 'claude-chat', cwd: dir }
    await invoke('hydrate', [context], 'hydrate')
    await invoke(
      'send',
      ['tab', { id: 'original', content: [{ type: 'text', text: 'retained-original-message' }] }],
      'send'
    )
    await vi.waitFor(
      () => expect(epoch.runs()[0]?.userMessages()).toEqual(['retained-original-message']),
      { timeout: 15_000 }
    )
    await dispatch({
      kind: 'invoke',
      value: {
        route: { id: identity.id, epoch: 1 },
        target: 'queue',
        method: 'push',
        args: ['tab', 'queued-followup', 'queued-followup', { id: 'queued' }],
        operationId: 'queue'
      }
    })
    expect(await control.rpc.request('health')).toMatchObject({ idle: false, contract: 1 })
    const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl: hub.url })
    connector = await startConnector(dir, config, { ...grant, maintenance: true })
    await vi.waitFor(() => expect(connector!.dialer.state).toBe('connected'))
    const pc = hub.gateway.listComputers()[0].computerId
    expect(hub.gateway.listComputers()[0].chatRuntimeReady).toBe(false)
    h.db.prepare("INSERT INTO projects(id,name,color) VALUES('p','Project','#000')").run()
    h.db
      .prepare("INSERT INTO tasks(id,project_id,title,worktree_path) VALUES('t','p','Task',?)")
      .run(dir)
    h.db
      .prepare(
        "INSERT INTO terminal_tabs(id,task_id,mode,position) VALUES('tab','t','claude-chat',0)"
      )
      .run()
    const calls: unknown[] = []
    let denied = false
    let failClear = false
    const services = createComputerChatServices({
      db: h.slayDb,
      legacyData: {
        ...createDbChatDataOps(h.slayDb, taskSessionStore),
        buildMcpEnv: async () => ({})
      },
      attachments: { read: async () => new Uint8Array() },
      request: async (id, body) => {
        calls.push(body)
        const call = body as { kind: string; value?: { target: string; method: string } }
        if (
          failClear &&
          call.kind === 'invoke' &&
          call.value?.target === 'queue' &&
          call.value.method === 'clear'
        )
          throw new Error('Queue clear unavailable')
        return hub.gateway.request(id, 'chat.request', body)
      },
      resolveComputer: async () => pc,
      defaultComputer: async () => pc,
      hasLiveTask: async () => false,
      chatRuntimeReady: () => false,
      gate: async () => {
        if (denied) throw new Error('Not your task')
      }
    })
    await services.ownership.register({ ...identity, computerId: pc })
    denied = true
    await expect(services.relay.ops.kill('tab')).rejects.toThrow('Not your task')
    denied = false
    await expect(services.relay.ops.abortAndPop({ ...context, taskId: 'foreign' })).rejects.toThrow(
      /ownership|mismatch/i
    )
    await expect(
      services.relay.ops.abortAndPop({ ...context, mode: 'codex-chat' })
    ).rejects.toThrow(/ownership|mismatch/i)
    expect(calls).toEqual([])
    await expect(
      hub.gateway.request(pc, 'chat.request', {
        kind: 'invoke',
        value: {
          route: { id: identity.id, epoch: 1 },
          target: 'ops',
          method: 'restart',
          args: [context],
          operationId: 'blocked-restart'
        }
      })
    ).rejects.toThrow(/update|maintenance/i)
    await expect(
      hub.gateway.request(pc, 'chat.request', {
        kind: 'invoke',
        value: {
          route: { id: identity.id, epoch: 2 },
          target: 'ops',
          method: 'kill',
          args: ['tab'],
          operationId: 'stale-stop'
        }
      })
    ).rejects.toThrow(/epoch|mismatch/i)
    await expect(
      hub.gateway.request(pc, 'chat.request', {
        kind: 'invoke',
        value: {
          route: { id: identity.id, epoch: 1 },
          target: 'ops',
          method: 'kill',
          args: ['foreign-tab'],
          operationId: 'foreign-stop'
        }
      })
    ).rejects.toThrow(/ownership|mismatch/i)
    failClear = true
    await expect(services.relay.ops.abortAndPop(context)).rejects.toThrow('Queue clear unavailable')
    expect(calls).toHaveLength(1)
    expect(await control.rpc.request('health')).toMatchObject({ idle: false })
    failClear = false
    calls.length = 0
    const stopResult = { popped: false, text: null, id: null, content: null }
    await expect(
      services.relay.invoke('ops', 'abortAndPop', [context], 'maintenance-ui-stop')
    ).resolves.toEqual(stopResult)
    await expect(
      services.relay.invoke('ops', 'abortAndPop', [context], 'maintenance-ui-stop')
    ).resolves.toEqual(stopResult)
    expect(
      calls.map((call) => {
        const value = (
          call as {
            kind: string
            value: { target: string; method: string; args: unknown[]; route: unknown }
          }
        ).value
        return { target: value.target, method: value.method, args: value.args, route: value.route }
      })
    ).toEqual(
      Array.from({ length: 2 }, () => [
        { target: 'queue', method: 'clear', args: ['tab'], route: { id: identity.id, epoch: 1 } },
        { target: 'ops', method: 'kill', args: ['tab'], route: { id: identity.id, epoch: 1 } }
      ]).flat()
    )
    await expect(services.stopTask('t')).resolves.toBeUndefined()
    await vi.waitFor(
      async () => expect(await control.rpc.request('health')).toMatchObject({ idle: true }),
      { timeout: 10_000 }
    )
    expect(epoch.runs()).toHaveLength(1)
    expect(epoch.runs()[0].userMessages()).toEqual(['retained-original-message'])
    const folder = readdirSync(join(dir, 'computer-runtime'), { withFileTypes: true }).find(
      (e) => e.isDirectory() && /^[a-f0-9]{64}$/.test(e.name)
    )!
    const db = new Database(join(dir, 'computer-runtime', folder.name, 'chat.sqlite'), {
      readonly: true,
      fileMustExist: true
    })
    try {
      expect(
        db
          .prepare("SELECT count(*) n FROM records WHERE conversation_id=? AND kind='queue'")
          .get(identity.id)
      ).toEqual({ n: 0 })
      expect(
        JSON.stringify(
          db.prepare('SELECT event FROM events WHERE conversation_id=?').all(identity.id)
        )
      ).toContain('retained-original-message')
    } finally {
      db.close()
    }
  } finally {
    await connector?.stop()
    peer.close()
    control.close()
    await host.stop()
    await hub.close()
    h.cleanup()
    if (previousRoot === undefined) delete process.env.SLAYZONE_ROOT
    else process.env.SLAYZONE_ROOT = previousRoot
    rmSync(dir, { recursive: true, force: true })
  }
}, 40_000)
