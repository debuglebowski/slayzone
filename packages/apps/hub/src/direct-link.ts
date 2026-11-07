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
  type DirectRtcOfferParams,
  directRtcAnswerSchema,
  HubToComputerMethods
} from '@slayzone/computer-transport/shared'
import type {
  DirectLinkIssueResult,
  DirectLinkResource,
  DirectLinkTarget,
  DirectLinkTransport,
  DirectRtcConnectResult
} from '@slayzone/computers/shared'
import { normalizeDirectAddress } from '@slayzone/platform/direct-link'
import { isLoopbackAuthority, isLoopbackPeer } from '@slayzone/platform/hub-addr'
import { createFixedWindowLimiter } from '@slayzone/platform/rate-limit'
import { runAsSecurityActor, securityEvent } from '@slayzone/platform/security-log'

/** The slice of the computer gateway the issuer needs. */
export interface DirectLinkGateway {
  listUsableComputers(): ReadonlyArray<{
    computerId: string
    directAddress: string | null
    peerLoopback: boolean
    /** Whether it answers WebRTC offers (absent: no). */
    directRtc?: boolean
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
  /** STUN servers handed to both WebRTC peers (`SLAYZONE_HUB_STUN_ADDRESSES`). */
  stunAddresses?: () => readonly string[]
  /**
   * Subscribe to chat tabs whose conversation left its owner (moved, transitioned,
   * deleted): their grants pin the old epoch, so they are revoked at once rather
   * than left to fail at the next renewal.
   */
  onChatOwnershipChange?: (listener: (tabIds: readonly string[]) => void) => () => void
  /** WebRTC offers per user, and per client address, per minute. Default 30. */
  signalLimitPerMinute?: number
}

/** What the client says it can use (`computers.issueDirectLink` input). */
export interface DirectLinkIssueOptions {
  /** Absent (an older client): WebSocket only. */
  transports?: readonly DirectLinkTransport[]
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
  /** The listener address the client was given (null: WebRTC, no address). */
  address: string | null
  /**
   * Being registered on the computer. Held here from before the request, so a
   * revocation that runs meanwhile matches (and forgets) it; the issue then sees
   * it gone and revokes it on the computer once registered.
   */
  pending?: boolean
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

/** Computers a revocation could not reach (each audited as a failure). */
export interface DirectRevokeOutcome {
  failed: Array<{ computerId: string; error: string }>
}

/** A hub→computer frame the hub sends on its own behalf (see computer-request-authorizer.ts). */
function asHub<T>(fn: () => Promise<T>): Promise<T> {
  return runAsSecurityActor(null, fn)
}

export interface DirectLinkIssuer {
  issue(
    target: DirectLinkTarget,
    caller: DirectLinkCaller,
    options?: DirectLinkIssueOptions
  ): Promise<DirectLinkIssueResult>
  /**
   * Broker a client's WebRTC offer to the computer that holds its grant, as the
   * caller (the gateway's owner check applies), and return the computer's answer.
   * Only for a live grant this hub issued to this caller.
   */
  rtcConnect(
    grantId: string,
    sdp: string,
    caller: DirectLinkCaller
  ): Promise<DirectRtcConnectResult>
  /** Live grant ids this hub issued on a computer (for `direct.reset`). */
  heldGrantIds(computerId: string): string[]
  /**
   * Listener addresses of the live grants this caller holds: the only addresses the
   * desktop's main process lets its renderer's CSP name (`GET
   * /api/computers/direct-addresses`).
   */
  issuedAddresses(userId: string | null): string[]
  /**
   * Drop grants now: forgotten here first, then revoked on each computer holding
   * one, as the hub (never the caller whose request triggered it: an admin revokes on
   * computers the admin does not own). A computer that cannot be told is reported in
   * `failed` and audited as a failure; it is reset to this hub's held set when it
   * reconnects, and a grant never outlives its TTL.
   */
  revoke(which: DirectRevocation, reason: string): Promise<DirectRevokeOutcome>
  /** A computer (re)connected: reset it to exactly the grants this hub still holds. */
  computerConnected(computerId: string): Promise<void>
}

export function createDirectLinkIssuer(deps: DirectLinkIssuerDeps): DirectLinkIssuer {
  const now = deps.now ?? Date.now
  const grants = new Map<string, IssuedGrant>()
  const signalLimiter = createFixedWindowLimiter()
  const signalRule = { max: deps.signalLimitPerMinute ?? 30, windowMs: 60_000 }
  /**
   * Revocations an issue still in flight must see (by sequence number), kept only
   * while one is: an issue checks every revocation since it started, so a grant it
   * is about to make is dropped even when the revocation ran before it was held.
   */
  let revocationSeq = 0
  const recentRevocations: Array<{ seq: number; which: DirectRevocation }> = []
  const issuesInFlight = new Map<symbol, number>()
  function revokedSince(start: number, g: IssuedGrant): boolean {
    return recentRevocations.some((r) => r.seq > start && matches(g, r.which))
  }
  function pruneRevocations(): void {
    if (issuesInFlight.size === 0) {
      recentRevocations.length = 0
      return
    }
    const oldest = Math.min(...issuesInFlight.values())
    while (recentRevocations.length > 0 && (recentRevocations[0]?.seq ?? 0) <= oldest)
      recentRevocations.shift()
  }

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

  const issuer: DirectLinkIssuer = {
    async issue(target, caller, options = {}) {
      // Every revocation from now on is seen by this issue, even one that runs
      // before its grant is held here (while it locates the target or awaits the
      // gates): a chat that moved meanwhile is never granted under its old epoch.
      const inFlight = Symbol('issue')
      const start = revocationSeq
      issuesInFlight.set(inFlight, start)
      try {
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
        // The WebSocket listener when this client can dial it; else WebRTC, brokered
        // here, when both ends speak it; else the relay (the same answers as before).
        // One spelling everywhere (`box:443` is `box`): the desktop gate and CSP
        // compare what is issued here.
        const listener = computer.directAddress
          ? normalizeDirectAddress(computer.directAddress)
          : null
        const wsAddress =
          listener &&
          !(isLoopbackAuthority(listener) && !(computer.peerLoopback && isLoopbackPeer(caller.ip)))
            ? listener
            : null
        const rtc =
          wsAddress === null &&
          computer.directRtc === true &&
          !!options.transports?.includes('webrtc')
        if (wsAddress === null && !rtc) {
          return { available: false, reason: computer.directAddress ? 'unreachable' : 'no-address' }
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
        prune()
        const held: IssuedGrant = {
          grantId: params.grantId,
          computerId: computer.computerId,
          userId: caller.userId,
          taskId: located.taskId,
          resource: params.resource,
          expiresAt: now() + params.ttlMs,
          address: rtc ? null : wsAddress,
          pending: true
        }
        if (revokedSince(start, held)) {
          // Revoked before it was held here: never registered, nothing to undo.
          return { available: false, reason: 'revoked' }
        }
        grants.set(params.grantId, held)
        try {
          await deps.gateway.request(computer.computerId, HubToComputerMethods.directGrant, params)
        } catch (err) {
          grants.delete(params.grantId)
          throw err
        }
        if (grants.get(params.grantId) !== held || revokedSince(start, held)) {
          grants.delete(params.grantId)
          // Revoked while registering: drop it on the computer, which holds it now.
          await asHub(() =>
            deps.gateway.request(computer.computerId, HubToComputerMethods.directRevoke, {
              by: 'grant',
              grantIds: [params.grantId]
            } satisfies DirectRevokeParams)
          ).catch(() => undefined)
          securityEvent({
            event: 'computer.direct_revoke',
            outcome: 'success',
            targetKind: 'computer',
            targetId: computer.computerId,
            detail: { reason: 'revoked_while_issuing', grants: 1 }
          })
          return { available: false, reason: 'revoked' }
        }
        held.pending = false
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
        if (rtc) {
          return {
            available: true,
            transport: 'webrtc',
            computerId: computer.computerId,
            token,
            grantId: params.grantId,
            expiresInMs: params.ttlMs,
            protocol: DIRECT_LINK_PROTOCOL,
            stunAddresses: [...(deps.stunAddresses?.() ?? [])]
          }
        }
        return {
          available: true,
          transport: 'ws',
          computerId: computer.computerId,
          address: wsAddress as string,
          token,
          grantId: params.grantId,
          expiresInMs: params.ttlMs,
          protocol: DIRECT_LINK_PROTOCOL
        }
      } finally {
        issuesInFlight.delete(inFlight)
        pruneRevocations()
      }
    },

    async rtcConnect(grantId, sdp, caller) {
      prune()
      const grant = grants.get(grantId)
      if (!grant || grant.userId !== caller.userId) return { ok: false, reason: 'no-grant' }
      const userKey = `user|${caller.userId ?? ''}`
      const ipKey = `ip|${caller.ip ?? ''}`
      if (
        !signalLimiter.consume(userKey, signalRule).allowed ||
        !signalLimiter.consume(ipKey, signalRule).allowed
      ) {
        securityEvent({
          event: 'computer.direct_rtc_signal',
          outcome: 'denied',
          targetKind: 'computer',
          targetId: grant.computerId,
          detail: { grantId, reason: 'rate_limited', max: signalRule.max, windowSec: 60 }
        })
        return { ok: false, reason: 'rate-limited' }
      }
      const params: DirectRtcOfferParams = {
        grantId,
        sdp,
        stunAddresses: [...(deps.stunAddresses?.() ?? [])],
        clientAddress: caller.ip
      }
      // As the caller: the gateway's owner check applies, as for the grant itself.
      const answer = await deps.gateway
        .request(grant.computerId, HubToComputerMethods.directRtcOffer, params)
        .then(
          (raw) => directRtcAnswerSchema.safeParse(raw),
          () => null
        )
      const ok = answer?.success === true
      // The SDP is never audited: it carries the client's network addresses.
      securityEvent({
        event: 'computer.direct_rtc_signal',
        outcome: ok ? 'success' : 'failure',
        targetKind: 'computer',
        targetId: grant.computerId,
        detail: { grantId }
      })
      return ok ? { ok: true, sdp: answer.data.sdp } : { ok: false, reason: 'refused' }
    },

    issuedAddresses(userId) {
      prune()
      const out = new Set<string>()
      for (const g of grants.values()) {
        if (!g.pending && g.address !== null && g.userId === userId) out.add(g.address)
      }
      return [...out]
    },

    heldGrantIds(computerId) {
      prune()
      return [...grants.values()].filter((g) => g.computerId === computerId).map((g) => g.grantId)
    },

    async revoke(which, reason) {
      revocationSeq++
      if (issuesInFlight.size > 0) recentRevocations.push({ seq: revocationSeq, which })
      prune()
      const byComputer = new Map<string, string[]>()
      for (const [id, g] of grants) {
        if (!matches(g, which)) continue
        grants.delete(id)
        // A pending grant is not on the computer yet: its issue revokes it there.
        if (g.pending) continue
        byComputer.set(g.computerId, [...(byComputer.get(g.computerId) ?? []), id])
      }
      // A revoked computer drops everything this hub ever granted there, including
      // grants this map has already forgotten as expired.
      if (which.by === 'computer' && !byComputer.has(which.computerId)) {
        byComputer.set(which.computerId, [])
      }
      const results = await Promise.all(
        [...byComputer].map(async ([computerId, grantIds]) => {
          const params: DirectRevokeParams =
            which.by === 'computer' ? { by: 'all' } : { by: 'grant', grantIds }
          const error = await asHub(() =>
            deps.gateway.request(computerId, HubToComputerMethods.directRevoke, params)
          ).then(
            () => null,
            (err: unknown) => String(err)
          )
          securityEvent({
            event: 'computer.direct_revoke',
            outcome: error === null ? 'success' : 'failure',
            targetKind: 'computer',
            targetId: computerId,
            detail: { reason, grants: grantIds.length }
          })
          return error === null ? null : { computerId, error }
        })
      )
      return { failed: results.filter((r) => r !== null) }
    },

    async computerConnected(computerId) {
      prune()
      const keep = [...grants.values()]
        .filter((g) => g.computerId === computerId)
        .map((g) => g.grantId)
      // The computer reconnecting is told again next time if this fails; a grant it
      // still holds meanwhile lives out its TTL.
      await asHub(() =>
        deps.gateway.request(computerId, HubToComputerMethods.directReset, { keep })
      )
    }
  }
  deps.onChatOwnershipChange?.((tabIds) => {
    for (const tabId of tabIds) {
      // Failures are audited by revoke; the computer is reset on reconnect.
      void issuer
        .revoke({ by: 'target', target: { kind: 'chat', tabId } }, 'chat_ownership_changed')
        .catch(() => undefined)
    }
  })
  return issuer
}
