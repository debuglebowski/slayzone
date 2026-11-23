import {
  HOST_CONTRACT_VERSION,
  HOST_MAINTENANCE_MIN_CONTRACT_VERSION
} from '@slayzone/computer-runtime'
import {
  HubToComputerMethods,
  mayWaitForAgentAdmission,
  RpcError,
  type ComputerHealth
} from '@slayzone/computer-transport/shared'
import { stageComputerHooks } from './agent-hooks'
import {
  HubDialer,
  createFileCredentialStore,
  hubHostFromUrl,
  type ComputerIdentity
} from '@slayzone/computer-transport/client'
import type { ComputerConfig } from './config'
import { parseChatInvocation } from '@slayzone/chat-runtime/shared'
import { COMPUTER_VERSION, type ComputerHandle } from './main'
import { connectorHost, type ConnectorGrant } from './session-host'

const maintenanceMethods = new Set<string>([
  HubToComputerMethods.ping,
  HubToComputerMethods.computerShutdown,
  HubToComputerMethods.computerSetAllowedRoots,
  HubToComputerMethods.projectList,
  HubToComputerMethods.projectResolvePath,
  HubToComputerMethods.projectSetPath,
  HubToComputerMethods.projectForgetPath,
  HubToComputerMethods.ptyList,
  HubToComputerMethods.ptyResize,
  HubToComputerMethods.ptyWarmList,
  HubToComputerMethods.ptyWarmKill,
  HubToComputerMethods.ptyKill,
  HubToComputerMethods.procList,
  HubToComputerMethods.procKill
])

function isMaintenanceChatStop(method: string, params: unknown): boolean {
  if (method !== HubToComputerMethods.chatRequest || !params || typeof params !== 'object')
    return false
  const body = params as { kind?: unknown; value?: unknown }
  if (body.kind !== 'invoke') return false
  const call = parseChatInvocation(body.value)
  return (
    (call.target === 'ops' && call.method === 'kill') ||
    (call.target === 'queue' && call.method === 'clear')
  )
}

/** Replaceable network adapter. It never owns or disposes the host's work. */
export async function startConnector(
  root: string,
  config: ComputerConfig,
  grant: ConnectorGrant,
  paused = false
): Promise<ComputerHandle> {
  // Historical supervisors cannot attach a maintenance flag. Derive readiness
  // from the host contract, then verify that contract/epoch against its identity.
  const maintenance =
    grant.health.contract >= HOST_MAINTENANCE_MIN_CONTRACT_VERSION &&
    grant.health.contract < HOST_CONTRACT_VERSION
  if (grant.health.contract !== HOST_CONTRACT_VERSION && !maintenance)
    throw new Error('session host contract incompatible; maintenance required')
  let dialer: HubDialer
  let stopped = false
  const identityBarrier = () => {
    let resolve!: () => void, reject!: (error: unknown) => void
    const ready = new Promise<void>((yes, no) => {
      resolve = yes
      reject = no
    })
    void ready.catch(() => undefined)
    return { ready, resolve, reject }
  }
  let authenticated = identityBarrier()
  let activate = (): void => undefined
  const ready = paused
    ? new Promise<void>((resolve) => {
        activate = resolve
      })
    : Promise.resolve()
  const host = await connectorHost(root, grant, config.hubUrl, {
    request: async (method, raw) => {
      if (method === 'event-deliver') {
        // The old host cannot persist prompt capture in the new chat store.
        // Keep its native hooks unacknowledged on disk until the replacement
        // host can replay them; the hub's generic event ACK is not storage ACK.
        if (maintenance)
          throw new Error('Computer update pending; native hooks retained for replay')
        const event = raw as { id: string; params: unknown }
        try {
          return await dialer.request('computer.event', event)
        } catch (err) {
          if (
            (err as { code?: number }).code === -32601 ||
            (err as { code?: number }).code === -32001
          ) {
            if (!dialer.notify('event', event.params)) throw new Error('hub offline')
            return { ok: true }
          }
          // The hub refused the event itself as invalid (hub-gateway.ts): a typed
          // rejection, so the host quarantines it instead of retrying it forever.
          if ((err as { code?: number }).code === -32602)
            return { ok: false, rejected: (err as Error).message || 'invalid event delivery' }
          throw err
        }
      }
      if (method !== 'upstream') throw new Error('connector method unavailable')
      const params = raw as { method: string; params?: unknown; timeoutMs?: number }
      return dialer.request(params.method, params.params, params.timeoutMs)
    },
    onFrameTooLarge: (info) =>
      process.stdout.write(
        `[connector] local frame over the frame limit refused ${JSON.stringify(info)}\n`
      ),
    notify: (method, raw) => {
      if (method !== 'event') return
      const event = raw as { method: string; params?: unknown }
      dialer?.notify(event.method, event.params)
    }
  })
  const identity = await host.rpc.request<
    Omit<ComputerIdentity, 'directAddress' | 'directRtc'> & {
      contract: number
      epoch: string
      /** The host's direct link, as values (an older host sends neither). */
      directAddress?: string | null
      directRtc?: boolean
      reportsComputerHealth?: boolean
    }
  >('identity')
  if (identity.contract !== grant.health.contract || identity.epoch !== grant.health.epoch) {
    host.close()
    throw new Error('session host protocol incompatible; maintenance required')
  }
  const hookDirectory = await stageComputerHooks(root, COMPUTER_VERSION)
  const activateHooks = async (): Promise<void> => {
    await host.rpc.request('hooks', { directory: hookDirectory })
    activate()
  }
  dialer = new HubDialer({
    url: config.hubUrl,
    // The wire belongs to this connector; runtime capabilities come from its host,
    // whose release can be older. The local contract permits connector replacement
    // without stopping native sessions, independently of optional chat features.
    computerHealth: identity.reportsComputerHealth
      ? () => host.rpc.request<ComputerHealth | undefined>('computer-health', {}, 750)
      : undefined,
    identity: {
      ...identity,
      version: COMPUTER_VERSION,
      chatRuntimeReady: !maintenance,
      // The host serves the direct link; this connector only advertises it.
      directAddress: () => identity.directAddress ?? null,
      directRtc: () => identity.directRtc === true
    },
    epoch: grant.health.epoch,
    connectorGeneration: grant.generation,
    credentialStore: createFileCredentialStore(hubHostFromUrl(config.hubUrl)),
    ...(config.joinToken ? { joinToken: config.joinToken } : {}),
    onHubRequest: async (method, params, actor, signal) => {
      const connection = authenticated
      await Promise.all([ready, connection.ready])
      if (stopped || connection !== authenticated)
        throw new RpcError(-32001, 'Computer connection identity changed before dispatch')
      if (maintenance && !maintenanceMethods.has(method) && !isMaintenanceChatStop(method, params))
        throw new RpcError(
          -32001,
          'Computer update pending. Stop its running agents to finish the update; chat and new work are unavailable until then.'
        )
      const timeout = mayWaitForAgentAdmission(method, params) ? 0 : undefined
      return host.rpc.request('dispatch', { method, params, actor }, timeout, undefined, signal)
    },
    log: (message, meta) =>
      process.stdout.write(`[connector] ${message} ${JSON.stringify(meta ?? {})}\n`)
  })
  dialer.events.on('connected', (event) => {
    const connection = authenticated
    void host.rpc.request('connected', event).then(
      () => {
        if (stopped || connection !== authenticated)
          connection.reject(new Error('Computer connection changed during identity delivery'))
        else connection.resolve()
      },
      (error) => {
        connection.reject(error)
        // The hub authenticated, but this host did not admit that identity. Never
        // dispatch using an identity left over from a previous connection.
        if (connection === authenticated) void dialer.stop()
      }
    )
  })
  dialer.events.on('disconnected', (event) => {
    authenticated.reject(new Error('Computer disconnected before identity admission'))
    if (!stopped) authenticated = identityBarrier()
    void host.rpc.request('disconnected', event).catch(() => undefined)
  })
  // The host link is this connector's only reason to exist: without it, nothing the
  // hub asks can be served and no identity can be admitted. It never comes back on
  // its own, so a close this connector did not ask for is reported (hostLost) for the
  // process to exit and be relaunched — never left as a live, idle, disconnected one.
  let reportHostLost!: (reason: string) => void
  const hostLost = new Promise<string>((resolve) => {
    reportHostLost = resolve
  })
  host.socket.once('close', () => {
    const unasked = !stopped
    stopped = true
    authenticated.reject(new Error('Computer host connection closed'))
    void dialer.stop()
    if (!unasked) return
    const reason = host.closeReason() ?? 'closed'
    process.stdout.write(`[connector] session host link lost ${JSON.stringify({ reason })}\n`)
    reportHostLost(reason)
  })
  if (!paused) await host.rpc.request('hooks', { directory: hookDirectory })
  dialer.start()
  return {
    dialer,
    dialers: [dialer],
    activate: activateHooks,
    drainForUpgrade: () => true,
    isIdle: () => true,
    setHookDirectory: () => undefined,
    hostLost,
    stop: async () => {
      stopped = true
      authenticated.reject(new Error('Computer connector stopped'))
      await dialer.stop()
      host.close()
    }
  }
}
