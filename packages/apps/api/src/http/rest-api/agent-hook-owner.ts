import type { SlayzoneDb } from '@slayzone/platform'
import { securityEvent } from '@slayzone/platform/security-log'
import { unadoptedWarmAgent } from '@slayzone/terminal/hub'
import { createAccessScope, type AccessScope, type OwnedResource } from '../../access'
import { httpAccessRequest } from '../owner-scope'

/**
 * Whose an agent hook event is, on a hub with login (T-18).
 *
 * A hook reaches the hub two ways: a computer RELAYS it over its authenticated ws
 * channel (`apps/hub` agent-hook-relay-consumer.ts), or a signed-in caller POSTs it to
 * `/api/agent-hook`. Either way it is reported AS someone — the computer's owner, or
 * the principal — and THE RULE is: an event may only touch what its reporter may
 * access (`canAccess`). So a computer reports only for sessions it runs for its owner,
 * and an event naming another user's task or session changes nothing: it is dropped
 * with one `authz.denied` line (`detail.source: 'agent-hook'`; the target is the
 * relaying computer, or the REST route).
 *
 * What an event touches, and so what is checked:
 *   - its task (the envelope's `taskId`): lifecycle event, prompt capture, conversation
 *     id, the pty state machine;
 *   - unless that id is a warm agent's the pool still holds (`unadoptedWarmAgent`): the
 *     agent booted with the id of a task created later, if ever, so the task may not
 *     exist. Such an agent belongs to the project it was warmed for, on the computer
 *     holding it — the relaying computer must be that one;
 *   - or the relaying computer says the event came from a warm agent it holds or held
 *     unadopted (`warmId`, the relay's `fromWarm` — never the envelope's) and the pool
 *     no longer holds it: the hub dropped it before the kill whose `SessionEnd` this
 *     is, or a restart emptied the pool. It touches nothing (processAgentHook drops
 *     it), and its reporter is that computer's owner — let through without an audit
 *     line. Not a weaker check: nothing is processed for it. Over REST (no computer)
 *     the claim is ignored;
 *   - no task id: nothing to attribute it to → dropped.
 * A denied task id with no task row is logged as `unknown_task`, not `not_owner`: no
 * one else owns it.
 * An unowned computer reports for nobody. A hub without login checks nothing (the
 * desktop app's hub — byte-identical to before).
 *
 * The event is then processed AS its reporter (the caller sets the security context),
 * so its refresh pings reach that user's streams only (T-17's stream filter).
 *
 * @module transport/rest-api/agent-hook-owner
 */

export interface HookReporter {
  /** The REST principal, or the owner of the relaying computer. Null: nobody. */
  readonly userId: string | null
  /** The relaying computer; null for `POST /api/agent-hook`. */
  readonly computerId: string | null
}

/** What a resolved hook names. */
export interface HookTargets {
  readonly taskId?: string
  /** The relaying computer's warm-origin claim (`fromWarm.warmId`), if any. */
  readonly warmId?: string
}

/** Decisions are reused for a few seconds per reporter: hooks fire many times a turn. */
const SCOPE_TTL_MS = 5_000
const scopesByDb = new WeakMap<SlayzoneDb, Map<string, AccessScope>>()

function scopeFor(db: SlayzoneDb, userId: string): AccessScope {
  let scopes = scopesByDb.get(db)
  if (!scopes) {
    scopes = new Map()
    scopesByDb.set(db, scopes)
  }
  let scope = scopes.get(userId)
  if (!scope) {
    if (scopes.size > 1_000) scopes.clear()
    scope = createAccessScope(db, httpAccessRequest(userId), { ttlMs: SCOPE_TTL_MS })
    scopes.set(userId, scope)
  }
  return scope
}

type Verdict = { ok: true } | { ok: false; reason: string; resource?: OwnedResource }

async function decide(
  db: SlayzoneDb,
  reporter: HookReporter | undefined,
  targets: HookTargets
): Promise<Verdict> {
  if (!reporter?.userId) return { ok: false, reason: 'no_reporter' }
  if (!targets.taskId) return { ok: false, reason: 'ownerless' }
  const scope = scopeFor(db, reporter.userId)
  const r: OwnedResource = { kind: 'taskOwner', id: targets.taskId }
  const warm = unadoptedWarmAgent(targets.taskId)
  if (warm) {
    if (reporter.computerId !== null && warm.computerId !== reporter.computerId) {
      return { ok: false, reason: 'not_this_computer', resource: r }
    }
    const p: OwnedResource = { kind: 'projectOwner', id: warm.projectId }
    if (!(await scope.allows(p))) return { ok: false, reason: 'not_owner', resource: r }
    return { ok: true }
  }
  if (targets.warmId && reporter.computerId !== null) return { ok: true }
  if (await scope.allows(r)) return { ok: true }
  // Deny path only (off the hot path): say whether the task exists at all.
  const row = await db.get<{ x: number }>('SELECT 1 AS x FROM tasks WHERE id = ?', [targets.taskId])
  return { ok: false, reason: row ? 'not_owner' : 'unknown_task', resource: r }
}

/**
 * True when the event may be processed. On a refusal writes the one audit line.
 * Only called on a hub with login.
 */
export async function hookReporterMayTouch(
  db: SlayzoneDb,
  reporter: HookReporter | undefined,
  targets: HookTargets,
  hookEvent: string
): Promise<boolean> {
  const verdict = await decide(db, reporter, targets)
  if (verdict.ok) return true
  securityEvent({
    event: 'authz.denied',
    outcome: 'denied',
    actor: reporter?.userId ?? null,
    // The relaying computer, or the REST route the event was posted to.
    targetKind: reporter?.computerId ? 'computer' : 'procedure',
    targetId: reporter?.computerId ?? 'POST /api/agent-hook',
    detail: {
      reason: verdict.reason,
      source: 'agent-hook',
      hookEvent,
      ...(verdict.resource
        ? { resource: verdict.resource.kind, resourceId: verdict.resource.id }
        : {})
    }
  })
  return false
}
