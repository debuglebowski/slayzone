# Computer upgrades without losing running work

Status: proposed. Supersedes the current idle-only restart implementation. No deployment yet.

## Outcome

A standalone/cloud computer follows its hub's exact published release, including
after a computer-protocol mismatch. Connector replacement preserves terminals,
jobs, enrollment, allowed roots, output history, hooks, and task CLI access.
Failures remain visible and retry automatically without repeatedly killing work.

Incident: golden-comet stayed running but could not reconnect to slay.normain.com
after its 2026-11-01 hub upgrade: hub protocol v4, computer protocol v3.

## Process ownership

| Process | Owns | Upgrade behavior |
| --- | --- | --- |
| Supervisor | Release discovery, installation, health checks, release pointers, retry/status | Can restart or replace itself without terminating the session host |
| Session host | PTYs, jobs, admission queue, buffers, exit records, session identities, stable hook/CLI listeners and session capabilities | Keeps running across connector/supervisor replacement; its own replacement waits for safe maintenance |
| Hub connector | Enrollment/hello, hub protocol, request forwarding, notification delivery | Replaced with the exact connected hub release; reattaches to the existing host |

The session host must not be disposed when a connector disconnects. Supervisor
and host lifetimes must also be independent of an inherited parent IPC channel.
Explicit service stop/removal retains its existing documented shutdown behavior.

Keep application entrypoints as composition. Extract reusable session ownership
and local contracts into a computer-runtime domain; keep hub wire negotiation in
computer-transport. Migrate existing handlers and tests incrementally.

## Invariants

- Connector replacement never kills a terminal or job, including an idle shell.
- Session-host incarnation supplies the existing computer epoch. Connector PID
  changes must not make hub reconciliation declare surviving sessions dead.
- Enrollment and configuration remain under the same ROOT. Upgrades do not
  overwrite credentials, widen allowed roots, or reset the computer's identity.
- Hook URLs, CLI relay URLs, and session capability tokens remain valid for the
  lifetime of their sessions. Retain existing per-hub isolation and actor logging.
- Bound output/event buffering. Replay terminal/process output using existing
  sequence counters and exit records. Preserve bounded hook events with ordering
  and deduplication; make overflow explicit.
- Abort in-flight CLI/API requests on connection loss; never replay writes whose
  outcome is unknown. Subsequent requests from the same session can reconnect.
- Install failure, candidate crash, rollback, and retry do not terminate work.
- Desktop-managed computers remain app-managed. Preserve existing handlers,
  warm pools, queued starts, background jobs, filesystem watches, and multi-hub use.

## Implementation sequence

### 1. Define local contract and write failing regression tests

Define an authenticated, versioned local IPC contract between host and connector:
capability negotiation, host epoch, hub-scoped request dispatch, subscriptions,
session listing, replay cursors, and connector ownership transfer. Use local
sockets on POSIX and named pipes on Windows with current-user access restrictions.
Keep local credentials/endpoints inside the protected computer state boundary.

Add failing tests for the four review findings and the preservation invariants
before changing implementation. New tests must demonstrate the failure first.

### 2. Separate session ownership from connectivity

Move process/session state out of the replaceable connector. Replace direct
handler dependencies on HubDialer with a transport attachment that can change
without disposing resources. Keep host-owned hook/CLI listeners stable while
their upstream connector changes.

Implement exclusive connector attachment per hub, with explicit handover so two
connectors cannot concurrently dispatch work or duplicate notifications. Reattach
using host epoch, existing session/spawn IDs, buffers, and exit records. Update
hub reconciliation wherever it currently equates connector restart with lost work.

Support a connector per hub so different hub releases can share one host when
their local contracts are compatible. An incompatible requirement produces an
explicit deferred-host-maintenance state, without discarding other hubs' work.

### 3. Make upgrade and rollback transactional

Retain protocol-independent `/health` discovery, exact-version validation, private
staging prefixes, runtime checks, and atomic state updates from the current work.
Add a platform-aware npm launcher; invoke npm's JavaScript entrypoint through an
appropriate Node runtime rather than assuming a Unix executable.

Upgrade flow:

1. Discover hub release independently of the computer connection.
2. Stage and validate candidate package and host-contract compatibility.
3. Pause connector handover, preserving host processes, buffers, and endpoints.
4. Authenticate candidate, attach it to the host, and reconcile existing sessions.
5. Activate candidate; retain the previous known-good release through probation.
6. Commit after health checks and a sustained healthy interval. Starting default:
   60 seconds, with explicit startup/crash-loop thresholds covered by tests.

Track staged, probationary, committed, and previous releases durably. Recover
deterministically if supervisor exits during any transition. An early crash after
hello must trigger rollback, not permanent relaunch of the same bad release.

Retry transient discovery/install/start failures with bounded exponential backoff
and jitter. Quarantine repeatedly failing candidates, then retry after cooldown
or target change. If the previous release cannot speak the upgraded hub protocol,
keep work alive, report disconnected recovery, and continue checking for a usable
release; rollback alone cannot restore that connection.

Keep the session-host contract backward compatible across connector releases.
Stage host and supervisor updates too; the original bootstrap must not remain
responsible for old release-specific behavior forever. Host replacement is
separate maintenance: defer while work exists, show why, and never force-kill
work automatically. A connector requiring an incompatible host is also deferred.

### 4. Upgrade hooks and expose progress

Install hooks/plugins from the selected release before activation, atomically.
Maintain compatibility with already-running agents and preserve stable relay
addresses. Restore previous managed assets on rollback without overwriting user
configuration or losing edits made during installation.

Show current/target connector release, host release, upgrade phase, last failure,
next retry, and deferred-maintenance reason in hub computer details. Keep local
logs/status for service diagnostics. Use a narrow authenticated status channel
that works when normal computer RPC negotiation fails; expose no new unauthenticated
control surface. Preserve opt-out through local config/environment.

### 5. Migration and verification

Existing monolithic agents cannot transfer live node-pty objects into a new
process. Initial migration therefore needs one planned restart after work finishes,
or an explicitly approved interruption. Preserve ROOT, enrollment, roots, service
registration, and supported CLI commands. Subsequent connector upgrades use the
new handover path without VM access.

Verify with real processes and packaged installs:

| Scenario | Required result |
| --- | --- |
| Hub protocol upgrade with idle shell and running job | Connector upgrades; same child PIDs/session IDs survive and reconnect |
| Output and job exit during handover | Replayed output and correct exit status; no duplicate sessions |
| Hooks and task CLI during/after handover | Stable endpoints/tokens; bounded hook recovery; writes never blindly replayed |
| Registry failure, corrupt cache, native/runtime failure | Old runtime/work preserved; visible failure and successful retry |
| Crash before hello, after hello, during probation | Rollback and cooldown; no endless bad-release loop |
| Supervisor restart at each transition | Consistent release pointers; surviving host and work reattached |
| Host contract incompatibility | Explicit deferred maintenance; no forced termination |
| Config/root edits, opt-out, multiple hubs | Existing policy, isolation, and enrollment preserved |
| Windows, Linux, macOS packaged install | Correct npm invocation, IPC, services, shutdown, and reconnection |

Release gate: all scenarios pass, affected typechecks/builds pass, and a disposable
cloud canary survives a hub upgrade plus injected upgrade failures. Then roll out
the initial migration and validate golden-comet. Production deployment is a separate step.

## Unresolved questions

None. Proposed defaults above; no production interruption authorized.
