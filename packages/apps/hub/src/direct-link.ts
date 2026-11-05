/**
 * Issues direct-link capabilities (docs/direct-link.md).
 *
 * By the time `issue` runs, the tRPC owner gate has already checked that the caller
 * may touch the session or tab (`computers.issueDirectLink`, owner-policy). This
 * module then:
 *
 *  1. resolves which connected computer holds the session or tab;
 *  2. asks the placement gate whether that computer may serve this work for this
 *     caller — the same gate a routed request passes on its way to a computer;
 *  3. decides reachability: a loopback listener is offered only when the client and
 *     the computer both reach the hub from loopback, i.e. all three run on one
 *     machine;
 *  4. mints a 256-bit token, registers only its SHA-256 on the computer
 *     (`direct.grant`), and hands the raw token to the client only after the
 *     computer has acknowledged the grant.
 *
 * Every issue writes one `computer.direct_grant` audit line, with the grant id, never
 * the token; every revocation one `computer.direct_revoke` line per computer. The
 * issuer remembers live grants per computer, so a reconnect can reset the computer to
 * exactly that set and a revocation can name them.
 *
 * Unavailable is an answer, never an error: the client then uses the hub relay,
 * which is always correct.
 *
 * @module hub/direct-link
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type { ComputerWork } from '@slayzone/computer-transport/server'
import {
  DIRECT_GRANT_TTL_MS,
  DIRECT_LINK_PROTOCOL,
  type DirectGrantParams,
  type DirectResource,
  type DirectRevokeParams,
  HubToComputerMethods
} from '@slayzone/computer-transport/shared'
import type {
  DirectLinkIssueResult,
  DirectLinkResource,
  DirectLinkTarget
} from '@slayzone/computers/shared'
import { isLoopbackAuthority, isLoopbackPeer } from '@slayzone/platform/hub-addr'
import { securityEvent } from '@slayzone/platform/security-log'

/** The slice of the computer gateway the issuer needs. */
export interface DirectLinkGateway {
  listUsableComputers(): ReadonlyArray<{
    computerId: string
    directAddress: string | null
    peerLoopback: boolean
  }>
  request(computerId: string, method: string, params: unknown): Promise<unknown>
}

export interface DirectLinkIssuerDeps {
  gateway: DirectLinkGateway
  /**
   * The computer holding a terminal session, or null. `direct: false` when the hub,
   * not the computer, holds its output (nothing for a client to read there).
   */
  resolvePty(
    sessionId: string
  ): Promise<{ computerId: string; direct: boolean; taskId: string } | null>
  /** The computer holding an ACTIVE chat tab, its ownership epoch and task, or null. */
  resolveChat(tabId: string): Promise<{ computerId: string; epoch: number; taskId: string } | null>
  /** The placement gate (computer-placement.ts). Absent on a hub without login. */
  gate?: (computerId: string, work: ComputerWork) => Promise<void>
  /** Wall clock ms, for forgetting expired grants. */
  now?: () => number
}

export interface DirectLinkCaller {
  userId: string | null
  /** The client's address as the hub saw it. */
  ip: string | null
}

interface IssuedGrant {
  grantId: string
  computerId: string
  userId: string | null
  taskId: string
  resource: DirectResource
  expiresAt: number
}

/** Which grants a revocation drops. */
export type DirectRevocation =
  /** Account disabled, or its sessions ended (SSO refusal). */
  | { by: 'user'; userId: string }
  /** Task closed (archived, deleted, its agents stopped). */
  | { by: 'task'; taskId: string }
  /** One session or tab (chat ownership moved, tab removed). */
  | { by: 'target'; target: DirectLinkResource }
  /** Computer revoked: everything this hub granted on it. */
  | { by: 'computer'; computerId: string }

export interface DirectLinkIssuer {
  issue(target: DirectLinkTarget, caller: DirectLinkCaller): Promise<DirectLinkIssueResult>
  /** Live grant ids this hub issued on a computer (for `direct.reset`). */
  heldGrantIds(computerId: string): string[]
  /**
   * Drop grants now: forgotten here first, then revoked on each computer holding
   * one. Best-effort on the wire — a computer that cannot be told is reset to this
   * hub's held set when it reconnects, and a grant never outlives its TTL.
   */
  revoke(which: DirectRevocation, reason: string): Promise<void>
  /** A computer (re)connected: reset it to exactly the grants this hub still holds. */
  computerConnected(computerId: string): Promise<void>
}

export function createDirectLinkIssuer(deps: DirectLinkIssuerDeps): DirectLinkIssuer {
  const now = deps.now ?? Date.now
  const grants = new Map<string, IssuedGrant>()

  function prune(): void {
    const t = now()
    for (const [id, g] of grants) if (g.expiresAt <= t) grants.delete(id)
  }

  function matches(g: IssuedGrant, which: DirectRevocation): boolean {
    switch (which.by) {
      case 'user':
        return g.userId === which.userId
      case 'task':
        return g.taskId === which.taskId
      case 'computer':
        return g.computerId === which.computerId
      case 'target':
        return which.target.kind === 'pty'
          ? g.resource.kind === 'pty' && g.resource.sessionId === which.target.sessionId
          : g.resource.kind === 'chat' && g.resource.tabId === which.target.tabId
    }
  }

  async function locate(
    target: DirectLinkResource
  ): Promise<
    | { computerId: string; resource: DirectResource; work: ComputerWork; taskId: string }
    | { unavailable: 'no-computer' | 'not-direct' }
  > {
    if (target.kind === 'pty') {
      const held = await deps.resolvePty(target.sessionId)
      if (!held) return { unavailable: 'no-computer' }
      if (!held.direct) return { unavailable: 'not-direct' }
      return {
        computerId: held.computerId,
        resource: { kind: 'pty', sessionId: target.sessionId },
        work: { kind: 'session', id: target.sessionId },
        taskId: held.taskId
      }
    }
    const held = await deps.resolveChat(target.tabId)
    if (!held) return { unavailable: 'no-computer' }
    return {
      computerId: held.computerId,
      resource: { kind: 'chat', tabId: target.tabId, epoch: held.epoch },
      work: { kind: 'task', id: held.taskId },
      taskId: held.taskId
    }
  }

  return {
    async issue(target, caller) {
      const located = await locate(target)
      if ('unavailable' in located) return { available: false, reason: located.unavailable }
      // The target's task (and computer, when named) is what the owner gate checked:
      // the resource must lie inside it, or the check covered something else.
      if (
        located.taskId !== target.taskId ||
        (target.computerId !== undefined && target.computerId !== located.computerId)
      ) {
        return { available: false, reason: 'wrong-target' }
      }
      const computer = deps.gateway
        .listUsableComputers()
        .find((c) => c.computerId === located.computerId)
      if (!computer) return { available: false, reason: 'no-computer' }
      if (!computer.directAddress) return { available: false, reason: 'no-address' }
      if (
        isLoopbackAuthority(computer.directAddress) &&
        !(computer.peerLoopback && isLoopbackPeer(caller.ip))
      ) {
        return { available: false, reason: 'unreachable' }
      }
      // Throws on refusal: a caller the gate refuses gets the same error the relayed
      // request would, not a silent fallback.
      await deps.gate?.(computer.computerId, located.work)

      const token = randomBytes(32).toString('base64url')
      const params: DirectGrantParams = {
        grantId: randomUUID(),
        tokenHash: createHash('sha256').update(token).digest('hex'),
        userId: caller.userId,
        resource: located.resource,
        ttlMs: DIRECT_GRANT_TTL_MS
      }
      await deps.gateway.request(computer.computerId, HubToComputerMethods.directGrant, params)
      prune()
      grants.set(params.grantId, {
        grantId: params.grantId,
        computerId: computer.computerId,
        userId: caller.userId,
        taskId: located.taskId,
        resource: params.resource,
        expiresAt: now() + params.ttlMs
      })
      securityEvent({
        event: 'computer.direct_grant',
        outcome: 'success',
        targetKind: 'computer',
        targetId: computer.computerId,
        detail: {
          grantId: params.grantId,
          resource: params.resource.kind,
          resourceId:
            params.resource.kind === 'pty' ? params.resource.sessionId : params.resource.tabId,
          ttlMs: params.ttlMs
        }
      })
      return {
        available: true,
        computerId: computer.computerId,
        address: computer.directAddress,
        token,
        grantId: params.grantId,
        expiresInMs: params.ttlMs,
        protocol: DIRECT_LINK_PROTOCOL
      }
    },

    heldGrantIds(computerId) {
      prune()
      return [...grants.values()].filter((g) => g.computerId === computerId).map((g) => g.grantId)
    },

    async revoke(which, reason) {
      prune()
      const byComputer = new Map<string, string[]>()
      for (const [id, g] of grants) {
        if (!matches(g, which)) continue
        grants.delete(id)
        byComputer.set(g.computerId, [...(byComputer.get(g.computerId) ?? []), id])
      }
      // A revoked computer drops everything this hub ever granted there, including
      // grants this map has already forgotten as expired.
      if (which.by === 'computer' && !byComputer.has(which.computerId)) {
        byComputer.set(which.computerId, [])
      }
      await Promise.all(
        [...byComputer].map(async ([computerId, grantIds]) => {
          const params: DirectRevokeParams =
            which.by === 'computer' ? { by: 'all' } : { by: 'grant', grantIds }
          await deps.gateway
            .request(computerId, HubToComputerMethods.directRevoke, params)
            .catch(() => undefined)
          securityEvent({
            event: 'computer.direct_revoke',
            outcome: 'success',
            targetKind: 'computer',
            targetId: computerId,
            detail: { reason, grants: grantIds.length }
          })
        })
      )
    },

    async computerConnected(computerId) {
      prune()
      const keep = [...grants.values()]
        .filter((g) => g.computerId === computerId)
        .map((g) => g.grantId)
      await deps.gateway
        .request(computerId, HubToComputerMethods.directReset, { keep })
        .catch(() => undefined)
    }
  }
}
