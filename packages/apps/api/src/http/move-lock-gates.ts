/**
 * The move lock (move-lock.ts) for REST routes and MCP tools: a write to a task that
 * is being moved to another hub is refused — REST with 409, MCP with a tool error —
 * before its handler runs. Login or not: the lock is about the data, not the caller.
 *
 * Its own layer, stacked on the owner gates (`withOwnerGate`, `withMcpOwnerGate`),
 * which stay inert without login. It reads the same owner policies for the ids a
 * request names, and only once a move holds a lock on this hub.
 *
 * @module api/http/move-lock-gates
 */
import type { Express, NextFunction, Request, Response } from 'express'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { SlayzoneDb } from '@slayzone/platform'
import { MCP_OWNER_POLICY, REST_OWNER_POLICY, type HttpOwnerRule } from '../http-owner-policy'
import { assertHttpNotMoving, TaskMovingError } from '../move-lock'
import { restRouteKey } from './rest-api/admin-routes'

const WRITE_METHODS: ReadonlySet<string> = new Set(['post', 'put', 'patch', 'delete'])

/** The guard for one REST route. */
function moveLockGuard(
  rule: HttpOwnerRule | undefined,
  db: SlayzoneDb
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    if (!rule?.ids?.length) return next()
    try {
      await assertHttpNotMoving(db, rule.ids, {
        params: req.params,
        query: req.query,
        body: req.body
      })
    } catch (err) {
      if (!(err instanceof TaskMovingError)) return next(err)
      res.status(409).json({ ok: false, error: err.message })
      return
    }
    next()
  }
}

/** Every write route registered on the result gets {@link moveLockGuard} first. */
export function withMoveLockGate(
  app: Express,
  db: SlayzoneDb,
  policy: Readonly<Record<string, HttpOwnerRule>> = REST_OWNER_POLICY
): Express {
  return new Proxy(app, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver)
      if (typeof prop !== 'string' || !WRITE_METHODS.has(prop) || typeof value !== 'function')
        return value
      return (path: unknown, ...handlers: unknown[]) => {
        if (handlers.length === 0 || typeof path !== 'string')
          return value.call(target, path, ...handlers)
        const guard = moveLockGuard(policy[restRouteKey(prop, path)], db)
        return value.call(target, path, guard, ...handlers)
      }
    }
  })
}

const refusal = (text: string) => ({ content: [{ type: 'text' as const, text }], isError: true })

/**
 * Every MCP tool registered on the result checks the lock first. Only `get_*` tools
 * only read; every other tool writes.
 */
export function withMcpMoveLockGate(
  server: McpServer,
  db: SlayzoneDb,
  policy: Readonly<Record<string, HttpOwnerRule>> = MCP_OWNER_POLICY
): McpServer {
  return new Proxy(server, {
    get(target, prop, receiver) {
      const value: unknown = Reflect.get(target, prop, receiver)
      if ((prop !== 'tool' && prop !== 'registerTool') || typeof value !== 'function') return value
      return (name: string, ...rest: unknown[]) => {
        const handler = rest[rest.length - 1]
        const rule = policy[name]
        if (typeof handler !== 'function' || name.startsWith('get_') || !rule?.ids?.length)
          return value.call(target, name, ...rest)
        const locked = async (...args: unknown[]) => {
          try {
            await assertHttpNotMoving(db, rule.ids ?? [], args.length > 1 ? args[0] : {})
          } catch (err) {
            if (err instanceof TaskMovingError) return refusal(err.message)
            throw err
          }
          return handler(...args)
        }
        return value.call(target, name, ...rest.slice(0, -1), locked)
      }
    }
  })
}
