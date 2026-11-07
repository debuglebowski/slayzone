/**
 * The IPC contract between the desktop app's supervised local computer and the app
 * that spawned it (`SLAYZONE_SUPERVISED=1`, IPC channel on fd 3). `bin.ts` wires it;
 * this module owns the message shapes and their handling, so they are tested
 * without a child process.
 *
 * Why it exists: that computer serves the app's own loopback hub (its PRIMARY), and
 * the app can also have it join further hubs at RUNTIME — restarting it to change
 * hubs would kill every agent pty it runs. The app owns which hubs those are (and
 * mints their join tokens); the computer owns the connections.
 *
 * Child → parent:
 *   { type: 'connected', hubUrl, computerId, primary }
 *   { type: 'disconnected', hubUrl, primary }
 *   { type: 'hub-error', hubUrl, primary: false, message, reason? }  — a SECONDARY
 *       hub's dialer gave up (the primary's fatal is the exit code, as always)
 *   { type: 'join-token-request', requestId, hubUrl }  — a secondary needs a fresh
 *       single-use token; answered by `join-token`, or null after 60s
 *   { type: 'hubs-ready' }  — the parent-message listener is installed; the parent
 *       sends `set-hubs` only after this, so none is lost
 * Parent → child:
 *   { type: 'set-hubs', hubs: [{ url, name, joinToken? }] }  — the desired secondary
 *       set (see ComputerHandle.setSecondaryHubs)
 *   { type: 'join-token', requestId, token | null }
 *
 * Incoming messages are validated; a malformed one is ignored whole — applying part
 * of a `set-hubs` would DISCONNECT the hubs whose entries were dropped.
 *
 * @module computer/supervisor-ipc
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { ComputerLog } from './handlers/types'
import type { ComputerHandle, HubConnectionInfo, SecondaryHubSpec } from './main'

export type ChildToParentMessage =
  | { type: 'connected'; hubUrl: string; computerId: string; primary: boolean }
  | { type: 'disconnected'; hubUrl: string; primary: boolean }
  | {
      type: 'hub-error'
      hubUrl: string
      primary: false
      message: string
      reason?: 'needs-re-enrollment'
    }
  | { type: 'join-token-request'; requestId: string; hubUrl: string }
  | { type: 'hubs-ready' }

/** How long a secondary's dialer waits for the parent to mint a join token. */
export const JOIN_TOKEN_REQUEST_TIMEOUT_MS = 60_000

const hubUrlSchema = z.string().refine((value) => {
  try {
    const { protocol } = new URL(value)
    return protocol === 'ws:' || protocol === 'wss:'
  } catch {
    return false
  }
}, 'expected a ws:// or wss:// url')

const setHubsSchema = z.object({
  type: z.literal('set-hubs'),
  hubs: z.array(
    z.object({
      url: hubUrlSchema,
      name: z.string().min(1),
      joinToken: z.string().min(1).optional()
    })
  )
})

const joinTokenSchema = z.object({
  type: z.literal('join-token'),
  requestId: z.string().min(1),
  token: z.string().nullable()
})

export interface SupervisorIpcOptions {
  /** Deliver one message to the parent; false when it cannot be delivered. */
  send: (message: ChildToParentMessage) => boolean
  log?: ComputerLog
  joinTokenTimeoutMs?: number
  /** Tests: deterministic request ids. */
  newRequestId?: () => string
}

export interface SupervisorIpc {
  /** Report one hub connection's lifecycle (pass as `onConnection` to startComputer). */
  reportConnection(connection: HubConnectionInfo): void
  /** Ask the parent for a fresh join token (pass as `refreshJoinTokenFor`). */
  requestJoinToken(hubUrl: string): Promise<string | null>
  /** Handle one raw parent message. */
  handleMessage(raw: unknown, handle: Pick<ComputerHandle, 'setSecondaryHubs'>): void
  /** Tell the parent `set-hubs` will now be received. */
  ready(): void
  /** Settle every pending token request with null (stopping). */
  dispose(): void
}

export function createSupervisorIpc(options: SupervisorIpcOptions): SupervisorIpc {
  const log =
    options.log ??
    (() => {
      // No sink: diagnostics are discarded.
    })
  const timeoutMs = options.joinTokenTimeoutMs ?? JOIN_TOKEN_REQUEST_TIMEOUT_MS
  const newRequestId = options.newRequestId ?? randomUUID
  const pending = new Map<string, (token: string | null) => void>()

  const reportConnection = ({ hubUrl, primary, dialer }: HubConnectionInfo): void => {
    dialer.events.on('connected', ({ computerId }) => {
      options.send({ type: 'connected', hubUrl, computerId, primary })
    })
    dialer.events.on('disconnected', () => {
      options.send({ type: 'disconnected', hubUrl, primary })
    })
    // The primary's fatal is reported the way it always was — the process exit
    // code — because the parent restarting the computer is the remedy for it. A
    // secondary's is not: the computer stays up for its other hubs, so the parent
    // learns it here (and may answer with a fresh token via set-hubs).
    if (!primary) {
      dialer.events.on('error', ({ error, fatal, reason }) => {
        if (!fatal) return
        options.send({
          type: 'hub-error',
          hubUrl,
          primary: false,
          message: error.message,
          ...(reason ? { reason } : {})
        })
      })
    }
  }

  const requestJoinToken = (hubUrl: string): Promise<string | null> =>
    new Promise((resolve) => {
      const requestId = newRequestId()
      const timer = setTimeout(() => settle(null), timeoutMs)
      // Never what keeps a stopping computer alive.
      timer.unref?.()
      function settle(token: string | null): void {
        clearTimeout(timer)
        pending.delete(requestId)
        resolve(token)
      }
      pending.set(requestId, settle)
      // An unreachable parent cannot answer: say so now rather than after the timeout.
      if (!options.send({ type: 'join-token-request', requestId, hubUrl })) settle(null)
    })

  const handleMessage: SupervisorIpc['handleMessage'] = (raw, handle) => {
    const type = raw && typeof raw === 'object' ? (raw as { type?: unknown }).type : undefined
    if (type === 'set-hubs') {
      const parsed = setHubsSchema.safeParse(raw)
      if (!parsed.success) {
        log('ignoring a malformed set-hubs message', { issues: parsed.error.issues.length })
        return
      }
      const hubs: SecondaryHubSpec[] = parsed.data.hubs.map(({ url, name, joinToken }) => ({
        url,
        name,
        ...(joinToken !== undefined ? { joinToken } : {})
      }))
      if (!handle.setSecondaryHubs) {
        log('ignoring set-hubs: this computer cannot serve additional hubs')
        return
      }
      void handle.setSecondaryHubs(hubs)
      return
    }
    if (type === 'join-token') {
      const parsed = joinTokenSchema.safeParse(raw)
      if (!parsed.success) {
        log('ignoring a malformed join-token message')
        return
      }
      // An empty token is no token.
      pending.get(parsed.data.requestId)?.(parsed.data.token || null)
    }
    // Anything else is not addressed to this contract.
  }

  return {
    reportConnection,
    requestJoinToken,
    handleMessage,
    ready: () => {
      options.send({ type: 'hubs-ready' })
    },
    dispose: () => {
      for (const settle of [...pending.values()]) settle(null)
    }
  }
}
