import { HOST_CONTRACT_VERSION } from '@slayzone/computer-runtime'
import { stageComputerHooks } from './agent-hooks'
import {
  HubDialer,
  createFileCredentialStore,
  hubHostFromUrl,
  type ComputerIdentity
} from '@slayzone/computer-transport/client'
import type { ComputerConfig } from './config'
import { COMPUTER_VERSION, type ComputerHandle } from './main'
import { connectorHost, type ConnectorGrant } from './session-host'

/** Replaceable network adapter. It never owns or disposes the host's work. */
export async function startConnector(
  root: string,
  config: ComputerConfig,
  grant: ConnectorGrant,
  paused = false
): Promise<ComputerHandle> {
  if (grant.health.contract !== HOST_CONTRACT_VERSION)
    throw new Error('session host contract incompatible; maintenance required')
  let dialer: HubDialer
  let activate = (): void => undefined
  const ready = paused
    ? new Promise<void>((resolve) => {
        activate = resolve
      })
    : Promise.resolve()
  const host = await connectorHost(root, grant, config.hubUrl, {
    request: async (method, raw) => {
      if (method === 'event-deliver') {
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
          throw err
        }
      }
      if (method !== 'upstream') throw new Error('connector method unavailable')
      const params = raw as { method: string; params?: unknown; timeoutMs?: number }
      return dialer.request(params.method, params.params, params.timeoutMs)
    },
    notify: (method, raw) => {
      if (method !== 'event') return
      const event = raw as { method: string; params?: unknown }
      dialer?.notify(event.method, event.params)
    }
  })
  const identity = await host.rpc.request<ComputerIdentity>('identity')
  const hookDirectory = await stageComputerHooks(root, COMPUTER_VERSION)
  const activateHooks = async (): Promise<void> => {
    await host.rpc.request('hooks', { directory: hookDirectory })
    activate()
  }
  dialer = new HubDialer({
    url: config.hubUrl,
    identity: { ...identity, version: COMPUTER_VERSION },
    epoch: grant.health.epoch,
    connectorGeneration: grant.generation,
    credentialStore: createFileCredentialStore(hubHostFromUrl(config.hubUrl)),
    ...(config.joinToken ? { joinToken: config.joinToken } : {}),
    onHubRequest: async (method, params, actor) => {
      await ready
      return host.rpc.request('dispatch', { method, params, actor })
    },
    log: (message, meta) =>
      process.stdout.write(`[connector] ${message} ${JSON.stringify(meta ?? {})}\n`)
  })
  dialer.events.on('connected', (event) => {
    void host.rpc.request('connected', event).catch(() => undefined)
  })
  dialer.events.on('disconnected', (event) => {
    void host.rpc.request('disconnected', event).catch(() => undefined)
  })
  host.socket.once('close', () => {
    void dialer.stop()
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
    stop: async () => {
      await dialer.stop()
      host.close()
    }
  }
}
