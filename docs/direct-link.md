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
| Chat | history reads (`getReplay`, `openTimeline`, `timelinePages`, `searchTimeline`), the event stream, `saveDraft` without attachments, `saveScroll` | hydrate, `send`, queue, rewind / fork, `takeOver`, `interrupt`, `abortAndPop`, `respondPermission` and `sendToolResult` (the hub refuses them while the conversation runs in the terminal), drafts with attachments (the hub seals their bytes), exit, availability |

Clients today use only the direct reads and event stream; drafts and scroll stay on
their hub calls (see *Follow-ups*). Permission and tool answers are hub calls by
design: the hub refuses one while the conversation runs in the terminal, and syncs
the chat's bootstrap first, checks the computer cannot make.

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
- **Sent as the hub.** Revocations, resets and chat relay-watch pushes are the hub's
  own frames: they run as the hub (`runAsSecurityActor(null, …)`), so the G2 owner
  check never refuses an admin's revocation on a computer the admin does not own. A
  revocation a computer could not receive is audited as `failure` and logged.
- **One grant per target per socket.** A grant authorized on a socket supersedes
  whatever the socket held on the same session or tab (a renewal, or a chat grant from
  an older epoch, which would otherwise shadow it). When a client's last lease on a
  target ends it calls `direct.release`, so grants never pile up to the socket's cap.
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
machine. A remote computer's listener is offered only when its operator sets a
public address; without one, the client reaches it over WebRTC (below).

## WebRTC (computers without a dialable listener)

**Path choice, made by the hub at issue** (`computers.issueDirectLink`, which takes
the client's `transports`):

1. The computer's WebSocket listener, when this client can dial it (loopback on one
   machine, or the operator's public address).
2. Otherwise WebRTC, when the client says it speaks it (`transports` includes
   `webrtc`) and the computer advertises `directRtc` in `hello` (node-datachannel
   loaded and its listener bound).
3. Otherwise the hub relay, with the same reasons as before. An older client sends no
   `transports` and an older computer no `directRtc`: both keep today's behaviour.

**Signaling.** The answer is `transport: 'webrtc'` with the grant and the STUN servers.
The client creates a peer and the direct protocol's data channel
(`slayzone-direct-v1`), gathers every candidate (at most 2 s), and sends that one
complete offer to `computers.directRtcConnect({ grantId, sdp })`. The hub forwards it
to the grant's computer as `direct.rtcOffer` over the computer's authenticated link
(as the caller: the gateway's owner check applies) and returns the computer's complete
answer. One request per peer connection; no trickle.

**One code path.** The data channel carries exactly what the WebSocket carries: tRPC
messages with the capability in the first one, split into 16 000-character pieces
and rejoined (every SCTP stack caps a message), PING/PONG keepalive. The computer
serves the channel through the same listener code as a WebSocket — the same grants,
flood limits and per-address caps, counted against the client address the hub saw.
One peer connection per computer per client, like one socket.

**Security.**
- The capability is still required: the first frame on the channel presents the
  token, exactly as on the WebSocket. An offer alone opens nothing.
- An offer is answered only for a live grant the hub issued to that caller, and the
  computer answers only for a live grant that hub link registered.
- No man in the middle: the offer and the answer carry each peer's DTLS certificate
  fingerprint and travel only over hub-authenticated links; DTLS refuses any other
  certificate (tested with a forged fingerprint).
- Revocation closes the channel, which closes the peer, as it closes a WebSocket.
- Signaling is rate-limited per user and per client address (30 per minute), and the
  computer caps peers connecting per hub (16) and in total (64), dropping a peer that
  has not connected within 20 s.
- Each brokered offer is audited as `computer.direct_rtc_signal` (grant id, outcome);
  the SDP, which carries network addresses, never is.

**NAT traversal.** STUN only, no TURN: when ICE fails the client backs off and uses the
relay, as for an unreachable listener. The hub hands both peers its STUN servers:

| Var / `hub.config.json` key | Meaning |
|---|---|
| `SLAYZONE_HUB_STUN_ADDRESSES` / `stunAddresses` | Comma-separated `host:port` authorities (a list in the file), never `stun:` URLs. Unset = `stun.cloudflare.com:3478`; empty = none. Malformed refuses boot (B19). |

**Runtimes.**
- Computer: `node-datachannel` (libdatachannel), Node-API prebuilds per platform; loaded
  lazily and optional — a computer where it does not load advertises no `directRtc`.
  A standalone computer (session host + connector) answers offers in its host; the
  host hands the connector its direct identity as values (`directIdentity`), since
  JSON-RPC drops functions.
  Unpacked from the desktop app's asar; optional in the npm computer; checked by the
  packaged-app smoke.
- Desktop: the renderer's `RTCPeerConnection`. A failed WebRTC connect is not a failed
  WebSocket, so it cannot slow the hub's socket.
- Mobile: `react-native-webrtc`, data channels only (no camera or microphone
  permission), loaded on install so a build without it simply asks for no WebRTC.

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

**Dead sockets.** The direct socket pings every 10 s and closes after 5 s without a
pong (a half-open socket brings no FIN), which ends its leases. A direct keystroke or
backfill has a 3 s deadline; one that did not land (grant ended, socket closed, no
answer in time) goes to the hub, and a transport failure drops the lease at once.

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

Main never takes the renderer's word for an address. The renderer names the hub that
issued it (`prepareDirectLink(address, hubId)`); main resolves that hub from its own
registry, asks it (`GET /api/computers/direct-addresses`: the listener addresses of the
caller's live grants), and adds the origin only if the hub names it. An unknown hub, a
refusal, a hub too old for the route, or a bad answer refuses (`not-issued`), so the
terminal stays on the relay. At most 32 issued origins are kept, oldest dropped first.

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
- **Direct**, with its transport — `WebSocket` and its address, or `WebRTC` on the
  local network or through NAT (STUN) — and open leases; or
- **Hub relay**, with why (including `WebRTC could not connect`) and when it retries.

It also shows how many terminals and chats are on the direct link.

## Follow-ups

- Web shell: install a probe and add its CSP origins; it could also install the
  browser's RTCPeerConnection for WebRTC.
- TURN is not provided (by decision): a strict firewall that blocks both direct UDP
  and the STUN-mapped path stays on the hub relay.
- Clients: use direct `saveDraft` (text-only) and `saveScroll` (the server already
  serves them).
- `interrupt` / `abortAndPop` direct, once the relay's not-ready bypass path is
  mirrored on the computer.
- A diagnostics e2e for the Direct link card.
