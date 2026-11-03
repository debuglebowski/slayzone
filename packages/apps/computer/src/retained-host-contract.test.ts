import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, test, vi } from 'vitest'
import { startLoopbackHub } from '../../../domains/computer-transport/src/testing/loopback'
import { HOST_CONTRACT_VERSION } from '@slayzone/computer-runtime'
import { COMPUTER_PROTOCOL_VERSION } from '@slayzone/computer-transport/shared'
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
    .replace(/var HOST_CONTRACT_VERSION = \d+;/, `var HOST_CONTRACT_VERSION = ${contract};`)
    .replace(
      /\bCOMPUTER_PROTOCOL_VERSION = \d+;/,
      `COMPUTER_PROTOCOL_VERSION = ${COMPUTER_PROTOCOL_VERSION - 1};`
    )
  expect(source).toContain(`var HOST_CONTRACT_VERSION = ${contract};`)
  expect(source).toContain(`COMPUTER_PROTOCOL_VERSION = ${COMPUTER_PROTOCOL_VERSION - 1};`)
  source = source
    .replace(
      'getTabState: external_exports.tuple([id, tabStateScope.optional()]),',
      'getTabState: external_exports.tuple([id]),'
    )
    .replace(
      'saveTabDraft: external_exports.tuple([id, chatDraftSchema, tabStateScope.optional()]),',
      'saveTabDraft: external_exports.tuple([id, chatDraftSchema]),'
    )
  expect(source).toContain('getTabState: external_exports.tuple([id]),')
  const queue = /var queueOptions = ([\s\S]*?)\nvar chatQueueOperationSchemas/.exec(source)
  expect(queue).not.toBeNull()
  source = source.replace(queue![0], queue![0].replace(/^ {2}expectedMode:.*\n/m, ''))
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
      await native.rpc.request('dispatch', {
        method: 'proc.spawn',
        params: {
          sessionId: 'running-native',
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
            projectId: null,
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
      /var COMPUTER_VERSION = [^;]+;/,
      'var COMPUTER_VERSION = "1.0.0";'
    )
  )
  const candidate = join(root, 'current-v3.cjs')
  const current = readFileSync(resolve(import.meta.dirname, '../dist/bin.cjs'), 'utf8')
    .replace(
      /var HOST_CONTRACT_VERSION = \d+;/,
      `var HOST_CONTRACT_VERSION = ${HOST_CONTRACT_VERSION};`
    )
    .replace(/var COMPUTER_VERSION = [^;]+;/, 'var COMPUTER_VERSION = "1.0.0";')
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
    await native.rpc.request('dispatch', {
      method: 'proc.spawn',
      actor,
      params: {
        sessionId: 'retained-native',
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
