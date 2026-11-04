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
 * the token. The issuer remembers live grants per computer, so a reconnect can reset
 * the computer to exactly that set and a revocation can name them.
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
  HubToComputerMethods
} from '@slayzone/computer-transport/shared'
import type { DirectLinkIssueResult, DirectLinkTarget } from '@slayzone/computers/shared'
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
  resolvePty(sessionId: string): Promise<{ computerId: string; direct: boolean } | null>
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
  resource: DirectResource
  expiresAt: number
}

export interface DirectLinkIssuer {
  issue(target: DirectLinkTarget, caller: DirectLinkCaller): Promise<DirectLinkIssueResult>
  /** Live grant ids this hub issued on a computer (for `direct.reset`). */
  heldGrantIds(computerId: string): string[]
  /** Live grants, for revocation by user or resource. */
  heldGrants(): readonly IssuedGrant[]
  /** Forget grants the computer has dropped (revoked, or the computer restarted). */
  forget(predicate: (grant: IssuedGrant) => boolean): IssuedGrant[]
}

export function createDirectLinkIssuer(deps: DirectLinkIssuerDeps): DirectLinkIssuer {
  const now = deps.now ?? Date.now
  const grants = new Map<string, IssuedGrant>()

  function prune(): void {
    const t = now()
    for (const [id, g] of grants) if (g.expiresAt <= t) grants.delete(id)
  }

  async function locate(
    target: DirectLinkTarget
  ): Promise<
    | { computerId: string; resource: DirectResource; work: ComputerWork }
    | { unavailable: 'no-computer' | 'not-direct' }
  > {
    if (target.kind === 'pty') {
      const held = await deps.resolvePty(target.sessionId)
      if (!held) return { unavailable: 'no-computer' }
      if (!held.direct) return { unavailable: 'not-direct' }
      return {
        computerId: held.computerId,
        resource: { kind: 'pty', sessionId: target.sessionId },
        work: { kind: 'session', id: target.sessionId }
      }
    }
    const held = await deps.resolveChat(target.tabId)
    if (!held) return { unavailable: 'no-computer' }
    return {
      computerId: held.computerId,
      resource: { kind: 'chat', tabId: target.tabId, epoch: held.epoch },
      work: { kind: 'task', id: held.taskId }
    }
  }

  return {
    async issue(target, caller) {
      const located = await locate(target)
      if ('unavailable' in located) return { available: false, reason: located.unavailable }
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

    heldGrants() {
      prune()
      return [...grants.values()]
    },

    forget(predicate) {
      const dropped: IssuedGrant[] = []
      for (const [id, g] of grants) {
        if (predicate(g)) {
          grants.delete(id)
          dropped.push(g)
        }
      }
      return dropped
    }
  }
}
