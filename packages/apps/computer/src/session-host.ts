/** Persistent process owner. Connector loss only detaches transport, never sessions. */
import { createHmac, randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type Server } from 'node:net'
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  readdirSync
} from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { tmpdir } from 'node:os'
import {
  connectLocal,
  socketPeer,
  HOST_CONTRACT_VERSION,
  type LocalPeer
} from '@slayzone/computer-runtime'
import { HubDialer, type HubDialerOptions } from '@slayzone/computer-transport/client'
import { COMPUTER_VERSION, startComputer } from './main'
import { COMPUTER_PROTOCOL_VERSION } from '@slayzone/computer-transport/shared'
import { COMPUTER_BUILD_ID } from './build-identity'
import { effectiveHubUrls, hostConfigurationKey, type ComputerConfig } from './config'
import { adoptLoginShellPath } from './login-shell-path'

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
export function hostEndpoint(root: string): string {
  const key = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 24)
  if (process.platform === 'win32') return `\\\\.\\pipe\\slay-computer-${key}`
  const dir = join(tmpdir(), `slay-computer-${process.getuid?.() ?? 'user'}-${key}`)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  return join(dir, 'control.sock')
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
  for (const entry of readdirSync(runtimeDir(root), { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const path = join(runtimeDir(root), entry.name)
    const staging = /^hooks-[a-f0-9]{16}\.json\.(\d+)\.[a-f0-9]{8}\.tmp$/.exec(entry.name)
    if (staging) {
      const pid = Number(staging[1])
      if (!Number.isSafeInteger(pid) || pid < 1) continue
      let dead = false
      try {
        process.kill(pid, 0)
      } catch (error) {
        dead = (error as NodeJS.ErrnoException).code === 'ESRCH'
      }
      // A temp was never published or acknowledged. The last renamed journal
      // remains authoritative; do not parse a potentially partial private copy.
      if (dead) unlinkSync(path)
      continue
    }
    if (!/^hooks-[a-f0-9]{16}\.json$/.test(entry.name)) continue
    const events: Array<{ params: unknown }> = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(events)) throw new Error('Invalid host event journal')
    const native = events.filter((event) => !isChatNotification(event.params))
    if (native.length !== events.length) atomicRuntimeJson(path, native)
  }
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
  constructor(
    readonly options: HubDialerOptions,
    root: string,
    private logEvent: (message: string) => void
  ) {
    super(options)
    this.journal = join(
      runtimeDir(root),
      'hooks-' + createHash('sha256').update(options.url).digest('hex').slice(0, 16) + '.json'
    )
    try {
      this.eventsQueue = JSON.parse(readFileSync(this.journal, 'utf8'))
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
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
        await this.peer.rpc.request('event-deliver', next)
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

export async function startSessionHost(
  root: string,
  config: ComputerConfig,
  log: (message: string, meta?: Record<string, unknown>) => void = () => undefined
) {
  const secret = controlToken(root)
  scrubChatJournals(root)
  const epoch = randomUUID()
  const transports = new Map<string, SessionTransport>()
  const controls = new Set<LocalPeer>()
  const peers = new Set<LocalPeer>()
  const generationFile = join(runtimeDir(root), 'generations.json')
  let generations: Record<string, number> = {}
  try {
    generations = JSON.parse(readFileSync(generationFile, 'utf8'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const credential = (hub: string, generation: number): string =>
    createHmac('sha256', secret)
      .update(JSON.stringify([hub, generation]))
      .digest('hex')
  const handle = startComputer(config, {
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
  const health = (): HostHealth => ({
    entry: process.argv[1],
    contract: HOST_CONTRACT_VERSION,
    epoch,
    pid: process.pid,
    version: COMPUTER_VERSION,
    buildId: COMPUTER_BUILD_ID,
    idle: handle.isIdle(),
    configKey: hostConfigurationKey(config),
    hubUrls: effectiveHubUrls(config)
  })
  // Health inspection must not leave the legacy dispatch gate drained.
  const inspect = (): HostHealth => {
    const result = health()
    return result
  }
  const endpoint = hostEndpoint(root)
  const server: Server = createServer((socket) => {
    let auth: Auth | undefined
    let authenticated = false
    const timer = setTimeout(() => socket.destroy(), 5000)
    const peer = socketPeer(socket, {
      maxFrameBytes: () => (authenticated ? 100 * 1024 * 1024 : 8192),
      request: async (method, raw) => {
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
            socket.destroy()
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
            params.actor
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
            version: COMPUTER_VERSION
          }
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
          transport.events.emit('disconnected', { reason: 'connector detached' })
        }
      }
    })
  })
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(endpoint, resolve)
    })
  } catch (err) {
    await handle.stop()
    throw err
  }
  atomicRuntimeJson(join(runtimeDir(root), 'host.json'), {
    endpoint,
    pid: process.pid,
    epoch,
    version: COMPUTER_VERSION
  })
  let stopping: Promise<void> | undefined
  function stop(): Promise<void> {
    return (stopping ??= (async () => {
      for (const peer of peers) peer.close()
      await handle.stop()
      try {
        unlinkSync(join(runtimeDir(root), 'host.json'))
      } catch {
        /* Already removed. */
      }
      await new Promise<void>((resolve) => server.close(() => resolve()))
    })())
  }
  const closed = new Promise<void>((resolve) => server.once('close', resolve))
  return { epoch, endpoint, stop, closed }
}
