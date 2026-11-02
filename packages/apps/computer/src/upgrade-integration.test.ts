import { TEST_ISOLATION_ENV } from '../../../shared/test-utils/caller-env.js'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, expect, it, vi } from 'vitest'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { createUpgradeController, type UpgradeWorker } from './auto-upgrade'
import { launchUpgradeWorker, releaseEntry, superviseUpgrades } from './upgrade-runtime'

const eventually = <T>(check: () => T, options: { timeout?: number; interval?: number } = {}) =>
  vi.waitFor(check, { timeout: 10_000, ...options })

const require = createRequire(import.meta.url)
const cleanups: Array<() => Promise<unknown> | unknown> = []
afterEach(async () => {
  const errors: unknown[] = []
  while (cleanups.length) {
    try {
      await cleanups.pop()!()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length) throw new AggregateError(errors, 'upgrade fixture cleanup failed')
}, 30_000)

it('native release probe completes through terminal readiness, input and exit', async () => {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [resolve(import.meta.dirname, '../dist/bin.cjs'), '--upgrade-probe'],
    { timeout: 15_000 }
  )
  const { version } = JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../package.json'), 'utf8')
  )
  expect(stdout.trim()).toBe(version)
}, 20_000)

it('hub protocol upgrade → fatal old hello → exact release → same enrollment reconnect; failed candidate retries', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-upgrade-integration-'))
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  )
  symlinkSync(
    dirname(dirname(require.resolve('node-pty/package.json'))),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const source = readFileSync(resolve(import.meta.dirname, '../dist/bin.cjs'), 'utf8')
  const oldEntry = join(root, 'old.cjs')
  const newEntry = join(root, 'new.cjs')
  const badEntry = join(root, 'bad.cjs')
  // Build fixtures from the actual standalone bundle. Only release/protocol differ.
  const versioned = (version: string) =>
    source.replace(
      /var COMPUTER_VERSION = [^;]+;/,
      `var COMPUTER_VERSION = ${JSON.stringify(version)};`
    )
  writeFileSync(
    oldEntry,
    versioned('1.0.0').replace('COMPUTER_PROTOCOL_VERSION = 4;', 'COMPUTER_PROTOCOL_VERSION = 3;')
  )
  writeFileSync(newEntry, versioned('2.0.0'))
  writeFileSync(badEntry, 'process.exit(1)')
  const hub = await startLoopbackHub({ floodLimits: false })
  cleanups.push(() => hub.close())
  let upgraded = false
  // Before the upgrade the hub speaks v3; afterwards its real v4 gate rejects it.
  // This shim translates only handshake versions, preserving real auth/RPC/storage.
  hub.wss.prependListener('connection', (socket) => {
    const emit = socket.emit.bind(socket)
    socket.emit = ((event: string, ...args: unknown[]) => {
      if (event === 'message' && !upgraded) {
        const frame = JSON.parse(String(args[0]))
        if (frame.params?.protocolVersion === 3) {
          frame.params.protocolVersion = 4
          args[0] = Buffer.from(JSON.stringify(frame))
        }
      }
      return emit(event, ...args)
    }) as typeof socket.emit
    const send = socket.send.bind(socket)
    socket.send = ((data: string, ...args: unknown[]) => {
      if (!upgraded) {
        const frame = JSON.parse(String(data))
        if (frame.result?.protocolVersion === 4) {
          frame.result.protocolVersion = 3
          data = JSON.stringify(frame)
        }
      }
      return (send as (...args: unknown[]) => void)(data, ...args)
    }) as typeof socket.send
  })
  const config = {
    hubUrl: hub.url,
    name: 'golden-comet',
    allowedRoots: [root],
    capabilities: ['fs', 'proc', 'pty'],
    joinToken: 'jt-valid'
  }
  const configFile = join(root, 'computer.config.json')
  writeFileSync(
    configFile,
    JSON.stringify({ computerName: config.name, allowedRoots: [root], autoUpgrade: true })
  )
  const configBefore = readFileSync(configFile, 'utf8')
  const env = { ...process.env, SLAYZONE_ROOT: root }
  const workers: UpgradeWorker[] = []
  const launch = (entry: string, probation = false) => {
    const worker = launchUpgradeWorker(entry, config, probation, undefined, env)
    workers.push(worker)
    return worker
  }
  cleanups.push(async () => {
    await Promise.all(workers.map((w) => w.stop()))
  })
  const old = launch(oldEntry)
  await old.connected()
  const id = hub.gateway.listComputers()[0].computerId
  expect(hub.auth.enrollCalls).toHaveLength(1)
  let fail = true
  const commit = vi.fn(async () => {})
  const status = vi.fn()
  const controller = createUpgradeController(
    { version: '1.0.0', entry: oldEntry, worker: old },
    {
      discover: async () => (upgraded ? '2.0.0' : '1.0.0'),
      install: async () => (fail ? badEntry : newEntry),
      retry: false,
      probationMs: 0,
      launch,
      commit,
      status
    }
  )
  cleanups.push(() => controller.stop())
  upgraded = true
  hub.gateway.disconnect(id, 'hub release upgraded')
  await eventually(() => expect(hub.gateway.listComputers()).toHaveLength(0))
  await eventually(async () => {
    await expect(old.connected()).rejects.toThrow('protocol')
  })
  // Install succeeds but candidate crashes. Supervisor restores old worker and stays alive.
  await controller.check()
  expect(commit).not.toHaveBeenCalled()
  expect(status).toHaveBeenLastCalledWith('failed', expect.objectContaining({ target: '2.0.0' }))
  await eventually(async () => {
    await expect(workers.at(-1)!.connected()).rejects.toThrow('protocol')
  })
  fail = false
  await controller.check()
  expect(commit).toHaveBeenCalledWith(
    { version: '2.0.0', entry: newEntry },
    { version: '1.0.0', entry: oldEntry }
  )
  expect(hub.gateway.listComputers()[0].computerId).toBe(id)
  expect(hub.gateway.listComputers()[0].version).toBe('2.0.0')
  expect(hub.auth.enrollCalls).toHaveLength(1)
  expect(hub.auth.helloCalls.length).toBeGreaterThan(0)
  expect(readFileSync(configFile, 'utf8')).toBe(configBefore)
  const latest = workers.at(-1)!
  await hub.gateway.request(id, 'proc.spawn', {
    sessionId: 'active-job',
    command: process.execPath,
    args: ['-e', 'setInterval(() => {}, 1000)'],
    cwd: root
  })
  expect(await latest.drain()).toBe(false)
  await hub.gateway.request(id, 'proc.kill', { sessionId: 'active-job' })
  await eventually(async () => {
    expect(await latest.drain()).toBe(true)
  })
  await expect(hub.gateway.request(id, 'fs.pathExists', { path: root })).rejects.toThrow(
    'restarting'
  )
  await latest.activate?.()
  // Latest worker accepts work only after activation and still enforces allowed roots.
  await eventually(async () => {
    await expect(hub.gateway.request(id, 'fs.pathExists', { path: root })).resolves.toEqual({
      exists: true
    })
  })
  await expect(hub.gateway.request(id, 'fs.pathExists', { path: dirname(root) })).rejects.toThrow(
    'outside'
  )
}, 30_000)

it('supervisor discovers hub release, persists progress and resumes the upgraded runtime after restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-upgrade-supervisor-'))
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  )
  symlinkSync(
    dirname(dirname(require.resolve('node-pty/package.json'))),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const source = readFileSync(resolve(import.meta.dirname, '../dist/bin.cjs'), 'utf8')
  const oldEntry = join(root, 'old.cjs')
  writeFileSync(
    oldEntry,
    source.replace(/var COMPUTER_VERSION = [^;]+;/, 'var COMPUTER_VERSION = "1.0.0";')
  )
  const runtime = join(root, 'computer-runtime')
  const targetEntry = releaseEntry(runtime, '2.0.0')
  mkdirSync(dirname(targetEntry), { recursive: true })
  writeFileSync(
    targetEntry,
    source.replace(/var COMPUTER_VERSION = [^;]+;/, 'var COMPUTER_VERSION = "2.0.0";')
  )
  const server = http.createServer((_req, res) =>
    res.end(JSON.stringify({ ok: true, version: '2.0.0' }))
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const hub = await startLoopbackHub({ floodLimits: false }, { server })
  cleanups.push(() => hub.close())
  const { port } = server.address() as AddressInfo
  const config = {
    hubUrl: `ws://127.0.0.1:${port}/computers`,
    name: 'supervisor-test',
    allowedRoots: [root],
    capabilities: ['fs'],
    joinToken: 'jt-valid'
  }
  writeFileSync(join(root, 'computer.config.json'), JSON.stringify({ allowedRoots: [root] }))
  const reconciliations: Promise<boolean>[] = []
  hub.gateway.events.on('computer-connected', ({ computer }) => {
    if (computer.version === '2.0.0') {
      reconciliations.push(
        hub.gateway.request(computer.computerId, 'fs.pathExists', { path: root }).then(
          () => true,
          () => false
        )
      )
    }
  })
  const log = vi.fn()
  const original = { version: '1.0.0', entry: oldEntry }
  const first = await superviseUpgrades(config, original, root, log, { probationMs: 0 })
  cleanups.push(() => first.stop(true))
  await eventually(
    () => {
      const status = JSON.parse(
        readFileSync(join(runtime, 'hubs', `127.0.0.1_${port}`, 'upgrade-status.json'), 'utf8')
      )
      expect(status.phase, JSON.stringify(status)).toBe('connected')
      expect(status.version).toBe('2.0.0')
    },
    { timeout: 10_000 }
  )
  const id = hub.gateway.listComputers()[0].computerId
  expect(
    JSON.parse(readFileSync(join(runtime, 'hubs', `127.0.0.1_${port}`, 'current.json'), 'utf8'))
  ).toEqual({
    version: '2.0.0',
    entry: targetEntry,
    previous: original
  })
  expect(await reconciliations[0]).toBe(true)
  await first.stop()
  const resumed = await superviseUpgrades(config, original, root, log, { probationMs: 0 })
  cleanups.push(() => resumed.stop(true))
  await eventually(() => {
    expect(hub.gateway.listComputers()[0]?.version).toBe('2.0.0')
    expect(hub.gateway.listComputers()[0]?.computerId).toBe(id)
  })
  expect(hub.auth.enrollCalls).toHaveLength(1)
  expect(await Promise.all(reconciliations)).toEqual([true, true])
}, 30_000)

it('hub upgrade, failed candidate, retry and supervisor restart preserve active work', async () => {
  const root = mkdtempSync(join(tmpdir(), 'computer-live-upgrade-'))
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  )
  symlinkSync(
    dirname(dirname(require.resolve('node-pty/package.json'))),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const source = readFileSync(resolve(import.meta.dirname, '../dist/bin.cjs'), 'utf8')
  const oldEntry = join(root, 'old.cjs')
  writeFileSync(
    oldEntry,
    source.replace(/var COMPUTER_VERSION = [^;]+;/, 'var COMPUTER_VERSION = "1.0.0";')
  )
  const target = releaseEntry(join(root, 'computer-runtime'), '2.0.0')
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(
    target,
    source.replace(/var COMPUTER_VERSION = [^;]+;/, 'var COMPUTER_VERSION = "2.0.0";')
  )
  let release = '1.0.0'
  let failCandidate = true
  const server = http.createServer((_req, res) =>
    res.end(JSON.stringify({ ok: true, version: release }))
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const hub = await startLoopbackHub({ floodLimits: false }, { server })
  cleanups.push(() => hub.close())
  hub.wss.prependListener('connection', (socket) => {
    let generation = 0
    const emit = socket.emit.bind(socket),
      send = socket.send.bind(socket)
    socket.emit = ((event: string, ...args: unknown[]) => {
      if (event === 'message') {
        const frame = JSON.parse(String(args[0]))
        generation = frame.params?.connectorGeneration ?? generation
        if (release === '2.0.0' && generation === 1 && frame.method === 'hello') {
          frame.params.protocolVersion = 3
          args[0] = Buffer.from(JSON.stringify(frame))
        }
      }
      return emit(event, ...args)
    }) as typeof socket.emit
    socket.send = ((data: string, ...args: unknown[]) => {
      const frame = JSON.parse(String(data))
      if (generation === 2 && frame.result?.protocolVersion && failCandidate) {
        failCandidate = false
        frame.result.protocolVersion = 5
        data = JSON.stringify(frame)
      }
      return (send as (...args: unknown[]) => void)(data, ...args)
    }) as typeof socket.send
  })
  const { port } = server.address() as AddressInfo
  const config = {
    hubUrl: `ws://127.0.0.1:${port}/computers`,
    name: 'live-upgrade',
    allowedRoots: [root],
    capabilities: ['pty', 'proc'],
    joinToken: 'jt-valid'
  }
  writeFileSync(join(root, 'computer.config.json'), JSON.stringify({ allowedRoots: [root] }))
  const phases: string[] = []
  const original = { version: '1.0.0', entry: oldEntry }
  let supervisor = await superviseUpgrades(
    config,
    original,
    root,
    (message) => phases.push(message),
    { probationMs: 50, intervalMs: 100 }
  )
  cleanups.push(() => supervisor.stop(true))
  await eventually(() => expect(hub.gateway.listComputers()).toHaveLength(1), { timeout: 10_000 })
  const id = hub.gateway.listComputers()[0].computerId
  const epoch = hub.gateway.listComputers()[0].epoch
  await hub.gateway.request(id, 'pty.spawn', {
    sessionId: 'idle',
    command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    cwd: root
  })
  await hub.gateway.request(id, 'proc.spawn', {
    sessionId: 'working',
    command: process.execPath,
    args: ['-e', 'setInterval(()=>{},1000)'],
    cwd: root
  })
  const terminal = await hub.gateway.request(id, 'pty.list'),
    job = await hub.gateway.request(id, 'proc.list')
  release = '2.0.0'
  hub.gateway.disconnect(id, 'hub upgraded')
  await eventually(() => expect(phases).toContain('auto-upgrade: failed'), { timeout: 10_000 })
  await eventually(() => expect(phases).toContain('auto-upgrade: connected'), { timeout: 15_000 })
  await eventually(() => expect(hub.gateway.listComputers()[0]?.version).toBe('2.0.0'), {
    timeout: 15_000
  })
  expect(
    (
      await hub.gateway.request<{ sessions: Array<{ sessionId: string; pid: number }> }>(
        id,
        'pty.list'
      )
    ).sessions.map(({ sessionId, pid }) => ({ sessionId, pid }))
  ).toEqual(
    (terminal as { sessions: Array<{ sessionId: string; pid: number }> }).sessions.map(
      ({ sessionId, pid }) => ({ sessionId, pid })
    )
  )
  expect(await hub.gateway.request(id, 'proc.list')).toEqual(job)
  expect(hub.gateway.listComputers()[0].epoch).toBe(epoch)
  await supervisor.stop()
  supervisor = await superviseUpgrades(config, original, root, () => undefined, {
    probationMs: 0,
    intervalMs: 100
  })
  await eventually(() => expect(hub.gateway.listComputers()[0]?.version).toBe('2.0.0'), {
    timeout: 10_000
  })
  expect(await hub.gateway.request(id, 'proc.list')).toEqual(job)
  expect(
    (
      await hub.gateway.request<{ sessions: Array<{ sessionId: string; pid: number }> }>(
        id,
        'pty.list'
      )
    ).sessions.map(({ sessionId, pid }) => ({ sessionId, pid }))
  ).toEqual(
    (terminal as { sessions: Array<{ sessionId: string; pid: number }> }).sessions.map(
      ({ sessionId, pid }) => ({ sessionId, pid })
    )
  )
  expect(hub.auth.enrollCalls).toHaveLength(1)
}, 40_000)

it('stable launcher replaces supervisor and later idle host after a hub release change', async () => {
  const { spawn } = await import('node:child_process')
  const { hostControl } = await import('./session-host')
  const root = mkdtempSync(join(tmpdir(), 'computer-launcher-integration-'))
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  )
  symlinkSync(
    dirname(dirname(require.resolve('node-pty/package.json'))),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const source = readFileSync(resolve(import.meta.dirname, '../dist/bin.cjs'), 'utf8')
    .replace('var INTERVAL_MS = 3e4;', 'var INTERVAL_MS = 100;')
    .replace(/deps\w*\.probationMs \?\? 6e4/, '50')
  const oldEntry = join(root, 'original.cjs')
  writeFileSync(
    oldEntry,
    source.replace(/var COMPUTER_VERSION = [^;]+;/, 'var COMPUTER_VERSION = "1.0.0";')
  )
  const targetEntry = releaseEntry(join(root, 'computer-runtime'), '2.0.0')
  mkdirSync(dirname(targetEntry), { recursive: true })
  writeFileSync(
    targetEntry,
    source.replace(/var COMPUTER_VERSION = [^;]+;/, 'var COMPUTER_VERSION = "2.0.0";')
  )
  let release = '1.0.0'
  const server = http.createServer((_req, res) =>
    res.end(JSON.stringify({ ok: true, version: release }))
  )
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())))
  const hub = await startLoopbackHub({ floodLimits: false }, { server })
  cleanups.push(() => hub.close())
  let upgradedConnections = 0
  hub.gateway.events.on('computer-connected', ({ computer }) => {
    if (computer.version === '2.0.0') upgradedConnections++
  })
  const { port } = server.address() as AddressInfo
  writeFileSync(
    join(root, 'computer.config.json'),
    JSON.stringify({ hubUrl: `ws://127.0.0.1:${port}/computers`, allowedRoots: [root] })
  )
  let output = ''
  const child = spawn(process.execPath, [oldEntry], {
    env: {
      ...process.env,
      HOME: root,
      USERPROFILE: root,
      XDG_CONFIG_HOME: join(root, '.config'),
      SLAYZONE_ROOT: root,
      SLAYZONE_SUPERVISED: '0',
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${port}`,
      SLAYZONE_HUB_JOIN_TOKEN: 'jt-valid',
      SLAYZONE_NONINTERACTIVE: '1'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  const stopForeground = async () => {
    if (child.exitCode !== null) return
    const exit = once(child, 'exit')
    if (process.platform === 'win32') {
      // Windows has no graceful POSIX signals. Stop the fixture's entire
      // process tree, including its detached host, rather than orphaning it.
      const { promisify } = await import('node:util')
      const { execFile } = await import('node:child_process')
      // taskkill may report a descendant that exited during tree enumeration.
      await promisify(execFile)('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        timeout: 10_000
      }).catch(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      })
    } else child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
    await exit
    clearTimeout(timer)
  }
  cleanups.push(async () => {
    await stopForeground()
    const peer = await hostControl(root).catch(() => undefined)
    if (peer) {
      await peer.rpc.request('stop', { force: true }).catch(() => undefined)
      peer.close()
    }
  })
  await eventually(() => expect(hub.gateway.listComputers(), output).toHaveLength(1), {
    timeout: 15_000
  })
  const id = hub.gateway.listComputers()[0].computerId
  await hub.gateway.request(id, 'pty.spawn', {
    sessionId: 'preserved',
    command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    cwd: root
  })
  const sessions = await hub.gateway.request(id, 'pty.list')
  const host = await hostControl(root)
  const before = await host.rpc.request<{ pid: number; epoch: string; version: string }>('health')
  host.close()
  release = '2.0.0'
  await eventually(
    () => {
      expect(hub.gateway.listComputers()[0]?.version, output).toBe('2.0.0')
      // The first v2 connector precedes the supervisor handoff. Wait for its
      // replacement, otherwise the next RPC races the intentional disconnect.
      expect(upgradedConnections, output).toBeGreaterThanOrEqual(2)
      expect(
        JSON.parse(readFileSync(join(root, 'computer-runtime', 'supervisor.json'), 'utf8')).current
          .version
      ).toBe('2.0.0')
    },
    { timeout: 15_000 }
  )
  const attached = await hostControl(root)
  expect(await attached.rpc.request('health')).toMatchObject(before)
  attached.close()
  const identity = (value: unknown) =>
    (value as { sessions: Array<{ sessionId: string; pid: number }> }).sessions.map(
      ({ sessionId, pid }) => ({ sessionId, pid })
    )
  expect(identity(await hub.gateway.request(id, 'pty.list'))).toEqual(identity(sessions))
  await hub.gateway.request(id, 'pty.kill', { sessionId: 'preserved' })
  await eventually(
    async () => {
      const peer = await hostControl(root)
      try {
        expect(await peer.rpc.request('health'), output).toMatchObject({ version: '2.0.0' })
      } finally {
        peer.close()
      }
    },
    { timeout: 15_000 }
  )
  expect(hub.auth.enrollCalls).toHaveLength(1)
  const lastHost = await hostControl(root)
  const { pid } = await lastHost.rpc.request<{ pid: number }>('health')
  lastHost.close()
  await stopForeground()
  await eventually(
    () => {
      let alive = true
      try {
        process.kill(pid, 0)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') alive = false
      }
      expect(alive).toBe(false)
    },
    { timeout: 3000 }
  )
}, 60_000)

it('changed hub configuration waits for active work then reloads with auto-upgrades disabled', async () => {
  const { spawn } = await import('node:child_process')
  const { hostControl } = await import('./session-host')
  const root = mkdtempSync(join(tmpdir(), 'computer-config-maintenance-'))
  cleanups.push(() =>
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  )
  symlinkSync(
    dirname(dirname(require.resolve('node-pty/package.json'))),
    join(root, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  const source = readFileSync(resolve(import.meta.dirname, '../dist/bin.cjs'), 'utf8')
    .replace('var INTERVAL_MS = 3e4;', 'var INTERVAL_MS = 100;')
    .replace(
      '#!/usr/bin/env node',
      `#!/usr/bin/env node\nif(process.argv.includes('--supervisor')) require('node:fs').writeFileSync(require('node:path').join(process.env.SLAYZONE_ROOT,'supervisor-pid'),String(process.pid));`
    )
  const entry = join(root, 'computer.cjs')
  writeFileSync(entry, source)
  const first = await startLoopbackHub({ floodLimits: false }),
    second = await startLoopbackHub({ floodLimits: false })
  cleanups.push(() => first.close())
  cleanups.push(() => second.close())
  const configPath = join(root, 'computer.config.json')
  writeFileSync(
    configPath,
    JSON.stringify({ hubUrl: first.url, allowedRoots: [root], autoUpgrade: false })
  )
  let output = ''
  const child = spawn(process.execPath, [entry], {
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => !key.startsWith('SLAYZONE_') || TEST_ISOLATION_ENV.has(key)
        )
      ),
      HOME: root,
      USERPROFILE: root,
      SLAYZONE_ROOT: root,
      SLAYZONE_NONINTERACTIVE: '1',
      SLAYZONE_HUB_JOIN_TOKEN: 'jt-valid'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', (chunk) => (output += chunk))
  child.stderr.on('data', (chunk) => (output += chunk))
  cleanups.push(async () => {
    if (child.exitCode === null) {
      const exit = once(child, 'exit')
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 10000)
      await exit
      clearTimeout(timer)
    }
    const peer = await hostControl(root).catch(() => undefined)
    if (peer) {
      await peer.rpc.request('stop', { force: true }).catch(() => undefined)
      peer.close()
    }
  })
  await eventually(() => expect(first.gateway.listComputers(), output).toHaveLength(1), {
    timeout: 15000
  })
  const id = first.gateway.listComputers()[0].computerId
  await first.gateway.request(id, 'pty.spawn', {
    sessionId: 'active',
    command: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh',
    cwd: root
  })
  const list = await first.gateway.request<{ sessions: Array<{ pid: number }> }>(id, 'pty.list'),
    shellPid = list.sessions[0].pid
  const before = await hostControl(root),
    health = await before.rpc.request<{ epoch: string; pid: number }>('health')
  before.close()
  writeFileSync(
    configPath,
    JSON.stringify({ hubUrl: second.url, allowedRoots: [root], autoUpgrade: false })
  )
  process.kill(Number(readFileSync(join(root, 'supervisor-pid'), 'utf8')), 'SIGKILL')
  const statusPath = join(
    root,
    'computer-runtime',
    'hubs',
    new URL(second.url).host.replace(/[^a-zA-Z0-9.-]/g, '_'),
    'upgrade-status.json'
  )
  await eventually(
    () =>
      expect(JSON.parse(readFileSync(statusPath, 'utf8')).phase, output).toBe(
        'maintenance-required'
      ),
    { timeout: 15000 }
  )
  const same = await hostControl(root)
  expect(await same.rpc.request('health')).toMatchObject(health)
  same.close()
  expect(() => process.kill(shellPid, 0)).not.toThrow()
  process.kill(shellPid, 'SIGKILL')
  await eventually(() => expect(second.gateway.listComputers(), output).toHaveLength(1), {
    timeout: 15000
  })
  const reloaded = await hostControl(root)
  expect((await reloaded.rpc.request<{ epoch: string }>('health')).epoch).not.toBe(health.epoch)
  reloaded.close()
  expect(JSON.parse(readFileSync(configPath, 'utf8')).autoUpgrade).toBe(false)
}, 60000)
