# Direct client ↔ computer link

Desktop and mobile clients exchange terminal and chat **data** directly with the
computer that runs the agent. The hub checks role, owner and placement **once**, when
it issues a short-lived capability, and otherwise stays the control plane: records,
ownership, settings, idle-close and its state mirror. The hub relay stays as a
permanent fallback.

## Flow

1. **Issue.** The client asks the hub: `computers.issueDirectLink({ target })`, where
   `target` is a computer target like every other computer-routed call (`taskId`,
   optionally `computerId`) plus the resource in it: `{ kind: 'pty', sessionId }` or
   `{ kind: 'chat', tabId }`. Owner-policy checks the task (and computer) as for any
   target (G2), and the hub answers `wrong-target` for a resource outside them.
2. **Gate and register.** The hub runs the gates the relayed call would run:
   - the owner gate on the session or tab (owner-policy);
   - scope `agent`;
   - the placement gate.

   Then it mints an opaque 256-bit token and registers its SHA-256 on the computer
   over the computer's authenticated link (`direct.grant`). Only after the computer
   acks does the hub answer the client with
   `{ available: true, computerId, address, token, grantId, expiresInMs, protocol }`,
   or with `{ available: false, reason }`.
3. **Connect.** The client probes `GET /direct/v1/health` over plain HTTP, then opens
   `/direct/v1` (tRPC over WebSocket). The token travels in `connectionParams`,
   never in a URL. More tokens, for other sessions or tabs and for renewals, are
   added on the same socket with `direct.authorize`. There is one socket per
   computer.
4. **Data.** Terminal and chat data flow client ↔ computer. State keeps flowing
   computer → hub over the existing journaled frames.

## What goes where

| | Direct (client ↔ computer) | Hub (control) |
|---|---|---|
| Terminal | attach, backfill (`getBufferSince`), live output, keystrokes | create, kill, resize, touch, interrupt, submit, state, exit, prompts |
| Chat | history reads (`getReplay`, `openTimeline`, `timelinePages`, `searchTimeline`), the event stream, `respondPermission`, `sendToolResult`, `saveDraft` without attachments, `saveScroll` | hydrate, `send`, queue, rewind / fork, `takeOver`, `interrupt`, `abortAndPop`, drafts with attachments (the hub seals their bytes), exit, availability |

Clients today use direct `respondPermission` and `sendToolResult`; drafts and
scroll stay on their hub calls (see *Follow-ups*).

## Capabilities

- **Opaque and registered, not signed.**
  - The computer keeps only `sha256(token)` and the scope:
    `{ hubKey, userId, kind: 'pty', sessionId }` or
    `{ hubKey, userId, kind: 'chat', tabId, epoch }`.
  - Audience binding is inherent: no other computer knows the hash. The raw token
    never crosses the hub ↔ computer link.
  - There is no key distribution, and nothing to verify offline.
- **Lifetime.** 5 minutes, counted on the computer's monotonic clock, so clock skew
  cannot stretch it. Clients renew at half the lifetime through the hub, and every
  renewal re-runs the gates.
- **Revocation** (`direct.revoke` by grant id, or `all`) is pushed:
  - **Account disabled, or refused by SSO:** every grant of that user.
  - **Task closed** (its agents stopped): the task's grants.
  - **Computer revoked:** everything on it, and the hub drops its live link, which
    revoking previously left working.
  - **Chat ownership moved or deleted:** the computer checks the granted epoch on
    every chat request and ends the event stream once its own epoch for the tab
    differs.
  - **Process exited:** the stream ends. The grant stays valid for the same session
    id until it expires, because a restarted agent reuses the id.
- **Hub link loss.** Grants already issued live out their TTL but cannot renew. On
  every (re)connect the hub sends `direct.reset { keep }` with the grants it still
  holds. After a hub restart that list is empty, so every grant drops.
- **Never logged.** Tokens and their hashes stay out of logs and audit lines. Each
  issue writes `computer.direct_grant`, and each revocation writes
  `computer.direct_revoke` per computer. Flood refusals on the computer are
  audited as `computer.rate_limit`.

## Addresses

The variables follow the env naming rules in `CLAUDE.md`:
- they carry an authority, never a URL;
- the scheme is derived from the host (`hubUrlFromAddr`);
- TLS is terminated by a front end, never by the computer.

| Var / `computer.config.json` key | Meaning |
|---|---|
| `SLAYZONE_COMPUTER_LISTEN_ADDRESS` / `directListenAddress` | Where the listener binds. Default `127.0.0.1:0`. |
| `SLAYZONE_COMPUTER_PUBLIC_ADDRESS` / `directPublicAddress` | The authority clients dial. Opt-in. |

**What the computer advertises** in `enroll` / `hello` (protocol v8):
- the public address, if one is set;
- otherwise the address it bound, if that is loopback;
- otherwise nothing.

The hub keeps it per live connection. The local computer's port changes on every
restart, so a client re-issues whenever its socket closes or the computer
reconnects.

**Reachability rule.** The hub offers a loopback address only when both the client's
and the computer's connections to the hub are loopback, i.e. they all run on one
machine. A remote computer is direct only when its operator sets a public address.

## Fallback and pacing

- **Probe before any socket.** The client tries direct only after the HTTP probe
  succeeds. Chromium delays all of a renderer's WebSockets after failed connects,
  the hub's socket included. So no direct socket is ever opened without a fresh
  successful probe, and the tRPC client's own reconnect loop is gated the same way.
- **Desktop probe in main.** On the desktop the main process runs the probe and
  checks this document's CSP (`app:direct-link-prepare`).
- **Backoff.** A failure backs off per computer: 60 s, doubling up to 10 min, and
  cleared when the computer reconnects.
- **Leases.** A lease is lost when its socket closes, its renewal is refused, or its
  computer reconnects. The holder is back on the hub relay at once and tries again.
- **Older peers.** Old clients never call `issue`. A new client talking to an old
  hub gets `NOT_FOUND` and stops asking. With zero computers, `issue` answers
  `no-computer`.
- **Opt-in per host.** A client enables direct links by installing a probe:
  - the desktop installs `setDirectLinkProbe` → main;
  - mobile installs a plain fetch;
  - the web shell and the Chromium fork install none and stay on the relay.

**Gap-free switching:**
- **Terminals.** Delivery is seq-ordered and gap-aware (`pty-delivery.ts`): a chunk
  past `lastSeq + 1` is held while the gap is read back, and the terminal's own
  attach position counts as delivered.
- **Mobile.** Every subscription start catches up (`TerminalFeed`, chat sync).
- **Desktop chat.** It dedupes by seq and live counter, and reloads the tab when it
  leaves the direct link.

## The hub is out of the data path

- **Terminals.** The hub has a computer stream a session's output only while a hub
  client watches it. The desktop subscribes the hub only for mounted sessions that
  are not on the direct link (`relay-subscription.ts`), and mobile only while not
  linked.
- **Chat.** Computers always send a slim `event-signal` per saved event: seq, kind,
  and the delivery id / state / error. They send the full event only for tabs a hub
  client watches. `chat.onEvent` subscriptions register watches
  (`chat-relay-watch.ts`); an unfiltered subscription, as an older client sends,
  means all.

**State the hub still receives:**
- `pty-signal`: state, idle clock, prompts, dev URLs, title;
- `pty-input`, for direct keystrokes: submit, Esc, conversation watch, i.e. the
  effects `writePty` applies;
- chat `state` / `metadata`;
- `event-signal`, which feeds history progress, prompt lists and `slay chat` waits;
- `chat-direct-write`, after a direct chat command, so the hub drains metadata as
  after a relayed one.

## Renderer CSP

The desktop's `connect-src` gains only the exact `wss://` origins of public computer
addresses a hub issued, from the next document load on. Until then that computer is
relayed. Loopback adds nothing: the local hub's `ws://127.0.0.1:*` already covers the
local computer, and the hub offers loopback only on one machine. No `http(s)` entry
is added, because the probe runs in main.

## Computer listener limits

Limits are per client address (an IPv6 address counts as its /64):

| Limit | Value |
|---|---|
| upgrades | 120 / min |
| open sockets | 64 |
| failed authentications | 20 / min, after which upgrades are refused |
| health probes | 240 / min |
| messages per socket | 2000 / 10 s |
| message size | 1 MiB |
| grants per socket | 256 |
| authentication deadline | 10 s |

Behind a front end every client shares the front end's address, so the front end
applies its own limits.

## Diagnostics

Settings → Diagnostics → **Direct link** lists each computer as either:
- **Direct**, with its address and open leases; or
- **Hub relay**, with why and when it retries.

It also shows how many terminals and chats are on the direct link.

## Follow-ups

- Web shell: install a probe and add its CSP origins.
- Clients: use direct `saveDraft` (text-only) and `saveScroll` (the server already
  serves them).
- `interrupt` / `abortAndPop` direct, once the relay's not-ready bypass path is
  mirrored on the computer.
- A diagnostics e2e for the Direct link card.
