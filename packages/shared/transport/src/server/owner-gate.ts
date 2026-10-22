/**
 * The runtime half of the tRPC owner checks (T-17): the classification is
 * `owner-policy.ts`, the decision `access.ts`, and the middleware that calls these two
 * functions is `ownerGate` in `trpc.ts` (kept there, like the other gates, so this
 * module does not import the tRPC instance).
 *
 *   before the handler  every id the input names must be accessible. One that is not —
 *                       someone else's, missing, or ownerless — answers NOT_FOUND
 *                       (never FORBIDDEN: a refusal must not say the thing exists)
 *                       with one `authz.denied` line, reason `not_owner`.
 *   after the handler   a list is cut to what the caller may access; a subscription's
 *                       observable is wrapped so each event is decided on the server.
 *
 * Inert without login (`getAuthGate()` false — the desktop app's hub): returns before
 * reading the policy, so every procedure there is byte-identical to before.
 *
 * `user` AND `admin` procedures are owner questions (T-106): the admin role decides
 * who may manage, never whose content (O-6), so an admin procedure that names a
 * project's automation is decided like any other id. Only `open` ones pass. A procedure
 * with no owner rule — one T-15 never classified included — is REFUSED here, so one
 * added without a decision fails closed at runtime as well as in `owner-policy.test.ts`.
 *
 * @module transport/server/owner-gate
 */
import { TRPCError } from '@trpc/server'
import { isObservable, observable, type Observable } from '@trpc/server/observable'
import { getSlayzoneHomeDir } from '@slayzone/platform'
import { securityEvent } from '@slayzone/platform/security-log'
import {
  createAccessScope,
  type AccessRequest,
  type AccessScope,
  type OwnedResource
} from './access'
import { TRPC_ADMIN_POLICY } from './admin-policy'
import { getAuthGate } from './app-deps'
import type { TrpcContext } from './context'
import {
  DROP,
  TRPC_OWNER_POLICY,
  hasOneOf,
  isOwnerQuestion,
  resourcesIn,
  type EventFilter,
  type OwnerRule,
  type StreamState
} from './owner-policy'

/** How long a live stream reuses a decision (see `AccessScopeOptions.ttlMs`). */
export const STREAM_DECISION_TTL_MS = 5_000

/** The facts `canAccess` needs, from a tRPC context. */
export function accessRequestOf(ctx: Pick<TrpcContext, 'principal' | 'dataRoot'>): AccessRequest {
  return {
    authRequired: getAuthGate(),
    principal: ctx.principal ? { userId: ctx.principal.userId } : null,
    hubRoots: [ctx.dataRoot, getSlayzoneHomeDir()].filter((r): r is string => !!r)
  }
}

/**
 * For a handler that aggregates (sums over rows) and so must scope its query itself:
 * the ids of the projects the caller may access, or null when nothing is restricted
 * (no login). See `SCOPED_IN_HANDLER` in owner-policy.ts.
 */
export function ownedProjectIds(
  ctx: Pick<TrpcContext, 'db' | 'principal' | 'dataRoot'>
): Promise<string[] | null> {
  return createAccessScope(ctx.db, accessRequestOf(ctx)).accessibleProjectIds()
}

/** The cause of an owner refusal. Never surfaced to the client (no `appCode`): the
 *  wire shows a plain NOT_FOUND. In-process callers and tests can tell it apart. */
export class NotOwnedError extends Error {
  constructor(readonly target: string) {
    super('Not found')
    this.name = 'NotOwnedError'
  }
}

export function isNotOwnedError(err: unknown): err is NotOwnedError {
  return err instanceof Error && err.name === 'NotOwnedError'
}

function refuse(
  path: string,
  reason: 'not_owner' | 'ownerless' | 'owner_unclassified',
  resource?: OwnedResource
): TRPCError {
  securityEvent({
    event: 'authz.denied',
    outcome: 'denied',
    targetKind: 'procedure',
    targetId: path,
    detail: {
      reason,
      ...(resource ? { resource: resource.kind } : {}),
      // A path can carry a user's directory names; the kind is enough there.
      ...(resource && resource.kind !== 'path' ? { resourceId: resource.id } : {})
    }
  })
  if (reason === 'owner_unclassified') {
    return new TRPCError({
      code: 'FORBIDDEN',
      message: `${path} has no owner rule (owner-policy.ts)`
    })
  }
  return new TRPCError({ code: 'NOT_FOUND', message: 'Not found', cause: new NotOwnedError(path) })
}

export interface OwnerCheck {
  readonly rule: OwnerRule
  readonly scope: AccessScope
  readonly userId: string
}

/**
 * Before the handler. Null when there is nothing to enforce: a hub without login, or
 * an `open` procedure. Throws the refusal.
 */
export async function checkOwnership(opts: {
  ctx: TrpcContext
  path: string
  type: 'query' | 'mutation' | 'subscription'
  getRawInput: () => Promise<unknown>
}): Promise<OwnerCheck | null> {
  if (!getAuthGate()) return null
  if (!isOwnerQuestion(TRPC_ADMIN_POLICY[opts.path])) return null
  const rule = TRPC_OWNER_POLICY[opts.path]
  if (!rule) throw refuse(opts.path, 'owner_unclassified')
  // The auth gate has already refused a call without a principal on this hub.
  const userId = opts.ctx.principal?.userId ?? ''
  const scope = createAccessScope(
    opts.ctx.db,
    accessRequestOf(opts.ctx),
    opts.type === 'subscription' ? { ttlMs: STREAM_DECISION_TTL_MS } : {}
  )
  if (rule.ids && rule.ids.length > 0) {
    const raw = await opts.getRawInput()
    if (rule.needsOne && !hasOneOf(raw, rule.needsOne)) throw refuse(opts.path, 'ownerless')
    for (const r of resourcesIn(raw, rule)) {
      if (!(await scope.allows(r))) throw refuse(opts.path, 'not_owner', r)
    }
  }
  return { rule, scope, userId }
}

/** After the handler: the result the caller may see. */
export async function ownedResult(check: OwnerCheck, data: unknown): Promise<unknown> {
  if (check.rule.output) return check.rule.output(data, check.scope)
  if (check.rule.events) return filterStream(data, check.rule.events, check)
  return data
}

const isPromise = (v: unknown): v is Promise<unknown> =>
  typeof v === 'object' && v !== null && typeof (v as { then?: unknown }).then === 'function'

/**
 * Wrap a subscription's source so each event passes `filter`. Order is kept: an
 * event decided synchronously (a cached decision) goes straight through unless an
 * earlier one is still being decided, in which case it queues behind it. A filter
 * that throws drops the event (fail closed) rather than ending the stream.
 */
export function filterStream(source: unknown, filter: EventFilter, check: OwnerCheck): unknown {
  const state: StreamState = { scope: check.scope, userId: check.userId }
  if (isObservable(source))
    return filterObservable(source as Observable<unknown, unknown>, filter, state)
  if (source && typeof (source as AsyncIterable<unknown>)[Symbol.asyncIterator] === 'function') {
    return filterIterable(source as AsyncIterable<unknown>, filter, state)
  }
  return source
}

function filterObservable(
  source: Observable<unknown, unknown>,
  filter: EventFilter,
  state: StreamState
): Observable<unknown, unknown> {
  return observable((emit) => {
    let closed = false
    let tail: Promise<void> | null = null
    const deliver = (out: unknown): void => {
      if (!closed && out !== DROP) emit.next(out)
    }
    const decide = (event: unknown): unknown => {
      try {
        // Synchronously, inside the emitter's call: `byActor` reads who caused it.
        return filter(event, state)
      } catch {
        return DROP
      }
    }
    const queue = (work: () => unknown): void => {
      const run: Promise<void> = (tail ?? Promise.resolve())
        .then(work)
        .then(deliver, () => undefined)
      tail = run
      void run.then(() => {
        if (tail === run) tail = null
      })
    }
    const sub = source.subscribe({
      next(event) {
        const out = decide(event)
        if (tail === null && !isPromise(out)) return deliver(out)
        queue(() => out)
      },
      error(err) {
        queue(() => {
          if (!closed) emit.error(err)
          return DROP
        })
      },
      complete() {
        queue(() => {
          if (!closed) emit.complete()
          return DROP
        })
      }
    })
    return () => {
      closed = true
      sub.unsubscribe()
    }
  })
}

/** Async-iterable subscriptions (none today): the emitter's context is gone by the
 *  time a value is pulled, so `byActor` sees the subscriber's own — it then lets the
 *  signal through, which is the no-content side of that rule. */
async function* filterIterable(
  source: AsyncIterable<unknown>,
  filter: EventFilter,
  state: StreamState
): AsyncGenerator<unknown> {
  for await (const event of source) {
    let out: unknown
    try {
      out = await filter(event, state)
    } catch {
      out = DROP
    }
    if (out !== DROP) yield out
  }
}
