import type { IncomingHttpHeaders } from 'node:http'
import { fromNodeHeaders } from 'better-auth/node'
import type { RequestHandler, Response } from 'express'
import type { HubAuthContext, RunnerPrincipal } from '../shared/types'
import type { HubAuth } from './auth'

/** Header runners present their API key in (mirrors the apiKey plugin default). */
export const API_KEY_HEADER = 'x-api-key'

function toWebHeaders(headers: Headers | IncomingHttpHeaders): Headers {
  return headers instanceof Headers ? headers : fromNodeHeaders(headers)
}

/**
 * Plain session verify usable outside express. Resolves a session from
 * request headers — session cookie or `Authorization: Bearer <token>` (bearer
 * plugin). Returns null when there is no valid session.
 */
export async function verifySession(
  auth: HubAuth,
  headers: Headers | IncomingHttpHeaders
): Promise<HubAuthContext | null> {
  const result = await auth.api.getSession({ headers: toWebHeaders(headers) })
  if (!result) return null
  const orgId = (result.session.activeOrganizationId as string | null | undefined) ?? null
  return { userId: result.user.id, orgId, session: result.session }
}

function readRunnerId(metadata: unknown): string | null {
  let parsed = metadata
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const runnerId = (parsed as Record<string, unknown>).runnerId
  return typeof runnerId === 'string' && runnerId.length > 0 ? runnerId : null
}

/**
 * Plain API-key verify usable outside express. Valid only for keys minted by
 * `mintRunnerApiKey` (i.e. carrying `{ runnerId }` metadata). Returns null
 * for unknown, revoked, expired, or non-runner keys.
 */
export async function verifyRunnerApiKey(
  auth: HubAuth,
  key: string
): Promise<RunnerPrincipal | null> {
  const result = await auth.api.verifyApiKey({ body: { key } })
  if (!result.valid || !result.key) return null
  const runnerId = readRunnerId(result.key.metadata)
  if (!runnerId) return null
  return { runnerId, keyId: result.key.id }
}

/**
 * Express middleware factory: rejects with 401 unless the request carries a
 * valid session (cookie or bearer token). On success the context is attached
 * as `res.locals.hubAuth` (read it via `getHubAuthContext`).
 */
export function requireSession(auth: HubAuth): RequestHandler {
  return async (req, res, next) => {
    try {
      const context = await verifySession(auth, req.headers)
      if (!context) {
        res.status(401).json({ error: 'Unauthorized' })
        return
      }
      res.locals.hubAuth = context
      next()
    } catch (error) {
      next(error)
    }
  }
}

/**
 * Express middleware factory: rejects with 401 unless the request carries a
 * valid runner API key in the `x-api-key` header. On success the principal is
 * attached as `res.locals.runner` (read it via `getRunnerPrincipal`).
 */
export function requireApiKey(auth: HubAuth): RequestHandler {
  return async (req, res, next) => {
    try {
      const header = req.headers[API_KEY_HEADER]
      const key = Array.isArray(header) ? header[0] : header
      if (!key) {
        res.status(401).json({ error: 'Missing API key' })
        return
      }
      const principal = await verifyRunnerApiKey(auth, key)
      if (!principal) {
        res.status(401).json({ error: 'Invalid API key' })
        return
      }
      res.locals.runner = principal
      next()
    } catch (error) {
      next(error)
    }
  }
}

/** Typed accessor for the context `requireSession` attached. */
export function getHubAuthContext(res: Response): HubAuthContext | null {
  return (res.locals.hubAuth as HubAuthContext | undefined) ?? null
}

/** Typed accessor for the principal `requireApiKey` attached. */
export function getRunnerPrincipal(res: Response): RunnerPrincipal | null {
  return (res.locals.runner as RunnerPrincipal | undefined) ?? null
}
