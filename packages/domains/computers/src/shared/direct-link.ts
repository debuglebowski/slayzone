/**
 * Direct client ↔ computer link — what a client asks the hub for and what it gets
 * back (`computers.issueDirectLink`). See docs/direct-link.md.
 *
 * Import-free on purpose: this barrel reaches the renderer and mobile.
 */

/** One session or one chat tab on the computer that holds it. */
export type DirectLinkResource =
  | { kind: 'pty'; sessionId: string }
  | { kind: 'chat'; tabId: string }

/**
 * What a client wants to reach directly: a computer target like every other
 * computer-routed call (owner-checked by its task, and its computer when named; G2),
 * plus the session or tab inside it. The hub refuses a resource outside it.
 */
export type DirectLinkTarget = DirectLinkResource & { taskId: string; computerId?: string }

/**
 * Why the hub offers no direct link; the client uses the hub relay. None of these is
 * an error — the relay is always a correct path.
 *
 *  - `no-computer`: the session/tab is not (or not yet) held by a connected computer.
 *  - `no-address`: the computer advertises no direct listener.
 *  - `unreachable`: it advertises a loopback listener and the client is on another
 *    machine (or the computer is).
 *  - `not-direct`: the hub, not the computer, holds this session's output.
 *  - `unsupported`: this hub cannot issue direct links.
 *  - `wrong-target`: the session/tab is not in the task (or on the computer) the
 *    target names.
 */
export type DirectLinkUnavailableReason =
  | 'no-computer'
  | 'no-address'
  | 'unreachable'
  | 'not-direct'
  | 'unsupported'
  | 'wrong-target'

/**
 * How the client reaches the computer: its WebSocket listener, or a WebRTC data
 * channel the hub brokers (`computers.directRtcConnect`) when no listener is reachable.
 */
export type DirectLinkTransport = 'ws' | 'webrtc'

/**
 * Largest SDP a client may send. Equal to `@slayzone/computer-transport`'s
 * `DIRECT_RTC_MAX_SDP`, which this barrel cannot import (it reaches the renderer);
 * the hub's direct-link test pins the two together.
 */
export const DIRECT_RTC_MAX_SDP = 64 * 1024

export type DirectLinkIssueResult =
  | {
      available: true
      /** Absent from an older hub: `ws`. */
      transport?: 'ws'
      computerId: string
      /** The computer's direct-listener authority; scheme from the host (`hubUrlFromAddr`). */
      address: string
      /** Bearer capability. Present it in the socket's connection params only. */
      token: string
      /** Safe to log. */
      grantId: string
      expiresInMs: number
      /** Direct-link wire version (`DIRECT_LINK_PROTOCOL`). */
      protocol: number
    }
  | {
      available: true
      transport: 'webrtc'
      computerId: string
      /** Bearer capability. Present it in the data channel's first frame only. */
      token: string
      grantId: string
      expiresInMs: number
      protocol: number
      /** STUN servers for both peers, `host:port` (no `stun:` scheme). */
      stunAddresses: string[]
    }
  | { available: false; reason: DirectLinkUnavailableReason }

/** `computers.directRtcConnect`: the computer's SDP answer, or why there is none. */
export type DirectRtcConnectResult =
  | { ok: true; sdp: string }
  | {
      ok: false
      /**
       * `no-grant`: the caller holds no live grant by that id. `rate-limited`: too many
       * offers. `refused`: the computer did not answer it. All mean "use the relay".
       */
      reason: 'no-grant' | 'rate-limited' | 'refused'
    }
