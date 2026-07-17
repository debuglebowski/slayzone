/**
 * In-process loopback fixtures for runner tests: a real `ws` server wired to a
 * real hub gateway, plus an in-memory enrollment/auth backend. No app needed.
 *
 * @module runner/testing/loopback
 */

import type { AddressInfo } from 'node:net'
import { randomUUID } from 'node:crypto'
import { WebSocketServer, type ServerOptions } from 'ws'
import { createHubRunnerGateway, type HubRunnerGateway, type HubRunnerGatewayOptions } from '../server/hub-gateway'
import { RunnerTransportErrorCodes, type EnrollParams } from '../shared/frames'
import { RpcError } from '../shared/rpc'

export interface MemoryRunnerAuth {
  verifyEnrollment: HubRunnerGatewayOptions['verifyEnrollment']
  verifyApiKey: HubRunnerGatewayOptions['verifyApiKey']
  /** apiKey → identity, for assertions. */
  readonly byApiKey: Map<
    string,
    { runnerId: string; name: string; platform: string; version: string; capabilities: string[] }
  >
  readonly enrollCalls: EnrollParams[]
  readonly helloCalls: string[]
}

export function createMemoryRunnerAuth(validJoinToken = 'jt-valid'): MemoryRunnerAuth {
  const byApiKey: MemoryRunnerAuth['byApiKey'] = new Map()
  const enrollCalls: EnrollParams[] = []
  const helloCalls: string[] = []
  let counter = 0
  return {
    byApiKey,
    enrollCalls,
    helloCalls,
    verifyEnrollment: async (params) => {
      enrollCalls.push(params)
      if (params.joinToken !== validJoinToken) {
        throw new RpcError(RunnerTransportErrorCodes.unauthorized, 'bad join token')
      }
      counter += 1
      const runnerId = `runner-${counter}`
      const apiKey = `key-${randomUUID()}`
      byApiKey.set(apiKey, {
        runnerId,
        name: params.name,
        platform: params.platform,
        version: params.version,
        capabilities: params.capabilities
      })
      return { runnerId, apiKey }
    },
    verifyApiKey: async (apiKey) => {
      helloCalls.push(apiKey)
      return byApiKey.get(apiKey) ?? null
    }
  }
}

export interface LoopbackHub {
  gateway: HubRunnerGateway
  auth: MemoryRunnerAuth
  wss: WebSocketServer
  port: number
  url: string
  close(): Promise<void>
}

export async function startLoopbackHub(
  gatewayOverrides: Partial<HubRunnerGatewayOptions> = {},
  serverOptions: ServerOptions = {}
): Promise<LoopbackHub> {
  const auth = createMemoryRunnerAuth()
  const gateway = createHubRunnerGateway({
    verifyEnrollment: auth.verifyEnrollment,
    verifyApiKey: auth.verifyApiKey,
    ...gatewayOverrides
  })
  // With an external `server` (e.g. a pre-started https server) ws never
  // emits 'listening' — only self-listening servers must be awaited.
  const external = serverOptions.server !== undefined || serverOptions.noServer === true
  const wss = external
    ? new WebSocketServer(serverOptions)
    : new WebSocketServer({ host: '127.0.0.1', port: 0, ...serverOptions })
  if (!external) {
    await new Promise<void>((resolve, reject) => {
      wss.once('listening', resolve)
      wss.once('error', reject)
    })
  }
  wss.on('connection', (ws) => gateway.handleConnection(ws))
  const port = external ? 0 : (wss.address() as AddressInfo).port
  return {
    gateway,
    auth,
    wss,
    port,
    url: `ws://127.0.0.1:${port}`,
    close: async () => {
      gateway.close()
      await new Promise<void>((resolve) => wss.close(() => resolve()))
    }
  }
}
