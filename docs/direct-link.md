# Direct client ↔ computer link

Desktop and mobile clients send terminal and chat **data** straight to the computer
that runs the agent. The hub checks role, owner and placement **once**, when it issues
a short-lived capability, and otherwise stays the control plane (records, ownership,
settings, idle-close, state mirror). The hub relay stays as a permanent fallback.

## Flow

1. The client asks the hub: `computers.directLink.issue({ sessionId } | { tabId })`.
2. The hub runs the same gates as the relayed call (`pty.attach` / chat tab owner
   gate, scope `agent`, placement gate). It mints an opaque 256-bit token and
   registers it on the computer over the computer's authenticated link
   (`direct.grant`). Only after the computer acks does it answer the client with
   `{ address, token, grantId, expiresInMs, protocol }`, or with
   `{ available: false, reason }`.
3. The client opens `/direct/v1` on that address (tRPC over WebSocket). The token
   travels in `connectionParams`, never in a URL. More tokens are added and renewed
   on the open socket with `direct.authorize`.
4. Terminal output, backfill and input, plus chat reads, events and the simple
   epoch-checked commands, flow client ↔ computer. State keeps flowing computer →
   hub over the existing journaled frames.

## Capabilities

- **Opaque and registered, not signed.** The computer keeps only `sha256(token)`
  plus the scope `{ hubId, userId, kind: 'pty', sessionId }` or
  `{ hubId, userId, kind: 'chat', tabId, epoch }`. Audience binding comes for free:
  no other computer knows the hash. No key distribution and no offline verification
  (the same model as the task CLI relay, `computer/src/cli-relay.ts`).
- **Lifetime.** The TTL is 5 minutes, counted on the computer's monotonic clock, so
  there is no clock skew. Clients renew at 50% through the hub, and every renewal
  re-runs the gates.
- **Revocation** (`direct.revoke` by grant, user or resource) is pushed when:
  - a user is disabled;
  - a computer is revoked (the hub also drops its live link);
  - a task is archived or deleted;
  - chat ownership or its epoch changes. The computer also checks the epoch on every
    chat request.
  - the pty exits (the computer revokes on its own).
- **Hub link loss.** Grants already issued live out their TTL but cannot renew. On
  reconnect the hub sends `direct.reset { keep }` with the grants it still holds.
  After a hub restart that list is empty, so every grant drops.
- **Never logged.** Tokens are redacted from request logs. Each issuance writes one
  audit line, `computer.direct_grant_issued` (grant id, computer, resource, TTL), and
  never the token.

## Addresses

The env vars follow the naming rules in `CLAUDE.md`: an authority, never a URL; the
scheme is derived from the host (`hubUrlFromAddr`); TLS is terminated by a front end,
never by the computer.

| Var / config key | Meaning |
|---|---|
| `SLAYZONE_COMPUTER_LISTEN_ADDRESS` | Where the direct listener binds. Default `127.0.0.1:0`. |
| `SLAYZONE_COMPUTER_PUBLIC_ADDRESS` | The authority clients dial. Optional; opt-in for remote computers. |

The computer reports its advertised address in `hello` (protocol v8): the public
address, or else the loopback address it bound. The hub keeps it per live
connection, not in the DB. The local computer's port changes on every restart, so
clients re-issue when the computer reconnects.

**Reachability rule.** The hub offers a loopback address only when both the client's
and the computer's connections to the hub are loopback, i.e. they are on the same
machine. A remote computer is direct only when its operator sets a public address.

## Fallback

The client tries direct when an address is offered. Before any WebSocket it probes
with HTTP `GET /direct/v1/health` and a 3 s deadline. Chromium delays all of a
renderer's sockets after failed WebSocket connects, so direct attempts are paced
separately and a failing direct path never delays the hub socket. The fallback is
today's hub relay, unchanged. A failure is sticky per (hub, computer), with backoff:
first retry after 60 s, doubling up to 10 min, and reset when the computer
reconnects. Switching paths mid-session is gap-free: output is deduped by seq and the
gap is caught up with `getBufferSince` / chat replay.

Old clients never call `issue` and stay on the relay. A new client talking to an old
hub gets `NOT_FOUND` and uses the relay. With zero computers, `issue` answers
`NO_COMPUTER_CONNECTED` and the UX is unchanged. The web shell stays on the relay in
this phase.

## What stays on the hub

- **Terminal:** resize (the hub owns cols/rows and `onResize`), touch (the idle-close
  engagement clock), interrupt, create and kill.
- **Chat:** `send`, queue push/update, rewind/fork, `takeOver`, and drafts with
  attachments (the hub seals attachment bytes).
- **State the hub still receives:**
  - `pty-signal` (state, idle clock, prompts, dev URLs, title);
  - a journaled `pty-input` event for direct input (submit, attention, turn
    tracking, conversation watch — the effects `writePty` applies);
  - chat `state` / `metadata`;
  - a `chat-signal` for prompt changes.

## Computer listener limits

Limits are per client address (an IPv6 address counts as its /64), using
`@slayzone/platform/rate-limit`:

- upgrades per minute;
- open sockets;
- failed authentications per minute;
- grants per socket;
- inbound message size and rate.

Each refusal writes an audit line.
