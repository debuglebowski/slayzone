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
  fstatSync,
  readSync
} from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { readComputerConfigSnapshot } from '@slayzone/platform/slayzone-config'
import { promisify } from 'node:util'
import {
  createUpgradeController,
  HostMaintenanceRequired,
  type UpgradeRelease,
  type UpgradeWorker
} from './auto-upgrade'
import { npmCommand } from './npm-command'
import { hostControl, runtimeDir, atomicRuntimeJson } from './session-host'
import type { LocalPeer } from '@slayzone/computer-runtime'
import { ensureComputerLauncher } from '@slayzone/platform/computer-launcher'
import {
  HostLauncherBusyError,
  queryHostLauncher,
  type HostLauncherStatus
} from '@slayzone/platform/computer-endpoints'
import { hubAddrFromUrl } from '@slayzone/platform/hub-addr'
import type { ConnectorGrant } from './session-host'
import { rotateLogFile } from './file-log'
import {
  effectiveHubUrls,
  hostConfigurationKey,
  type ComputerConfig,
  type ComputerBootSeed
} from './config'

const exec = promisify(execFile)
const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
const INTERVAL_MS = 30_000
const CONNECT_TIMEOUT_MS = 90_000
const WORKER_ENV = 'SLAYZONE_COMPUTER_UPGRADE_WORKER'
export const isUpgradeWorker = (): boolean => process.env[WORKER_ENV] === '1' && !!process.send

interface RuntimeContract {
  min: number
  max: number
  fullChatMin?: number
  maintenanceMin?: number
  version?: string
  buildId?: string
}
async function probeRuntimeContract(entry: string, signal?: AbortSignal): Promise<RuntimeContract> {
  const probe = await exec(process.execPath, [entry, '--runtime-contract'], {
    timeout: 30_000,
    signal
  })
  const contract = JSON.parse(probe.stdout) as RuntimeContract
  if (
    !Number.isSafeInteger(contract.min) ||
    !Number.isSafeInteger(contract.max) ||
    contract.min > contract.max ||
    (contract.fullChatMin !== undefined &&
      (!Number.isSafeInteger(contract.fullChatMin) ||
        contract.fullChatMin < contract.min ||
        contract.fullChatMin > contract.max)) ||
    (contract.maintenanceMin !== undefined &&
      (!Number.isSafeInteger(contract.maintenanceMin) ||
        contract.maintenanceMin < 1 ||
        contract.maintenanceMin > contract.min)) ||
    (contract.buildId !== undefined && typeof contract.buildId !== 'string') ||
    (contract.version !== undefined &&
      (typeof contract.version !== 'string' || !RELEASE.test(contract.version)))
  )
    throw new Error('invalid connector runtime contract')
  return contract
}
function canBridgeMaintenance(contract: RuntimeContract, host: number): boolean {
  return (
    host >= contract.min &&
    host >= (contract.maintenanceMin ?? contract.min) &&
    host < (contract.fullChatMin ?? contract.min)
  )
}
function needsHostMaintenance(contract: RuntimeContract, host: number): boolean {
  return host < (contract.fullChatMin ?? contract.min) || host > contract.max
}

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

/** The last `maxBytes` of a log, trimmed to whole lines, as one line. Never throws. */
export function readLogTail(path: string, maxBytes = 1500): string {
  try {
    const fd = openSync(path, 'r')
    try {
      const size = fstatSync(fd).size
      const length = Math.min(size, maxBytes)
      const buffer = Buffer.alloc(length)
      readSync(fd, buffer, 0, length, size - length)
      const lines = buffer.toString('utf8').split('\n')
      if (length < size) lines.shift()
      return lines
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' | ')
    } finally {
      closeSync(fd)
    }
  } catch {
    return ''
  }
}

/** One in-flight report plus the latest pending state; old phases cannot arrive last. */
export function createStatusReporter(
  send: (status: Record<string, unknown>) => Promise<void>,
  onError: (error: unknown) => void
): (status: Record<string, unknown>) => void {
  let pending: Record<string, unknown> | undefined
  let sending = false
  return (status) => {
    pending = status
    if (sending) return
    sending = true
    void (async () => {
      try {
        while (pending) {
          const next = pending
          pending = undefined
          try {
            await send(next)
          } catch (err) {
            onError(err)
          }
        }
      } finally {
        sending = false
      }
    })().catch(() => undefined)
  }
}

/** How a connector worker ended, as its supervisor saw it. */
export interface WorkerExit {
  pid: number | undefined
  code: number | null
  signal: NodeJS.Signals | null
  uptimeMs: number
  /** The supervisor asked it to stop (an upgrade, a shutdown): not a crash. */
  requested: boolean
  /** A `fatal` the worker reported over IPC before it went. */
  fatal?: string
}

export function launchUpgradeWorker(
  entry: string,
  config: ComputerConfig,
  probation = false,
  onShutdown: () => void = () => undefined,
  env: NodeJS.ProcessEnv = process.env,
  grant?: ConnectorGrant,
  onExit?: (exit: WorkerExit) => void
): UpgradeWorker {
  const child = fork(entry, [], {
    env: { ...env, [WORKER_ENV]: '1', SLAYZONE_NONINTERACTIVE: '1' },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  const startedAt = Date.now()
  let stopRequested = false
  let fatal: string | undefined
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
    try {
      onExit?.({
        pid: child.pid,
        code,
        signal,
        uptimeMs: Date.now() - startedAt,
        requested: stopRequested,
        ...(fatal !== undefined ? { fatal } : {})
      })
    } catch {
      /* reporting an exit must not break handling it */
    }
    drainReply?.(false)
    activateReject?.(connectionError)
    wake()
  })
  child.on('message', (message: unknown) => {
    const msg = message as {
      type?: string
      hubUrl?: string
      idle?: boolean
      error?: string
    }
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
      fatal = msg.error
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
        stopRequested = true
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
  notify?: (method: string, params: unknown) => void,
  bootSeed?: ComputerBootSeed
): Promise<LocalPeer> {
  const runtime = runtimeDir(root)
  mkdirSync(runtime, { recursive: true, mode: 0o700 })
  // Production passes provenance from the same read used to resolve policy.
  // Direct library callers supply explicit config rather than cached file defaults.
  const seed = bootSeed ?? {
    fileFingerprint: readComputerConfigSnapshot(join(root, 'computer.config.json')).fingerprint,
    launchOverrides: { computerName: config.name, allowedRoots: config.allowedRoots }
  }
  atomicRuntimeJson(join(runtime, 'host-config.json'), {
    ...seed,
    connection: { hubUrl: config.hubUrl, hubUrls: config.hubUrls, joinToken: config.joinToken }
  })
  try {
    const live = await hostControl(root, notify)
    return live
  } catch (err) {
    if ((err as Error).message.includes('active work')) throw err
    /* Start only after ruling out a live owner. */
  }
  // The root's launcher (launch.cjs --session-host) owns its host. While it lives it
  // is waited on, never duplicated, whatever its child is doing: a dead child inside
  // the launcher's restart gap is exactly when the old check (host.json's pid, the
  // CHILD's) judged the host gone and started a second launcher.
  const owned = await awaitLauncherHost(root, notify)
  if (owned) return owned
  // A launcher from before the lock holds no endpoint; host.json is all it leaves.
  // Its host alive → refuse. Dead → that launcher may be inside its fixed 2s restart
  // gap: give it a bounded chance before starting another. A stale control.sock is
  // the starting host's to replace (bindHostEndpoint), never unlinked from here.
  try {
    const prior = JSON.parse(readFileSync(join(runtime, 'host.json'), 'utf8')) as { pid: number }
    try {
      process.kill(prior.pid, 0)
      throw new Error('existing session host is alive but unavailable; refusing duplicate')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err
    }
    const restarted = await pollHostControl(root, notify, LEGACY_LAUNCHER_GRACE_MS)
    if (restarted) return restarted
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
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
  // Appended to from the host's start to its end, by its stdout/stderr: bounded at
  // each start (one older generation kept). Its lines are in logs/computer.log too.
  rotateLogFile(join(runtime, 'host.log'))
  const out = openSync(join(runtime, 'host.log'), 'a', 0o600)
  const launcher = ensureComputerLauncher(root, original)
  const child = spawn(process.execPath, [launcher, '--session-host'], {
    env: {
      ...process.env,
      SLAYZONE_ROOT: root,
      SLAYZONE_NONINTERACTIVE: '1',
      SLAYZONE_SUPERVISED: '0',
      // Authority only when it re-composes to the same url (hubAddrFromUrl): a wss://
      // url to a loopback front end would otherwise be dialed as ws://. Without it the
      // host reads the full url from its host-config.json seed.
      SLAYZONE_HUB_ADDRESS:
        new URL(config.hubUrl).pathname === '/computers' && !new URL(config.hubUrl).search
          ? (hubAddrFromUrl(config.hubUrl) ?? undefined)
          : undefined,
      SLAYZONE_HUB_JOIN_TOKEN: config.joinToken
    },
    detached: true,
    stdio: ['ignore', out, out]
  })
  closeSync(out)
  child.unref()
  let exited: Error | undefined
  let yielded = false
  child.once('error', (err) => {
    exited = err
  })
  child.once('exit', (code, signal) => {
    // Exit 0 at startup: this launcher found another one (or a live host) owning
    // the root and stood down. That owner is the host to use.
    if (code === 0) {
      yielded = true
      return
    }
    // Its reason is the last thing it wrote to host.log (stderr): carried in the
    // error, which the supervisor logs, instead of a bare exit code.
    const tail = readLogTail(join(runtime, 'host.log'))
    exited = new Error(
      `session host exited during startup (code ${code}, signal ${signal})${tail ? `: ${tail}` : ''}`
    )
  })
  for (let i = 0; i < 100; i++) {
    if (exited) throw exited
    if (yielded) {
      const owner =
        (await awaitLauncherHost(root, notify)) ??
        (await pollHostControl(root, notify, LEGACY_LAUNCHER_GRACE_MS))
      if (owner) return owner
      throw new Error(
        'session host launcher stood down, but no other host came up; inspect computer-runtime/host.log'
      )
    }
    try {
      return await hostControl(root, notify)
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const status = await queryHostLauncher(root, 'status').catch(() => null)
  throw new Error(
    `session host did not start${describeLastExit(status)}; inspect computer-runtime/host.log`
  )
}

/** How long a launcher from before the lock may take to restart its host (it waits 2s). */
const LEGACY_LAUNCHER_GRACE_MS = 5000
/** How long a live launcher's host may take to come up once asked to launch now. */
const LAUNCHER_HOST_WAIT_MS = 30_000

function describeLastExit(status: HostLauncherStatus | null): string {
  const last = status?.lastExit
  return last
    ? ` (its launcher is ${status!.state}; last host ${last.version} exited code=${last.code} signal=${last.signal})`
    : ''
}

/** Connect to the root's host, retrying for up to `ms`. `null` if none came up. */
async function pollHostControl(
  root: string,
  notify: ((method: string, params: unknown) => void) | undefined,
  ms: number
): Promise<LocalPeer | null> {
  const deadline = Date.now() + ms
  for (;;) {
    try {
      return await hostControl(root, notify)
    } catch (err) {
      if ((err as Error).message.includes('active work')) throw err
    }
    if (Date.now() >= deadline) return null
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
}

/**
 * The host of the root's live launcher, waited for: a launcher backing off is asked
 * to launch now (once). `null` when no launcher holds the root. Throws when one does
 * but its host does not come up in time — never a reason to start another. Only a
 * launcher that is bound but busy (`HostLauncherBusyError`) is waited on; any other
 * query failure (an endpoint path the OS refuses, EACCES) is thrown at once.
 */
async function awaitLauncherHost(
  root: string,
  notify: ((method: string, params: unknown) => void) | undefined
): Promise<LocalPeer | null> {
  let status: HostLauncherStatus | null
  try {
    status = await queryHostLauncher(root, 'status')
  } catch (err) {
    if (!(err instanceof HostLauncherBusyError)) throw err
    // Bound but not answering (busy): still the owner.
    status = { state: 'starting', childPid: null, nextLaunchAt: null, lastExit: null }
  }
  if (!status) return null
  let kicked = false
  const deadline = Date.now() + LAUNCHER_HOST_WAIT_MS
  while (Date.now() < deadline) {
    try {
      return await hostControl(root, notify)
    } catch (err) {
      if ((err as Error).message.includes('active work')) throw err
    }
    try {
      const kick = status?.state === 'backoff' && !kicked
      if (kick) kicked = true
      status = await queryHostLauncher(root, kick ? 'launch-now' : 'status')
      // Its launcher is gone: whoever calls next decides afresh.
      if (!status) return null
    } catch (err) {
      if (!(err instanceof HostLauncherBusyError)) throw err
      /* Busy: still the owner. */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(
    `this root's session host launcher is alive but its host did not come up${describeLastExit(status)}; inspect computer-runtime/host.log`
  )
}

/**
 * How long an explicit stop waits for the stopped host's launcher to let go of the
 * root. Above the stopped host's own exit grace (cli-main STOPPED_HOST_EXIT_GRACE_MS,
 * 5s), so a host whose event loop does not drain is still waited out.
 */
const STOPPED_HOST_RELEASE_WAIT_MS = 10_000

/**
 * After a forced host `stop`: wait until the root's launcher has released its endpoint.
 * The host answers `stop` before it stops (session-host.ts), then exits and logs its
 * exit, and its launcher logs that too before it releases — all into the root
 * (logs/computer.log). The launcher and host are detached, so without this a stopped
 * `slayzone-computer` exits while they still write, and whoever removes the root next
 * races them (ENOTEMPTY). `null` from the launcher = released (or none, as with a
 * pre-lock launcher). Bounded: a launcher that restarts its host instead (it crashed
 * while stopping) is logged and left to its own policy.
 */
async function awaitStoppedHostReleased(root: string, log?: Log): Promise<void> {
  const deadline = Date.now() + STOPPED_HOST_RELEASE_WAIT_MS
  let status: HostLauncherStatus | null = null
  for (;;) {
    try {
      status = await queryHostLauncher(root, 'status')
      if (!status) return
    } catch (err) {
      if (!(err instanceof HostLauncherBusyError)) {
        log?.('cannot confirm the stopped session host exited', { error: String(err) })
        return
      }
      /* Busy: still there. */
    }
    if (Date.now() >= deadline) {
      log?.(`stopped session host's launcher still holds the root${describeLastExit(status)}`, {
        waitedMs: STOPPED_HOST_RELEASE_WAIT_MS
      })
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
}

/** Remember explicit stops throughout boot, including reconnect probes and host startup. */
export async function superviseUpgrades(...args: Parameters<typeof initializeUpgradeSupervisor>) {
  let stopRequested = false
  const requestStop = (): void => {
    stopRequested = true
  }
  process.on('SIGINT', requestStop)
  process.on('SIGTERM', requestStop)
  try {
    const supervisor = await initializeUpgradeSupervisor(...args)
    if (stopRequested) await supervisor.stop(true)
    return supervisor
  } catch (err) {
    if (stopRequested) {
      const peer = await hostControl(args[2]).catch(() => undefined)
      if (peer) {
        await peer.rpc.request('stop', { force: true }).catch(() => undefined)
        peer.close()
        await awaitStoppedHostReleased(args[2], args[3])
      }
    }
    throw err
  } finally {
    process.off('SIGINT', requestStop)
    process.off('SIGTERM', requestStop)
  }
}

/** Supervises one connector per hub; stopping a connector never stops its host. */
async function initializeUpgradeSupervisor(
  config: ComputerConfig,
  original: UpgradeRelease,
  root: string,
  log: Log,
  options: {
    probationMs?: number
    intervalMs?: number
    bootSeed?: ComputerBootSeed
  } = {}
): Promise<{ stop(shutdownHost?: boolean): Promise<void> }> {
  const runtime = runtimeDir(root)
  mkdirSync(runtime, { recursive: true, mode: 0o700 })
  const control = await ensureSessionHost(
    config,
    original,
    root,
    (method) => {
      if (method === 'host.shutdown') void stop(true)
    },
    options.bootSeed
  )
  const abort = new AbortController()
  const controllers: ReturnType<typeof createUpgradeController>[] = []
  let stopping = false
  const committed = new Map<string, UpgradeRelease>()
  let maintenanceRunning = false
  let expectedHostStop = false
  const incompatibleHostTargets = new Map<string, UpgradeRelease>()
  const desiredHostConfig = hostConfigurationKey(config)
  const hostInfo = await control.rpc.request<import('./session-host').HostHealth>('health')
  let hostBuildChanged = false
  let hostConfigurationChanged =
    hostInfo.configKey !== undefined && hostInfo.configKey !== desiredHostConfig
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
    const reportStatus = createStatusReporter(
      (status) => reportUpgradeStatus(root, hubUrl, status),
      (err) => log('cannot report upgrade status', { hubUrl, error: String(err) })
    )
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
      let contractVersion: string | undefined
      // Initial launches need the same compatibility check as staged upgrades.
      // Do it before reserve: reserving revokes the still-working old connector.
      const starting = probeRuntimeContract(entry, abort.signal)
        .then(async (contract) => {
          contractVersion = contract.version
          hostBuildChanged =
            hostInfo.buildId !== undefined &&
            contract.buildId !== undefined &&
            hostInfo.buildId !== contract.buildId
          if (needsHostMaintenance(contract, hostInfo.contract)) {
            incompatibleHostTargets.set(hubUrl, {
              entry,
              version: contract.version ?? initial.version
            })
            if (!canBridgeMaintenance(contract, hostInfo.contract))
              throw new HostMaintenanceRequired(
                'Connector requires session host maintenance; waiting for running work to finish'
              )
          }
          const grant = await control.rpc.request<ConnectorGrant>('reserve', { hubUrl })
          return {
            ...grant,
            ...(canBridgeMaintenance(contract, hostInfo.contract) ? { maintenance: true } : {})
          }
        })
        .then((grant) => {
          worker = launchUpgradeWorker(
            entry,
            scoped,
            probation,
            () => {
              void stop(true)
            },
            { ...process.env, SLAYZONE_ROOT: root },
            grant,
            // Its code and signal used to be kept only in an Error nobody logged: a
            // worker SIGKILLed by the OOM killer left no trace but the next boot.
            (exit) =>
              log(
                exit.requested ? 'computer worker stopped' : 'computer worker exited unexpectedly',
                {
                  hubUrl,
                  version: contractVersion,
                  ...exit
                }
              )
          )
          if (cancelled) void worker.stop()
          return worker
        })
        .catch((err) => {
          if (String(err).includes('unknown hub')) hostConfigurationChanged = true
          failure =
            hostConfigurationChanged && String(err).includes('unknown hub')
              ? new HostMaintenanceRequired(
                  'Session host configuration changed; waiting for running work to finish'
                )
              : err
          throw failure
        })
      void starting.catch(() => undefined)
      return {
        exited: () =>
          (failure && !(failure instanceof HostMaintenanceRequired)) || worker?.exited?.() === true,
        connected: async () => (await starting).connected(),
        drain: async () => {
          try {
            await starting
          } catch (err) {
            // A refused initial connector never acquired a lease. A different,
            // compatible target may replace it without draining host sessions.
            if (!(err instanceof HostMaintenanceRequired)) throw err
          }
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
        discover: async () => {
          const target =
            config.autoUpgrade === false
              ? initial.version
              : await discoverHubRelease([hubUrl], abort.signal)
          if (incompatibleHostTargets.get(hubUrl)?.version !== target)
            incompatibleHostTargets.delete(hubUrl)
          return target
        },
        install,
        validate: async (release) => {
          const contract = await probeRuntimeContract(release.entry, abort.signal)
          if (needsHostMaintenance(contract, hostInfo.contract)) {
            incompatibleHostTargets.set(hubUrl, release)
            if (!canBridgeMaintenance(contract, hostInfo.contract))
              throw new HostMaintenanceRequired(
                'Connector requires session host maintenance; waiting for running work to finish'
              )
            return
          }
          incompatibleHostTargets.delete(hubUrl)
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
            ...(hostConfigurationChanged
              ? {
                  maintenanceReason:
                    'Session host configuration changed; waiting for running work to finish'
                }
              : hostInfo.version !== displayedVersion ||
                  hostBuildChanged ||
                  incompatibleHostTargets.has(hubUrl)
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
          reportStatus(status)
        }
      }
    )
    controllers.push(controller)
  }
  const maintain = async (): Promise<void> => {
    if (stopping || maintenanceRunning || !process.argv.includes('--supervisor')) return
    maintenanceRunning = true
    let drained = false
    try {
      const deferred = incompatibleHostTargets.entries().next().value as
        | [string, UpgradeRelease]
        | undefined
      const primary = deferred?.[1] ?? committed.get(effectiveHubUrls(config)[0])
      if (!primary) return
      const liveHost = await control.rpc.request<import('./session-host').HostHealth>('health')
      if (
        liveHost.configKey !== undefined
          ? liveHost.configKey !== desiredHostConfig
          : hostConfigurationChanged
      ) {
        if (!liveHost.idle) return
        await control.rpc.request('prepare-maintenance')
        drained = true
        atomicJson(join(runtime, 'host-release.json'), {
          current:
            liveHost.configKey === undefined
              ? original
              : { entry: liveHost.entry, version: liveHost.version }
        })
        await Promise.all(controllers.map((c) => c.stop()))
        expectedHostStop = true
        try {
          await control.rpc.request('stop', { force: false })
        } catch (err) {
          expectedHostStop = false
          throw err
        }
        await stop(false)
        process.exit(75)
      }
      const stillWanted = async (): Promise<boolean> => {
        if (!deferred) return true
        if (incompatibleHostTargets.get(deferred[0]) !== deferred[1]) return false
        const target =
          config.autoUpgrade === false
            ? committed.get(deferred[0])?.version
            : await discoverHubRelease([deferred[0]], abort.signal)
        if (target === deferred[1].version)
          return incompatibleHostTargets.get(deferred[0]) === deferred[1]
        incompatibleHostTargets.delete(deferred[0])
        return false
      }
      if (!(await stillWanted()) || (deferred && !liveHost.idle)) return
      if (config.autoUpgrade === false && !deferred && primary.version !== original.version) return
      const primaryContract = await probeRuntimeContract(primary.entry, abort.signal)
      const supervisorChange = primary.version !== original.version
      const hostChange =
        primary.version !== liveHost.version ||
        needsHostMaintenance(primaryContract, liveHost.contract) ||
        (liveHost.buildId !== undefined &&
          primaryContract.buildId !== undefined &&
          liveHost.buildId !== primaryContract.buildId)
      if (!supervisorChange && (!hostChange || !liveHost.idle)) return
      const role = supervisorChange ? 'supervisor' : 'host'
      try {
        const blocked = JSON.parse(readFileSync(join(runtime, role + '-quarantine.json'), 'utf8'))
        if (blocked.version === primary.version && blocked.until > Date.now()) return
      } catch {
        /* No quarantined runtime. */
      }
      const replaceHost = !supervisorChange || !!deferred
      if (replaceHost) {
        await control.rpc.request('prepare-maintenance')
        drained = true
        if (!(await stillWanted())) return
      }
      atomicJson(join(runtime, 'supervisor.json'), { current: primary, previous: original })
      atomicJson(join(runtime, 'host-release.json'), {
        current: primary,
        previous: { entry: liveHost.entry, version: liveHost.version }
      })
      if (replaceHost) {
        await Promise.all(controllers.map((c) => c.stop()))
        expectedHostStop = true
        try {
          await control.rpc.request('stop', { force: false })
        } catch (err) {
          expectedHostStop = false
          throw err
        }
      }
      await stop(false)
      process.exit(75)
    } finally {
      if (drained && !expectedHostStop && !stopping)
        await control.rpc
          .request('cancel-maintenance')
          .catch((err) =>
            log('cannot resume session host after canceled maintenance', { error: String(err) })
          )
      maintenanceRunning = false
    }
  }
  const maintenanceFailed = (err: unknown): void => {
    log('runtime maintenance failed', { error: String(err) })
    if (control.socket.destroyed && !stopping)
      void stop(false).then(() => {
        if (process.argv.includes('--supervisor')) process.exit(1)
      })
  }
  const interval = setInterval(() => {
    for (const c of controllers) void c.check()
    void maintain().catch(maintenanceFailed)
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
    // Stopped = the host is gone too: nothing of this computer still writes its root.
    if (shutdownHost) await awaitStoppedHostReleased(root, log)
  }
  process.on('SIGINT', onStop)
  process.on('SIGTERM', onStop)
  void maintain().catch(maintenanceFailed)
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
    {
      type: string
      config: ComputerConfig
      probation: boolean
      grant?: ConnectorGrant
    }
  ]
  if (msg.type !== 'boot') throw new Error('invalid computer supervisor boot message')
  return msg
}
