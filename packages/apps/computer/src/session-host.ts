/** Persistent process owner. Connector loss only detaches transport, never sessions. */
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { createServer, type Server, type Socket } from 'node:net'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync,
  openSync,
  fsyncSync,
  closeSync
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import {
  connectLocal,
  socketPeer,
  HOST_CONTRACT_VERSION,
  type LocalPeer
} from '@slayzone/computer-runtime'
import { HubDialer, type HubDialerOptions } from '@slayzone/computer-transport/client'
import { COMPUTER_VERSION, startComputer } from './main'
import {
  COMPUTER_FRAME_MAX_BYTES,
  COMPUTER_PROTOCOL_VERSION
} from '@slayzone/computer-transport/shared'
import { COMPUTER_BUILD_ID } from './build-identity'
import { effectiveHubUrls, hostConfigurationKey, type ComputerConfig } from './config'
import { adoptLoginShellPath } from './login-shell-path'
import { createComputerLog } from './file-log'
import { adoptHookJournal, readHookJournal } from './hook-journal'
import {
  forEachIsolatedSync,
  isStorageFatal,
  StructuralFaultError
} from '@slayzone/platform/isolation'
import {
  hostEndpoint,
  hostEndpointDir,
  isEndpointInUseError,
  prepareEndpointDir,
  probeEndpoint,
  releaseEndpointDir,
  sweepStaleEndpointDirs
} from '@slayzone/platform/computer-endpoints'
import {
  eraseQuarantinedForTask,
  quarantineWrite,
  readJsonTolerant
} from '@slayzone/platform/quarantine'

/**
 * The standalone session host's log: `[host] …` lines to its stdout (its launcher's
 * `computer-runtime/host.log`, or the service journal) AND, timestamped and rotated,
 * to `<root>/logs/computer.log` — the same file the desktop's computer writes (its
 * state dir is `root` too). Before, its lines (event-loop stalls included) reached
 * only the unrotated stdout sink.
 */
export function sessionHostLog(
  root: string,
  stdout?: (text: string) => void
): (message: string, meta?: Record<string, unknown>) => void {
  return createComputerLog({ stateDir: root, tag: 'host', ...(stdout ? { stdout } : {}) })
}

export function runtimeDir(root: string): string {
  return join(root, 'computer-runtime')
}
export function atomicRuntimeJson(path: string, value: unknown): void {
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(value) + '\n', { mode: 0o600 })
    renameSync(temp, path)
  } catch (error) {
    try {
      unlinkSync(temp)
    } catch (cleanupError) {
      if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new AggregateError(
          [error, cleanupError],
          'Runtime publication and staging cleanup failed'
        )
    }
    throw error
  }
}
export { hostEndpoint }

/**
 * Another session host is live on this root's control endpoint. The starting one
 * has touched nothing (it binds before any shared state) and exits with
 * `HOST_SUPERSEDED_EXIT_CODE`, which its launcher treats as "stop", not "restart".
 */
export class HostSupersededError extends Error {
  constructor(
    readonly endpoint: string,
    readonly live: { pid?: number; version?: string }
  ) {
    super(
      `another session host is live on ${endpoint} (live session host pid=${live.pid ?? '?'} version=${live.version ?? '?'}); superseded`
    )
    this.name = 'HostSupersededError'
  }
}

function readHostRecord(root: string): { pid?: number; version?: string } {
  try {
    // startup-json: strict — the LIVE host's record, read for a log line only: a bad one is ignored (caught), never quarantined by a superseded host
    const record = JSON.parse(readFileSync(join(runtimeDir(root), 'host.json'), 'utf8'))
    return { pid: record?.pid, version: record?.version }
  } catch {
    return {}
  }
}

/**
 * Bind `server` to the root's control endpoint — the act that makes this process the
 * root's session host. A live owner means this host is superseded. A POSIX socket
 * file nobody listens on (its host died) is replaced: safe because the root's
 * launcher lock (launch.cjs) admits one starting host at a time.
 */
async function bindHostEndpoint(server: Server, root: string): Promise<string> {
  const endpoint = hostEndpoint(root)
  const dir = hostEndpointDir(root)
  if (dir) prepareEndpointDir(dir)
  const listen = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => reject(err)
      server.once('error', onError)
      server.listen(endpoint, () => {
        server.off('error', onError)
        resolve()
      })
    })
  for (let attempt = 0; ; attempt++) {
    try {
      await listen()
      return endpoint
    } catch (err) {
      if (!isEndpointInUseError(err) || attempt >= 2) throw err
      const state = await probeEndpoint(endpoint)
      if (state === 'live') throw new HostSupersededError(endpoint, readHostRecord(root))
      if (state === 'stale') {
        // Another host starting at once may have removed it first: that is fine.
        try {
          unlinkSync(endpoint)
        } catch (unlinkErr) {
          if ((unlinkErr as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkErr
        }
      }
    }
  }
}
function controlToken(root: string): string {
  const path = join(runtimeDir(root), 'control.key')
  mkdirSync(runtimeDir(root), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 })
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  return readFileSync(path, 'utf8').trim()
}
function sameSecret(a: unknown, b: string): boolean {
  return (
    typeof a === 'string' &&
    /^[a-f0-9]{64}$/.test(a) &&
    a.length === b.length &&
    timingSafeEqual(Buffer.from(a), Buffer.from(b))
  )
}
export interface HostHealth {
  entry: string
  contract: number
  epoch: string
  pid: number
  version: string
  buildId?: string
  idle: boolean
  configKey?: string
  hubUrls?: string[]
}
export interface ConnectorGrant {
  /** Supervisor hint; connectors also derive restricted mode for old supervisors. */
  maintenance?: boolean
  generation: number
  token: string
  health: HostHealth
}
interface Auth {
  role: 'supervisor' | 'connector'
  hubUrl?: string
  generation?: number
  token: string
}

function isChatNotification(params: unknown): boolean {
  return (
    !!params && typeof params === 'object' && 'name' in params && params.name === 'chat-runtime'
  )
}

/** Old hosts journaled normalized chat frames outside the chat lifecycle store.
 * Scrub every configured or disconnected hub before opening transports. Native
 * hooks retain their existing acknowledged-delivery journal.
 */
function scrubChatJournals(root: string): void {
  // One file at a time: a journal that cannot be scrubbed is logged and left for
  // the next start; it never keeps the host (every hub, every agent) down.
  forEachIsolatedSync(
    readdirSync(runtimeDir(root), { withFileTypes: true }).filter((entry) => entry.isFile()),
    { pass: 'computer.scrub-chat-journals', key: (entry) => entry.name, isFatal: isStorageFatal },
    (entry) => {
      const path = join(runtimeDir(root), entry.name)
      const staging = /^hooks-[a-f0-9]{16}\.json\.(\d+)\.[a-f0-9]{8}\.tmp$/.exec(entry.name)
      if (staging) {
        const pid = Number(staging[1])
        if (!Number.isSafeInteger(pid) || pid < 1) return
        let dead = false
        try {
          process.kill(pid, 0)
        } catch (error) {
          dead = (error as NodeJS.ErrnoException).code === 'ESRCH'
        }
        // A temp was never published or acknowledged. The last renamed journal
        // remains authoritative; do not parse a potentially partial private copy.
        if (dead) unlinkSync(path)
        return
      }
      if (!/^hooks-[a-f0-9]{16}\.json$/.test(entry.name)) return
      // Unreadable bytes are salvaged + quarantined by the reader (decision 7).
      const events = readHookJournal(runtimeDir(root), path)
      const native = events.filter((event) => !isChatNotification(event.params))
      if (native.length !== events.length) atomicRuntimeJson(path, native)
    }
  )
}
export async function hostControl(
  root: string,
  notify?: (method: string, params: unknown) => void
): Promise<LocalPeer> {
  const peer = await connectLocal(hostEndpoint(root), { notify })
  try {
    await peer.rpc.request('auth', { role: 'supervisor', token: controlToken(root) }, 5000)
    return peer
  } catch (err) {
    peer.close()
    throw err
  }
}
export async function connectorHost(
  root: string,
  grant: ConnectorGrant,
  hubUrl: string,
  handlers: Parameters<typeof connectLocal>[1]
): Promise<LocalPeer> {
  const peer = await connectLocal(hostEndpoint(root), handlers)
  try {
    await peer.rpc.request(
      'auth',
      { role: 'connector', hubUrl, generation: grant.generation, token: grant.token },
      5000
    )
    return peer
  } catch (err) {
    peer.close()
    throw err
  }
}

class SessionTransport extends HubDialer {
  peer?: LocalPeer
  hubOnline = false
  authenticatedComputerId: string | null = null
  override get computerId(): string | null {
    return this.authenticatedComputerId
  }
  private eventsQueue: Array<{ id: string; params: unknown }> = []
  private delivering = false
  private closed = false
  private readonly journal: string
  private readonly runtime: string
  private readonly erasedTasks = new Set<string>()
  async forgetTaskEvents(taskId: string): Promise<void> {
    this.erasedTasks.add(taskId)
    this.eventsQueue = this.eventsQueue.filter((event) => !eventBelongsToTask(event.params, taskId))
    atomicRuntimeJson(this.journal, this.eventsQueue)
    // Quarantined journal bytes and rejected events that name the task go too.
    eraseQuarantinedForTask(this.runtime, taskId)
    const fd = openSync(this.journal, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    if (process.platform !== 'win32') {
      const directory = openSync(resolve(this.journal, '..'), 'r')
      try {
        fsyncSync(directory)
      } finally {
        closeSync(directory)
      }
    }
  }
  constructor(
    readonly options: HubDialerOptions,
    root: string,
    private logEvent: (message: string) => void
  ) {
    super(options)
    // Named by the canonical hub URL; a file an older host named by this spelling moves.
    this.runtime = runtimeDir(root)
    this.journal = adoptHookJournal(this.runtime, options.url)
    this.eventsQueue = readHookJournal(this.runtime, this.journal)
  }
  async deliverEvents(): Promise<void> {
    if (
      this.delivering ||
      this.closed ||
      !this.hubOnline ||
      !this.peer ||
      this.peer.socket.destroyed
    )
      return
    this.delivering = true
    try {
      while (
        this.eventsQueue.length &&
        this.hubOnline &&
        this.peer &&
        !this.peer.socket.destroyed
      ) {
        const next = this.eventsQueue[0]
        const result = await this.peer.rpc.request<{ ok?: boolean; rejected?: string } | undefined>(
          'event-deliver',
          next
        )
        if (typeof result?.rejected === 'string') {
          // The hub refuses this event as invalid: retrying can never succeed, and
          // holding it would block every later hook. It is quarantined (shown in
          // Needs attention; erasure and Discard reach it) and the queue moves on.
          quarantineWrite(this.runtime, {
            pass: 'hook-event-rejected',
            originalPath: this.journal,
            content: JSON.stringify(next),
            taskId: eventTaskId(next.params),
            reason: result.rejected
          })
          this.logEvent(`hook event rejected by the hub (${result.rejected}); quarantined`)
        }
        if (this.eventsQueue[0]?.id === next.id) this.eventsQueue.shift()
        atomicRuntimeJson(this.journal, this.eventsQueue)
      }
    } catch {
      /* Retain unacknowledged hooks across connection replacement. */
    } finally {
      this.delivering = false
      if (!this.closed && this.eventsQueue.length)
        setTimeout(() => void this.deliverEvents(), 1000).unref()
    }
  }
  override start(): void {
    /* The connector owns network authentication. */
  }
  override async stop(): Promise<void> {
    this.closed = true
    this.hubOnline = false
    this.peer?.close()
  }
  override notify(method: string, params?: unknown): boolean {
    if (method === 'event' && !isChatNotification(params)) {
      if ([...this.erasedTasks].some((taskId) => eventBelongsToTask(params, taskId))) return false
      const entry = { id: randomUUID(), params }
      if (Buffer.byteLength(JSON.stringify(entry)) > 1024 * 1024) {
        this.logEvent('hook exceeds buffer size; dropped')
        return false
      }
      this.eventsQueue.push(entry)
      while (
        this.eventsQueue.length > 1000 ||
        Buffer.byteLength(JSON.stringify(this.eventsQueue)) > 4 * 1024 * 1024
      ) {
        this.eventsQueue.shift()
        this.logEvent('hook buffer overflow; oldest event dropped')
      }
      atomicRuntimeJson(this.journal, this.eventsQueue)
      void this.deliverEvents()
      return true
    }
    if (!this.hubOnline || !this.peer || this.peer.socket.destroyed) return false
    try {
      this.peer.rpc.notify('event', { method, params })
      // Notification writes are not delivery acknowledgements. Keep bounded exit
      // buffers even when a socket closes before its disconnect reaches the host.
      return method !== 'pty.exit' && method !== 'proc.exit'
    } catch {
      return false
    }
  }
  override request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.hubOnline || !this.peer) return Promise.reject(new Error('hub connector unavailable'))
    return this.peer.rpc.request<T>('upstream', { method, params, timeoutMs }, timeoutMs)
  }
}

function eventTaskId(params: unknown): string | null {
  if (!params || typeof params !== 'object') return null
  const payload = 'payload' in params ? params.payload : null
  return payload &&
    typeof payload === 'object' &&
    'taskId' in payload &&
    typeof payload.taskId === 'string'
    ? payload.taskId
    : null
}

function eventBelongsToTask(params: unknown, taskId: string): boolean {
  if (!params || typeof params !== 'object') return false
  const payload = 'payload' in params ? params.payload : null
  return (
    !!payload && typeof payload === 'object' && 'taskId' in payload && payload.taskId === taskId
  )
}

function parseGenerations(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new StructuralFaultError('Generations file is not an object')
  for (const generation of Object.values(value))
    if (!Number.isSafeInteger(generation) || (generation as number) < 0)
      throw new StructuralFaultError('Generations file holds an invalid generation')
  return value as Record<string, number>
}

export async function startSessionHost(
  root: string,
  config: ComputerConfig,
  log: (message: string, meta?: Record<string, unknown>) => void = () => undefined,
  /** Test seam: runs once the endpoint is bound, before anything else starts. */
  testHooks: { afterBind?: () => Promise<void> } = {}
) {
  // Bind FIRST: a host that is superseded must exit before it touches anything the
  // live host owns (hook journals, generations, listeners). Until this host is fully
  // started, connections wait, unserved (paused), and are then served in order.
  let serve: ((socket: Socket) => void) | undefined
  const early = new Set<Socket>()
  const server: Server = createServer((socket) => {
    if (serve) return serve(socket)
    socket.pause()
    socket.on('error', () => undefined)
    early.add(socket)
    socket.once('close', () => early.delete(socket))
  })
  const endpoint = await bindHostEndpoint(server, root)
  const endpointDir = hostEndpointDir(root)
  const epoch = randomUUID()
  const transports = new Map<string, SessionTransport>()
  const controls = new Set<LocalPeer>()
  const peers = new Set<LocalPeer>()
  const generationFile = join(runtimeDir(root), 'generations.json')
  let secret!: string
  let generations!: Record<string, number>
  let handle: ReturnType<typeof startComputer> | undefined
  // A startup that fails after binding: drop whoever is waiting, free the endpoint.
  const abandon = async (err: unknown): Promise<never> => {
    for (const socket of early) socket.destroy()
    early.clear()
    await handle?.stop().catch(() => undefined)
    await new Promise<void>((resolve) => server.close(() => resolve()))
    releaseEndpointDir(endpointDir)
    throw err
  }
  try {
    await testHooks.afterBind?.()
    // Endpoint directories of roots that are gone (empty, untouched for an hour).
    sweepStaleEndpointDirs({ keep: endpointDir })
    secret = controlToken(root)
    scrubChatJournals(root)
    // A corrupt file is set aside (quarantine) and the host starts fresh: connectors
    // then reserve new generations, never a reason not to boot.
    const read = readJsonTolerant(generationFile, parseGenerations, {
      root: runtimeDir(root),
      pass: 'computer-generations'
    })
    if (read.status === 'corrupt')
      log('generations file unreadable; quarantined and restarted', { error: read.error.message })
    generations = read.status === 'ok' ? read.value : {}
    handle = startComputer(config, {
      log,
      stateDir: root,
      pathReady: adoptLoginShellPath(),
      createDialer: (options) => {
        const transport = new SessionTransport(options, root, (message) =>
          log(message, { hubUrl: options.url })
        )
        transports.set(options.url, transport)
        return transport
      },
      onShutdown: () => {
        for (const peer of controls) peer.rpc.notify('host.shutdown', {})
        void stop()
      }
    })
  } catch (err) {
    return abandon(err)
  }
  const credential = (hub: string, generation: number): string =>
    createHmac('sha256', secret)
      .update(JSON.stringify([hub, generation]))
      .digest('hex')
  const health = (): HostHealth => ({
    entry: process.argv[1],
    contract: HOST_CONTRACT_VERSION,
    epoch,
    pid: process.pid,
    version: COMPUTER_VERSION,
    buildId: COMPUTER_BUILD_ID,
    idle: handle!.isIdle(),
    configKey: hostConfigurationKey(config),
    hubUrls: effectiveHubUrls(config)
  })
  // Health inspection must not leave the legacy dispatch gate drained.
  const inspect = (): HostHealth => {
    const result = health()
    return result
  }
  const serveSocket = (socket: Socket, handle: ReturnType<typeof startComputer>): void => {
    let auth: Auth | undefined
    let authenticated = false
    const timer = setTimeout(() => socket.destroy(), 5000)
    const peer = socketPeer(socket, {
      maxFrameBytes: () => (authenticated ? COMPUTER_FRAME_MAX_BYTES : 8192),
      onFrameTooLarge: (info) => log('local frame over the frame limit refused', { ...info }),
      request: async (method, raw, _actor, signal) => {
        const params = (raw ?? {}) as Record<string, unknown>
        if (method === 'auth' && !auth) {
          if (params.role === 'supervisor' && sameSecret(params.token, secret)) {
            const recovering = controls.size === 0
            auth = params as unknown as Auth
            controls.add(peer)
            if (recovering) await handle.activate()
          } else if (
            params.role === 'connector' &&
            typeof params.hubUrl === 'string' &&
            transports.has(params.hubUrl) &&
            Number.isSafeInteger(params.generation) &&
            params.generation === generations[params.hubUrl] &&
            sameSecret(params.token, credential(params.hubUrl, params.generation as number))
          ) {
            auth = params as unknown as Auth
            const transport = transports.get(auth.hubUrl!)!
            transport.peer?.close()
            transport.hubOnline = false
            transport.peer = peer
          } else {
            // Refuse in words, then hang up: the reply goes out before the close, so
            // the peer learns why (a destroy here reached it as "connection closed").
            setImmediate(() => socket.end())
            setTimeout(() => socket.destroy(), 1000).unref()
            throw new Error('local authentication refused')
          }
          authenticated = true
          clearTimeout(timer)
          return inspect()
        }
        if (!auth) throw new Error('local authentication required')
        if (auth.role === 'supervisor') {
          if (method === 'health') return inspect()
          if (method === 'cancel-maintenance') {
            await handle.activate()
            return { ok: true }
          }
          if (method === 'prepare-maintenance') {
            if (!handle.drainForUpgrade()) throw new Error('session host has active work')
            return { ok: true }
          }
          if (method === 'reserve') {
            const hub = params.hubUrl
            if (typeof hub !== 'string' || !transports.has(hub)) throw new Error('unknown hub')
            const generation = (generations[hub] ?? 0) + 1
            if (!Number.isSafeInteger(generation)) throw new Error('connector generation exhausted')
            generations[hub] = generation
            atomicRuntimeJson(generationFile, generations)
            const transport = transports.get(hub)!
            transport.peer?.close()
            transport.peer = undefined
            transport.hubOnline = false
            return { generation, token: credential(hub, generation), health: inspect() }
          }
          if (method === 'stop') {
            if (!params.force && !handle.drainForUpgrade())
              throw new Error('session host has active work')
            setImmediate(() => void stop())
            return { ok: true }
          }
          throw new Error('supervisor method unavailable')
        }
        const transport = transports.get(auth.hubUrl!)!
        if (transport.peer !== peer || generations[auth.hubUrl!] !== auth.generation)
          throw new Error('stale connector generation')
        if (method === 'dispatch') {
          return transport.options.onHubRequest?.(
            String(params.method),
            params.params,
            params.actor,
            signal
          )
        }
        if (method === 'identity')
          return {
            ...transport.options.identity,
            // Functions do not survive JSON-RPC: the connector gets the values.
            ...((await handle.directIdentity?.()) ?? {}),
            epoch,
            contract: HOST_CONTRACT_VERSION,
            protocolVersion: COMPUTER_PROTOCOL_VERSION,
            reportsComputerHealth: typeof transport.options.computerHealth === 'function',
            version: COMPUTER_VERSION
          }
        if (method === 'computer-health') return transport.options.computerHealth?.() ?? null
        if (method === 'hooks') {
          if (
            typeof params.directory !== 'string' ||
            !params.directory.startsWith(join(runtimeDir(root), 'hook-assets') + sep)
          )
            throw new Error('invalid hook directory')
          handle.setHookDirectory(auth.hubUrl!, params.directory)
          return { ok: true }
        }
        if (method === 'connected') {
          if (typeof params.computerId !== 'string' || !params.computerId)
            throw new Error('authenticated computer identity is required')
          // The connector authenticates for this transport; the inherited dialer never starts.
          // Keep its last proven identity available to local storage while disconnected.
          transport.authenticatedComputerId = params.computerId
          transport.hubOnline = true
          void transport.deliverEvents()
          transport.events.emit('connected', {
            computerId: String(params.computerId),
            mode: params.mode === 'enroll' ? 'enroll' : 'hello'
          })
          return { ok: true }
        }
        if (method === 'disconnected') {
          transport.hubOnline = false
          transport.events.emit('disconnected', {
            reason: String(params.reason ?? 'connector disconnected')
          })
          return { ok: true }
        }
        throw new Error('connector method unavailable')
      }
    })
    peers.add(peer)
    // Pre-auth parsing is bounded separately from large authenticated file/output frames.
    let unauthBytes = 0
    socket.on('data', (chunk: string) => {
      if (!authenticated && (unauthBytes += Buffer.byteLength(chunk)) > 8192) socket.destroy()
    })
    socket.on('close', () => {
      clearTimeout(timer)
      peers.delete(peer)
      controls.delete(peer)
      if (auth?.role === 'connector') {
        const transport = transports.get(auth.hubUrl!)!
        if (transport.peer === peer) {
          transport.peer = undefined
          transport.hubOnline = false
          transport.events.emit('disconnected', {
            reason: `connector detached (${peer.closeReason() ?? 'closed'})`
          })
        }
      }
    })
  }
  const started = handle
  try {
    atomicRuntimeJson(join(runtimeDir(root), 'host.json'), {
      endpoint,
      pid: process.pid,
      epoch,
      version: COMPUTER_VERSION
    })
  } catch (err) {
    return abandon(err)
  }
  // Fully started: serve whoever waited, in arrival order, then everyone else.
  serve = (socket) => serveSocket(socket, started)
  for (const socket of early) {
    early.delete(socket)
    if (socket.destroyed) continue
    serve(socket)
    socket.resume()
  }
  let stopping: Promise<void> | undefined
  function stop(): Promise<void> {
    return (stopping ??= (async () => {
      for (const peer of peers) peer.close()
      await started.stop()
      try {
        unlinkSync(join(runtimeDir(root), 'host.json'))
      } catch {
        /* Already removed. */
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
      releaseEndpointDir(endpointDir)
    })())
  }
  const closed = new Promise<void>((resolve) => server.once('close', resolve))
  return { epoch, endpoint, stop, closed }
}
