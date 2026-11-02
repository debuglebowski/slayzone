import { execFile, fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  openSync,
  closeSync,
  unlinkSync
} from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { loadComputerConfigFile } from '@slayzone/platform/slayzone-config'
import { promisify } from 'node:util'
import {
  createUpgradeController,
  HostMaintenanceRequired,
  type UpgradeRelease,
  type UpgradeWorker
} from './auto-upgrade'
import { npmCommand } from './npm-command'
import { hostControl, hostEndpoint, runtimeDir, atomicRuntimeJson } from './session-host'
import type { LocalPeer } from '@slayzone/computer-runtime'
import { ensureComputerLauncher } from '@slayzone/platform/computer-launcher'
import type { ConnectorGrant } from './session-host'
import { effectiveHubUrls, type ComputerConfig } from './config'

const exec = promisify(execFile)
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const INTERVAL_MS = 30_000
const CONNECT_TIMEOUT_MS = 90_000
const WORKER_ENV = 'SLAYZONE_COMPUTER_UPGRADE_WORKER'
export const isUpgradeWorker = (): boolean => process.env[WORKER_ENV] === '1' && !!process.send

/** Stable public liveness endpoint, deliberately outside protocol/auth negotiation.
 * Never follow redirects to another origin; CA/hostname verification stays enabled.
 * Multi-hub computers upgrade only when every configured hub agrees on the release.
 */
export async function discoverHubRelease(hubUrls: string[], signal?: AbortSignal): Promise<string> {
  const versions = await Promise.all(
    hubUrls.map(async (hub) => {
      const url = new URL(hub)
      url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
      url.pathname = '/health'
      url.search = ''
      url.hash = ''
      const res = await fetch(url, {
        redirect: 'error',
        signal: AbortSignal.any([AbortSignal.timeout(10_000), ...(signal ? [signal] : [])])
      })
      if (!res.ok) throw new Error(`hub release discovery returned HTTP ${res.status}`)
      const data = (await res.json()) as { ok?: boolean; version?: unknown }
      if (
        data.ok !== true ||
        typeof data.version !== 'string' ||
        !RELEASE.test(data.version) ||
        data.version === '0.0.0'
      ) {
        throw new Error('hub does not advertise a published release on /health')
      }
      return data.version
    })
  )
  if (new Set(versions).size !== 1)
    throw new Error('configured hubs run different releases; upgrade deferred')
  return versions[0]
}

function atomicJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.tmp`
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  renameSync(temp, path)
}

export function releaseEntry(runtime: string, version: string): string {
  if (!RELEASE.test(version)) throw new Error('invalid computer release')
  return join(
    runtime,
    'releases',
    version,
    'node_modules',
    '@slayzone',
    'computer',
    'dist',
    'bin.cjs'
  )
}

/** Versioned private prefix, never mutates the live installation or enrollment.
 * Check the actual candidate bundle/native dependencies before publishing it.
 */
export async function installComputerRelease(
  runtime: string,
  version: string,
  signal?: AbortSignal,
  isInUse: (entry: string) => boolean = () => false
): Promise<string> {
  const entry = releaseEntry(runtime, version)
  if (existsSync(entry)) {
    try {
      const { stdout } = await exec(process.execPath, [entry, '--upgrade-probe'], {
        timeout: 30_000,
        signal
      })
      if (stdout.trim() === version) return entry
    } catch {
      signal?.throwIfAborted()
    }
  }
  // Only the non-running target release is installed here. Remove incomplete or
  // invalid caches so an interrupted download/native build cannot poison retries.
  if (isInUse(entry))
    throw new Error('cached release is in use and failed validation; maintenance required')
  rmSync(join(runtime, 'releases', version), { recursive: true, force: true })
  const releases = join(runtime, 'releases')
  mkdirSync(releases, { recursive: true })
  const staging = mkdtempSync(join(releases, '.install-'))
  try {
    const npm = npmCommand()
    await exec(
      npm.command,
      [
        ...npm.args,
        'install',
        '--prefix',
        staging,
        '--no-audit',
        '--no-fund',
        '--omit=dev',
        `@slayzone/computer@${version}`
      ],
      {
        signal,
        timeout: 300_000,
        maxBuffer: 4 * 1024 * 1024
      }
    )
    const candidate = join(staging, 'node_modules', '@slayzone', 'computer', 'dist', 'bin.cjs')
    const { stdout } = await exec(process.execPath, [candidate, '--upgrade-probe'], {
      timeout: 30_000,
      signal
    })
    if (stdout.trim() !== version) throw new Error('installed computer release failed validation')
    renameSync(staging, join(releases, version))
    return entry
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

type Log = (message: string, meta?: Record<string, unknown>) => void

export function launchUpgradeWorker(
  entry: string,
  config: ComputerConfig,
  probation = false,
  onShutdown: () => void = () => undefined,
  env: NodeJS.ProcessEnv = process.env,
  grant?: ConnectorGrant
): UpgradeWorker {
  const child = fork(entry, [], {
    env: { ...env, [WORKER_ENV]: '1', SLAYZONE_NONINTERACTIVE: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  // Attach before sending boot: errors/exits must never become unhandled events.
  let exited = false
  let connected = false
  let connectionError: Error | undefined
  const connectedHubs = new Set<string>()
  const waiting = new Set<() => void>()
  let activateReply: (() => void) | undefined
  let activateReject: ((err: Error) => void) | undefined
  let drainReply: ((idle: boolean) => void) | undefined
  const wake = (): void => {
    for (const fn of [...waiting]) fn()
  }
  child.on('error', (err) => {
    connectionError = err
    wake()
  })
  child.on('exit', (code, signal) => {
    exited = true
    connectionError = new Error(`computer worker exited (${code ?? signal})`)
    drainReply?.(false)
    activateReject?.(connectionError)
    wake()
  })
  child.on('message', (message: unknown) => {
    const msg = message as { type?: string; hubUrl?: string; idle?: boolean; error?: string }
    if (msg?.type === 'connected' && msg.hubUrl) {
      connectedHubs.add(msg.hubUrl)
      connected = effectiveHubUrls(config).every((url) => connectedHubs.has(url))
      wake()
    }
    if (msg?.type === 'disconnected' && msg.hubUrl) {
      connectedHubs.delete(msg.hubUrl)
      connected = false
    }
    if (msg?.type === 'shutdown') onShutdown()
    if (msg?.type === 'fatal') {
      connectionError = new Error(msg.error)
      activateReject?.(connectionError)
      wake()
    }
    if (msg?.type === 'activated') activateReply?.()
    if (msg?.type === 'drained') drainReply?.(msg.idle === true)
  })
  child.send({ type: 'boot', config, probation, grant }, () => undefined)
  let stopPromise: Promise<void> | undefined
  return {
    exited: () => exited,
    connected: () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => finish(new Error('upgraded computer did not reconnect before deadline')),
          CONNECT_TIMEOUT_MS
        )
        const finish = (err?: Error): void => {
          clearTimeout(timer)
          waiting.delete(check)
          if (err) reject(err)
          else resolve()
        }
        const check = (): void => {
          if (connectionError) finish(connectionError)
          else if (connected) finish()
        }
        waiting.add(check)
        check()
      }),
    probation: async (ms) => {
      if (ms <= 0) return
      const deadline = Date.now() + ms + CONNECT_TIMEOUT_MS
      let since = Date.now()
      while (Date.now() - since < ms) {
        if (connectionError || exited) throw connectionError ?? new Error('candidate exited')
        if (!connected) since = Date.now()
        if (Date.now() > deadline)
          throw new Error('candidate did not remain healthy during probation')
        await new Promise((resolve) => setTimeout(resolve, Math.min(250, ms)))
      }
    },
    activate: () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => finish(new Error('computer activation timed out')), 5000)
        const finish = (err?: Error): void => {
          clearTimeout(timer)
          activateReply = undefined
          activateReject = undefined
          if (err) reject(err)
          else resolve()
        }
        activateReply = () => finish()
        activateReject = finish
        child.send({ type: 'activate' }, (err) => {
          if (err) finish(err)
        })
      }),
    drain: () =>
      new Promise<boolean>((resolve) => {
        if (exited || !child.connected) {
          resolve(true)
          return
        }
        const timer = setTimeout(() => {
          drainReply = undefined
          resolve(false)
        }, 5000)
        drainReply = (idle) => {
          clearTimeout(timer)
          drainReply = undefined
          resolve(idle)
        }
        child.send({ type: 'drain' }, (err) => {
          if (err) drainReply?.(false)
        })
      }),
    stop: () =>
      (stopPromise ??= (async () => {
        if (exited) return
        const exit = once(child, 'exit').catch(() => undefined)
        const timer = setTimeout(() => child.kill('SIGKILL'), 10_000)
        child.kill('SIGTERM')
        await exit
        clearTimeout(timer)
      })())
  }
}

/** A detached session host is independent of the supervisor's inherited IPC. */
export async function ensureSessionHost(
  config: ComputerConfig,
  original: UpgradeRelease,
  root: string,
  notify?: (method: string, params: unknown) => void
): Promise<LocalPeer> {
  try {
    const live = await hostControl(root, notify)
    return live
  } catch (err) {
    if ((err as Error).message.includes('active work')) throw err
    /* Start only after ruling out a live owner. */
  }
  const runtime = runtimeDir(root)
  mkdirSync(runtime, { recursive: true, mode: 0o700 })
  try {
    const prior = JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8')) as { pid: number }
    try {
      process.kill(prior.pid, 0)
      throw new Error('existing session host is alive but unavailable; refusing duplicate')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
    }
    if (process.platform !== 'win32') {
      try {
        unlinkSync(hostEndpoint(root))
      } catch {
        /* Missing stale socket. */
      }
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  atomicRuntimeJson(join(runtime, 'host-config.json'), config)
  try {
    const service = JSON.parse(readFileSync(join(runtime, 'host-service.json'), 'utf8')) as {
      backend: string
      name: string
    }
    if (!/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(service.name))
      throw new Error('invalid host service name')
    if (service.backend === 'systemd')
      await exec(
        'systemctl',
        ['--user', 'restart', `slayzone-session-host-${service.name}.service`],
        { timeout: 10_000 }
      )
    else if (service.backend === 'launchd')
      await exec(
        'launchctl',
        ['kickstart', '-k', `gui/${process.getuid?.()}/com.slayzone.session-host.${service.name}`],
        { timeout: 10_000 }
      )
    else throw new Error('invalid host service backend')
    for (let i = 0; i < 100; i++) {
      try {
        return await hostControl(root, notify)
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
    throw new Error('registered session host did not start')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const out = openSync(join(runtime, 'host.log'), 'a', 0o600)
  const launcher = ensureComputerLauncher(root, original)
  const child = spawn(process.execPath, [launcher, '--session-host'], {
    env: {
      ...process.env,
      SLAYZONE_ROOT: root,
      SLAYZONE_NONINTERACTIVE: '1',
      SLAYZONE_SUPERVISED: '0',
      SLAYZONE_HUB_ADDRESS: new URL(config.hubUrl).host,
      SLAYZONE_HUB_JOIN_TOKEN: config.joinToken
    },
    detached: true,
    stdio: ['ignore', out, out]
  })
  closeSync(out)
  child.unref()
  let exited: Error | undefined
  child.once('error', (err) => {
    exited = err
  })
  child.once('exit', (code) => {
    exited = new Error(`session host exited during startup (${code})`)
  })
  for (let i = 0; i < 100; i++) {
    if (exited) throw exited
    try {
      return await hostControl(root, notify)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error('session host did not start; inspect computer-runtime/host.log')
}

/** Supervises one connector per hub; stopping a connector never stops its host. */
export async function superviseUpgrades(
  config: ComputerConfig,
  original: UpgradeRelease,
  root: string,
  log: Log,
  options: { probationMs?: number; intervalMs?: number } = {}
): Promise<{ stop(shutdownHost?: boolean): Promise<void> }> {
  const runtime = runtimeDir(root)
  mkdirSync(runtime, { recursive: true, mode: 0o700 })
  const control = await ensureSessionHost(config, original, root, (method) => {
    if (method === 'host.shutdown') void stop(true)
  })
  const abort = new AbortController()
  const controllers: ReturnType<typeof createUpgradeController>[] = []
  let stopping = false
  const committed = new Map<string, UpgradeRelease>()
  let maintenanceRunning = false
  let expectedHostStop = false
  let incompatibleHostTarget: UpgradeRelease | undefined
  const hostInfo = await control.rpc.request<import('./session-host').HostHealth>('health')
  const sharedInstalls = new Map<string, Promise<string>>()
  const install = (version: string): Promise<string> => {
    let pending = sharedInstalls.get(version)
    if (!pending) {
      pending = installComputerRelease(
        runtime,
        version,
        abort.signal,
        (entry) =>
          entry === original.entry ||
          entry === hostInfo.entry ||
          [...committed.values()].some((release) => release.entry === entry)
      )
      sharedInstalls.set(version, pending)
      void pending.then(
        () => sharedInstalls.delete(version),
        () => sharedInstalls.delete(version)
      )
    }
    return pending
  }
  for (const [index, hubUrl] of effectiveHubUrls(config).entries()) {
    const key = new URL(hubUrl).host.replace(/[^a-zA-Z0-9.-]/g, '_')
    const dir = join(runtime, 'hubs', key)
    mkdirSync(dir, { recursive: true })
    const pointer = join(dir, 'current.json')
    let initial: UpgradeRelease & {
      previous?: UpgradeRelease
      crashes?: number[]
      retryState?: import('@slayzone/computer-runtime').RetryState
    } = original
    try {
      const saved = JSON.parse(readFileSync(pointer, 'utf8')) as typeof initial
      if (
        typeof saved.entry === 'string' &&
        isAbsolute(saved.entry) &&
        RELEASE.test(saved.version) &&
        existsSync(saved.entry)
      ) {
        const checked = await exec(process.execPath, [saved.entry, '--upgrade-probe'], {
          timeout: 30_000
        })
        if (checked.stdout.trim() === saved.version) initial = saved
      }
    } catch {
      /* First boot. */
    }
    const crashFile = join(dir, 'crashes.json')
    try {
      initial = { ...initial, crashes: JSON.parse(readFileSync(crashFile, 'utf8')) }
    } catch {
      /* No recorded crashes. */
    }
    const retryFile = join(dir, 'retry.json')
    try {
      initial = { ...initial, retryState: JSON.parse(readFileSync(retryFile, 'utf8')) }
    } catch {
      /* First attempt. */
    }
    committed.set(hubUrl, initial)
    let displayedVersion = initial.version
    const scoped = {
      ...config,
      hubUrl,
      hubUrls: undefined,
      ...(index ? { joinToken: undefined } : {})
    }
    const launch = (entry: string, probation = false): UpgradeWorker => {
      let worker: UpgradeWorker | undefined
      let failure: Error | undefined
      let cancelled = false
      const starting = control.rpc
        .request<ConnectorGrant>('reserve', { hubUrl })
        .then((grant) => {
          worker = launchUpgradeWorker(
            entry,
            scoped,
            probation,
            () => {
              void stop(true)
            },
            { ...process.env, SLAYZONE_ROOT: root },
            grant
          )
          if (cancelled) void worker.stop()
          return worker
        })
        .catch((err) => {
          failure = err
          throw err
        })
      void starting.catch(() => undefined)
      return {
        exited: () => !!failure || worker?.exited?.() === true,
        connected: async () => (await starting).connected(),
        drain: async () => {
          await starting
          return true
        },
        activate: async () => (await starting).activate?.(),
        probation: async (ms) => (await starting).probation?.(ms),
        stop: async () => {
          cancelled = true
          await starting.then(
            (w) => w.stop(),
            () => undefined
          )
        }
      }
    }
    const controller = createUpgradeController(
      { ...initial, worker: launch(initial.entry) },
      {
        discover: () =>
          config.autoUpgrade === false
            ? Promise.resolve(initial.version)
            : discoverHubRelease([hubUrl], abort.signal),
        install,
        validate: async (release) => {
          const probe = await exec(process.execPath, [release.entry, '--runtime-contract'], {
            timeout: 30_000,
            signal: abort.signal
          })
          const contract = JSON.parse(probe.stdout) as { min: number; max: number }
          if (
            !Number.isSafeInteger(contract.min) ||
            !Number.isSafeInteger(contract.max) ||
            contract.min > contract.max
          )
            throw new Error('invalid connector runtime contract')
          if (hostInfo.contract < contract.min || hostInfo.contract > contract.max) {
            incompatibleHostTarget = release
            throw new HostMaintenanceRequired(
              'Connector requires session host maintenance; waiting for running work to finish'
            )
          }
          if (incompatibleHostTarget?.version === release.version)
            incompatibleHostTarget = undefined
        },
        launch,
        probationMs: options.probationMs,
        commit: async (release, previous) => {
          atomicJson(pointer, { ...release, ...(previous ? { previous } : {}) })
          displayedVersion = release.version
          committed.set(hubUrl, release)
        },
        recordRetry: async (state) => atomicJson(retryFile, state),
        recordCrashes: async (times) => atomicJson(crashFile, times),
        status: (phase, detail) => {
          const status = {
            phase,
            ...(hostInfo.version !== displayedVersion
              ? { maintenanceReason: 'Session host update waits for running work to finish' }
              : {}),
            currentVersion: displayedVersion,
            hostVersion: hostInfo.version,
            ...detail,
            ...(typeof detail.error === 'string' ? { error: detail.error.slice(0, 2048) } : {}),
            updatedAt: new Date().toISOString()
          }
          log(`auto-upgrade: ${phase}`, { hubUrl, ...detail })
          try {
            atomicJson(join(dir, 'upgrade-status.json'), status)
          } catch (err) {
            log('cannot persist upgrade status', { error: String(err) })
          }
          void reportUpgradeStatus(root, hubUrl, status).catch((err) =>
            log('cannot report upgrade status', { hubUrl, error: String(err) })
          )
        }
      }
    )
    controllers.push(controller)
  }
  const maintain = async (): Promise<void> => {
    if (
      stopping ||
      maintenanceRunning ||
      config.autoUpgrade === false ||
      !process.argv.includes('--supervisor')
    )
      return
    maintenanceRunning = true
    try {
      const primary = incompatibleHostTarget ?? committed.get(config.hubUrl)
      if (!primary) return
      const liveHost = await control.rpc.request<import('./session-host').HostHealth>('health')
      if (incompatibleHostTarget && !liveHost.idle) return
      const supervisorChange = primary.version !== original.version
      const hostChange = primary.version !== liveHost.version
      if (!supervisorChange && (!hostChange || !liveHost.idle)) return
      const role = supervisorChange ? 'supervisor' : 'host'
      try {
        const blocked = JSON.parse(readFileSync(join(runtime, role + '-quarantine.json'), 'utf8'))
        if (blocked.version === primary.version && blocked.until > Date.now()) return
      } catch {
        /* No quarantined runtime. */
      }
      const replaceHost = !supervisorChange || !!incompatibleHostTarget
      if (replaceHost) await control.rpc.request('prepare-maintenance')
      atomicJson(join(runtime, 'supervisor.json'), { current: primary, previous: original })
      atomicJson(join(runtime, 'host-release.json'), {
        current: primary,
        previous: { entry: liveHost.entry, version: liveHost.version }
      })
      if (replaceHost) {
        expectedHostStop = true
        await Promise.all(controllers.map((c) => c.stop()))
        await control.rpc.request('stop', { force: false })
      }
      await stop(false)
      process.exit(75)
    } finally {
      maintenanceRunning = false
    }
  }
  const interval = setInterval(() => {
    for (const c of controllers) void c.check()
    void maintain().catch((err) => log('runtime maintenance failed', { error: String(err) }))
  }, options.intervalMs ?? INTERVAL_MS)
  for (const c of controllers) void c.check()
  control.socket.once('close', () => {
    if (!stopping && !expectedHostStop)
      void stop().then(() => {
        if (process.argv.includes('--supervisor')) process.exit(1)
      })
  })
  const onStop = (): void => {
    void stop(true)
  }
  const stop = async (shutdownHost = false): Promise<void> => {
    if (stopping) return
    stopping = true
    clearInterval(interval)
    abort.abort()
    process.off('SIGINT', onStop)
    process.off('SIGTERM', onStop)
    await Promise.all(controllers.map((c) => c.stop()))
    if (shutdownHost) await control.rpc.request('stop', { force: true }).catch(() => undefined)
    control.close()
  }
  process.on('SIGINT', onStop)
  process.on('SIGTERM', onStop)
  process.send?.({ type: 'supervisor-ready' }, () => undefined)
  return { stop }
}

async function reportUpgradeStatus(
  root: string,
  hub: string,
  status: Record<string, unknown>
): Promise<void> {
  const { createFileCredentialStore, hubHostFromUrl } = await import(
    '@slayzone/computer-transport/client'
  )
  const saved = await createFileCredentialStore(hubHostFromUrl(hub), { baseDir: root }).load()
  if (!saved) return
  const url = new URL(hub)
  url.protocol = url.protocol === 'wss:' ? 'https:' : 'http:'
  url.pathname = '/api/computers/upgrade-status'
  url.search = ''
  url.hash = ''
  const response = await fetch(url, {
    method: 'PUT',
    redirect: 'error',
    headers: { authorization: `Bearer ${saved.apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(status),
    signal: AbortSignal.timeout(10_000)
  })
  if (!response.ok) throw new Error(`hub status report returned HTTP ${response.status}`)
}

/** First boot message contains resolved config; no secrets added to inherited env. */
export async function receiveUpgradeBoot(): Promise<{
  config: ComputerConfig
  probation: boolean
  grant?: ConnectorGrant
}> {
  const [msg] = (await once(process, 'message')) as [
    { type: string; config: ComputerConfig; probation: boolean; grant?: ConnectorGrant }
  ]
  if (msg.type !== 'boot') throw new Error('invalid computer supervisor boot message')
  return msg
}
