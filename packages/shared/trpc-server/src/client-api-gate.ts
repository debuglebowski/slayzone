/**
 * The hub's half of the client ↔ hub API contract (./api-version): a client older
 * than {@link MIN_CLIENT_API} is refused on every procedure with PRECONDITION_FAILED
 * and `data.appCode: CLIENT_TOO_OLD`, so it says "update SlayZone" instead of
 * failing call by call in ways nobody can read. `hub.describe` stays open (an
 * `openProcedure`), so the client can still find out why.
 *
 * @module trpc-server/client-api-gate
 */
import type { IncomingMessage } from 'node:http'
import { TRPCError } from '@trpc/server'
import { CLIENT_TOO_OLD, MIN_CLIENT_API, parseClientApi } from './api-version'

export class ClientTooOldError extends Error {
  readonly code = CLIENT_TOO_OLD
  constructor(
    readonly clientApi: number,
    readonly minClientApi: number
  ) {
    super(
      `This app is too old for this hub (app API ${clientApi}, hub needs ${minClientApi} or newer) — update SlayZone`
    )
    this.name = 'ClientTooOldError'
  }
}

export function isClientTooOldError(err: unknown): err is ClientTooOldError {
  return err instanceof ClientTooOldError
}

/** Parsed once per request: a socket's upgrade request serves every operation on it. */
const parsed = new WeakMap<IncomingMessage, number>()

function clientApiOf(req: IncomingMessage): number {
  let v = parsed.get(req)
  if (v === undefined) {
    v = parseClientApi(req.url)
    parsed.set(req, v)
  }
  return v
}

/**
 * Throws when the request's client is below {@link MIN_CLIENT_API}. No request = an
 * in-process caller (the hub's own code): never refused.
 */
export function assertClientApiServed(req: IncomingMessage | undefined): void {
  if (!req || MIN_CLIENT_API <= 0) return
  const clientApi = clientApiOf(req)
  if (clientApi >= MIN_CLIENT_API) return
  const cause = new ClientTooOldError(clientApi, MIN_CLIENT_API)
  throw new TRPCError({ code: 'PRECONDITION_FAILED', message: cause.message, cause })
}
