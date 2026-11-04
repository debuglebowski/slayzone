/**
 * Direct client ↔ computer link — what a client asks the hub for and what it gets
 * back (`computers.issueDirectLink`). See docs/direct-link.md.
 *
 * Import-free on purpose: this barrel reaches the renderer and mobile.
 */

/** What a client wants to reach directly on the computer that holds it. */
export type DirectLinkTarget = { kind: 'pty'; sessionId: string } | { kind: 'chat'; tabId: string }

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
 */
export type DirectLinkUnavailableReason =
  | 'no-computer'
  | 'no-address'
  | 'unreachable'
  | 'not-direct'
  | 'unsupported'

export type DirectLinkIssueResult =
  | {
      available: true
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
  | { available: false; reason: DirectLinkUnavailableReason }
