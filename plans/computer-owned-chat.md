# Computer-owned chat implementation

Approved scope: computer-owned runtime and SQLite for local and remote computers;
hub metadata and transient relay only. General task artifact originals and existing
hub backups remain documented exceptions. Provider transcripts stay provider-managed;
backup restore guarantees readable history, not agent resumability.

Legacy diagnostics without provable ownership remain held on the original hub.

## Worktree

Branch `feat/computer-owned-chat`, based on local main. Preserve unrelated main
edits. Integrate latest main and validate before fast-forwarding it. No remote push.

## Completion — 2026-11-02

Implementation integrated into local main at code checkpoint `3b4bb92af`.
Includes upstream test isolation `927a5b1d9`; existing mobile app configuration
edits preserved byte-for-byte. Timeline projection version 10; computer protocol 5.

Validation:

- 14,173 registered unit cases covered by broad runs and focused reruns, including
  3,707 client cases and 666 mobile Jest cases. Final broad run's isolation-sentinel
  collision was corrected; its suite and a load-sensitive line-split timing test
  both passed focused reruns (37 tests).
- 167 desktop chat cases and 57 computer/native/artifact E2E cases pass across the
  full runs and corrected-fixture reruns. Real Codex CLI test remains opt-in/skipped.
  Final handoff round-trip passes three isolated repeats.
- Disk markers verify history, drafts and uploads remain computer-owned across
  restart. Custom/removed modes, reset cutoffs and shared native IDs survive recovery.
- Full repository typechecks, lint/registration/compiler checks and production
  app/hub/computer/CLI builds pass. Existing compiler skips remain 72.
- Absolute replay, scale, paging and UI budgets pass. Boot: 897 ms. Claude/Codex
  100k opens: 317/251 ms; retained heaps after GC: 50.4/56.8 MB.

The old relative replay baseline reports the same 12 failures on unchanged main
`aeadea021` and this implementation. Across 18 fixtures, median difference versus
main is +0.21%; maximum +17.49%, within its 25% threshold. Baseline left unchanged.

Activation requires matching hub/computer binaries and restarting the app and
computer workers. Migration defers live tasks and retains source content until
verified activation. Old hub backups, original hub task artifacts and unattributed
legacy diagnostics retain their documented exceptions. No release/push performed.

The following checkpoints retain implementation history.

Unresolved questions: none.

## Required implementation

- [x] Independent transport, conversation registry, and queue instances.
- [x] Per-hub SQLite events, records, operation receipts, ownership fencing,
      deletion tombstones, verified staged migration.
- [x] Computer-local data adapter and injectable chat handlers.
- [x] Local save-before-display path and driver-context attachment readers.
- [x] Computer protocol handlers and local process backend.
- [x] Shared invocation validation, durable command receipts, attachment CAS,
      local workspace store, atomic queue handoff and cache writes.
- [x] Hub metadata ownership registry, routing facade, and owner-policy integration.
- [x] Attachment upload/read forwarding, artifact compatibility, and blob GC.
- [x] Prompt hooks/history, workspace diffs, and metadata reconciliation.
- [x] Consistent history/blob backups, export and safe restore.
- [x] Task delete/undo, offline tombstones, retention policy.
- [x] Resumable migration, fenced cutover, cleanup and old-backup reconciliation.
- [x] Desktop/mobile availability and migration-state UI.
- [x] Production bundling, parity/failure/performance validation and local main integration.

## Diagnostics privacy checkpoint (historical)

Chat transport diagnostics persist in the owning computer's per-hub database.
Hub/desktop chat, renderer and crash diagnostics retain metadata only, before
queueing or screenshot offloading. Diagnostic opt-out/verbosity persists per hub
on computers, updates online and reconciles before later commands after reconnect.

Legacy diagnostics use exact task/tab/provider-session evidence. Durable holds
protect pending rows and shared screenshot files from retention before verified
copy/cleanup. Ambiguous ownership remains preserved on the original hub; a
metadata-only diagnostic reports the unassigned count. This is an explicit pending
migration exception, not a completed privacy cleanup for those rows.

Validation: 261 broad tests passed; one old REST fixture expected hub prompt
fallback. Corrected to assert 503 without a connected computer; both affected
suites passed on rerun (17 tests), including successful computer-only hook capture.
Five affected typechecks, both bundles, changed-file lint and suite registration
checks pass. Remaining: computer-owned E2E seed/read ports, packaged desktop/mobile
parity, full privacy-marker audit, long-session budgets, final rebase/review/merge.

Unresolved questions: none.

## Migration invariants

Ownership is per storage conversation, independent of provider IDs. Changing a
computer binding does not relocate history. All mutations carry epochs and stable
operation IDs. Defer active tasks; quiesce every writer before snapshotting.

`pending -> copying -> verified -> activated -> cleaned`

Destination prepares verified data; hub conditionally commits ownership; destination
activates that committed epoch; only acknowledged, verified data can be removed from
hub. Recovery after commit moves forward. Tombstones and ownership must reconcile
before new commands, including after restoring old hub backups. Never guess legacy
ownership, overwrite newer history, or silently fall back to hub persistence.

## Verification

TDD for storage, scope isolation, retries, disk failure, cutover crash points,
reconnect, deletion/undo and backup/restore. Preserve Claude/Codex approvals, threads,
forks, reset, rewind, handoff, queue, drafts, attachments, search and workspace diffs.
Verify no content markers in live hub DB, new backups or logs after cleanup except
the explicit artifact/old-backup exceptions. Run affected tests, typechecks, builds,
desktop/mobile E2E and existing long-session budgets. Re-estimate after packaging.

## Foundation checkpoint (historical)

Hub chat factories replaced by computer relay. Legacy JSONL transfer streams in
256 KiB resumable chunks; verified cutover recovers forward and waits for activation
before deleting source rows. SQLite triggers fence late hub writers and retention.
Drafts, queue, timelines, prompts and workspace diffs persist on computers. Existing
task artifact attachments get sealed copies before draft/send. Computer hooks capture
prompts before acknowledging; only sanitized lifecycle data reaches the hub.
Metadata has durable sequence numbers and replay guards. Session overview and Claude
terminal handoff use computer state. Desktop/mobile send attempt IDs are separate
from message IDs, preserving intentional Retry.

Remaining before release/merge: computer-only new attachment uploads and full artifact
panel/REST/native preview compatibility; consistent history/blob backups and archive
restore; hard-delete tombstones/reconnect barrier, undo/retention and GC; restored-hub
ownership/metadata reconciliation; legacy diagnostic content cleanup; explicit
availability/migration UI; protocol rollout bump; complete parity/E2E/performance
validation; rebase onto latest main and safe merge. Feature branch is not deployable.

Checkpoint validation: 34 chat-runtime tests; 88 hook tests; 35 desktop send/router
tests; 26 mobile session tests (20s test deadline); 1,093 service/owner-policy tests.
Hub/computer bundles build; hub/computer/task-terminals typechecks pass. Mobile
shared-node environment typing corrected; rerun its full typecheck.


## Backup / lifecycle checkpoint

Computer backups now snapshot SQLite plus referenced blobs under a GC lease,
verify hashes, and restore into separate read-only archives. Settings exposes
computer selection, scheduling, archive paging, attachment download and JSON
export. New hub snapshots strip chat content and VACUUM unpublished copies before
publication; old backups stay intact. Task pause/deletion is durable, synced before
chat commands, and retried after reconnect. Deletion GC retries after partial failure.

Restored hubs recover newer committed computer ownership and permanent task
tombstones. Metadata snapshots rebuild settings/session proofs/queue routes after
acknowledged outbox data is missing from an older hub snapshot. Legacy exports
freeze mutable metadata on destination, deduplicate native sessions and attachment
versions, and preserve UTC timestamps.

Validation: 60 storage/migration/relay/service/backup tests; hub, computer,
chat-runtime and settings typechecks pass. Still incomplete: new upload forwarding,
full artifact compatibility, diagnostics/cache cleanup, retention, background
migration, availability UI, E2E reset/coverage and integration with latest main.


## Upload / cleanup checkpoint (before main rebase)

Computer-owned uploads reuse artifact folders, editing and version history.
Hub keeps opaque artifact/folder locators; binary previews and REST reads relay
bytes in memory. General artifact originals stay on hub. Explicit downloads,
exports, clipboard copies and duplicate operations read from the owning store.
Task files have separate storage roots so deleting a chat tab preserves files.
Tab tombstones are durable and delivered before later chat commands.

Legacy direct hook prompts forward to the computer. Diagnostic export freezes
retention while copying, then redacts old hub payloads after verified cutover.
New blank tabs initialize their computer store before publishing ownership;
legacy migration defers active agents. Computer protocol is v5.

This remains an implementation checkpoint, not release-ready. Next: wire idle
migration sweep and final privacy compaction, computer retention, availability UI,
complete restore/deletion edge cases, E2E reset/coverage, performance validation,
and integrate main. Latest broad run had 230/231 passing; missing-file export
regression fixed and focused rerun passed (10 tests). Upload/composer/clipboard
suites passed (34 tests). Computer bundle builds; affected typechecks passed
before latest cleanup edits and need rerun after rebase.


## Main rebase

Rebased onto local main `0a5cccb6e` (2026-11-02). Preserve main's computer
upgrade generation/lifecycle, /btw side questions, late-turn stop fixes and user
model/mode defaults. Chat ownership migration is v187; main owns v184–186.


Rebase checks: 143 targeted storage/protocol/service/transport/handler tests pass;
hub/computer bundles build. Restore /btw calls through each injected transport,
forward user defaults in bootstrap metadata, keep optional args intact across JSON,
and propagate upgrade hook-directory changes into computer-local chat processes.

## Idle migration and privacy cleanup checkpoint

Reconnect now runs project path sync, ownership recovery, lifecycle/deletion fences,
session refresh and idle migration in order, as the authenticated computer owner.
Periodic migration finds pending tabs even when the first tab already migrated;
live PTYs and managed chat sessions defer cutover. Inventory authorization precedes
all lifecycle/tombstone mutations. E2E reset drains maintenance and notifications
before wiping storage.

Diagnostic cutover records a durable event-ID boundary. Fresh lifecycle metadata
stays outside legacy history after restart. Screenshot reads/deletes resolve real
paths inside the diagnostics blob directory. Verified cleanup marks a durable
compaction generation; hub and diagnostic VACUUM/checkpoint passes reclaim old
free pages and retry on failure. Explicitly deleted tasks also clear old diagnostics.

Validation: 66 tests across 19 storage/protocol/migration/artifact/backup/relay
suites pass. Hub build and hub, computer and chat-runtime typechecks pass. Rebase base remains
`0a5cccb6e`. Main worktree untouched. Feature remains unmerged and not release-ready.
Remaining: retention, availability UI, archive/artifact edge cases, lifecycle command
barrier audit, full desktop/mobile E2E and performance validation.

Unresolved questions: none.

## Computer retention checkpoint

Computer SQLite schema v3 persists the hub's existing
`SLAYZONE_HUB_SESSION_RETENTION_DAYS` policy. Default `0` keeps content. Enabled
sweeps run after startup/configuration and daily, with bounded batches and event-loop
yields. Managed chat agents and native PTYs, foreground calls, Trash and unfinished
migrations defer expiry. Policy changes and permanent deletion stop later batches.

Expiry clears old events, prompts, queues, diffs, cached diagnostics and derived
pages; blanks old drafts with increasing revisions; preserves thread structure with
generic titles. Referenced attachments and original task files remain. Sealed orphan
copies follow GC leases. Retry identity/hash survives after cached result text
expires, so delayed requests fail explicitly instead of resending. Unknown receipt
ages receive a full window from upgrade. Manual backups and read-only archives keep
their independent retention rules.

Durable sequence floors survive complete event expiry. Open readers flush old
projections before pruning and rebuild afterward. Activated migration payload files
and duplicate metadata checkpoints are removed while activation proofs and finish
retry behavior remain. Tests cover rollback on disk failure and shutdown during a
failed sweep. Operator behavior documented in `docs/backup-and-restore.md`.

Remaining before merge: availability UI, archive/artifact edge cases, lifecycle
command barrier audit, full desktop/mobile E2E and performance validation.
Rebased again onto main `fbf691341`; preserved main's plan-decision agent scope
and removed duplicate scope/admin/owner-policy entries introduced by replay.

Unresolved questions: none.

Retention validation: 245 targeted tests pass (including 50 native PTY tests), four
affected package typechecks and hub/computer builds pass. Changed-file Biome lint
passes. Worktree dependency lifecycle scripts initialized with Electron rebuilding
skipped; node-pty helper execute bit restored.

Post-rebase: 1,464 targeted tests pass, including owner/admin policy coverage.
Rebased verification: all four affected typechecks, both bundles and changed-file lint pass.

## Availability and reconnect checkpoint

Desktop/mobile show the history-owning computer, offline state, preparation,
migration deferral, pause and deletion. Read-only availability checks never migrate
data or create ownership. Polling pauses for hidden desktop tabs. Reconnect and
explicit Retry reload history without retrying sends. Canonical accepted messages
win over local copies; failed/optimistic messages keep text, attachments and delivery
errors. History failures stay visible. Timeline checkpoint version is 7.

Desktop draft recovery saves restored local journals to the computer, preserves
empty clears and sealed attachment versions, and retries failed saves on reconnect.
Initial empty composers cannot overwrite saved drafts. Mobile reconnect preserves
composer text.

Validation: 1,530 tests passed in the broad availability run; the added history-error
test had a fixture failure, corrected and rerun separately (32 tests). Mobile's 28
session tests, five affected typechecks, hub/computer builds and changed-file lint
pass. Remaining: archive/artifact edges, lifecycle command barriers, draft scope
audit, full E2E/privacy/performance checks, and safe main integration.

Unresolved questions: none.

## Backup completion checkpoint

Restore retries with the same archive ID share one operation; conflicting backup
IDs fail. Restores pin source backups before verification. Manual deletion and
automatic retention respect those pins; shutdown awaits all active restores. The
actual copied database/blobs are verified before durable archive publication.
Malformed descriptors remain visible as errors without hiding other archives.

Archives page original task-file versions alongside saved chat records. Version
downloads and JSON exports read only the archive and enforce conversation ownership;
files remain readable after deleting the live task.

Validation: 1,313 runtime/protocol/relay/router/authorization tests pass, including
eight backup tests. Four affected typechecks, both bundles and changed-file lint
pass. Remaining: artifact edges, lifecycle command barriers, draft isolation audit,
full desktop/mobile E2E/privacy/performance checks, main integration.

Unresolved questions: none.

## Artifact and command-fence checkpoint

Out-of-order folder metadata records parent ownership before later parent updates.
Mixed hub/computer reorder preserves global positions for both files and folders;
folder order updates reach hub locators. Prepared migration attachments must match
saved size/name/type and sniffed bytes before publication. Clipboard state updates
no longer write refs during render.

Normal computer requests await ownership recovery and pending lifecycle/deletion
fences. Reconciliation, discovery and repair/control frames remain available. A
waiting command cannot cross onto a replacement connection. Reconnect invalidates
recovery caches; overlapping forced recovery shares its in-flight operation.

Native PTY spawn/adoption carries task identity independently of pooled session IDs.
Computer checks task state at request time and actual spawn after queue waits. Task
pause/delete cancels queued starts, fences replacements, stops its native processes
and waits for their exits before acknowledging. Other tasks continue. Native work
is visible to retention guards.

Validation: 281 tests across 24 runtime/artifact/gateway/native/PTY suites pass; six
affected typechecks and hub/computer bundles pass. Final lint/compiler checks are
being completed before the next main rebase. Remaining: cross-store folder deletion,
draft journal hub isolation, prompt-history cap parity, full privacy/E2E/performance
validation and safe main integration.

Unresolved questions: none.

## Latest main and client parity checkpoint

Rebased onto main `3888ff8cf`; kept native-session host fixes, chat injection
shortcuts and new sub-agent rows/turn triggers. Combined timeline projection is
version 8. Post-rebase: 579 tests across 30 suites, nine affected typechecks, both
bundles and the React Compiler check pass.

Draft journals now use hub+tab identity. Chat panes remount on scope changes. Legacy
journals without hub provenance are retained for explicit recovery into the selected
chat; recovery keeps current text/files and copies locally before removing the old
entry. Draft saves run in edit order, including returning to an acknowledged draft
while another save is in flight. Error logging does not copy remote draft errors.
Chat prompt recall now shares the existing 500-entry cap with hook capture, without
truncating saved conversation events.

Validation: 102 runtime/retention/draft/composer tests pass. Four affected typechecks,
both bundles, changed-file lint and React Compiler checks pass.

Remaining: durable cross-store folder deletion/mirror cleanup; privacy audit of
orphan diagnostics and hub DB/backups/log markers; computer-owned E2E seeding (the
current helper inserts hub `chat_events` directly); desktop/mobile E2E and long-session
budgets; packaging/full lint/registered suites; final rebase/review and safe main merge.

Unresolved questions: none.

## Folder deletion checkpoint

Hub schema v188 records opaque folder tombstones and per-task/computer delivery
progress. Folder deletion is accepted durably without waiting for offline peers.
Normal command barriers replay bounded cleanup batches before further work; failed
acknowledgements remain pending. Local tombstones fence delayed imports and survive
restart. Cleanup is atomic across task scope checks and may finish while in Trash.
Files keep their contents/version history and move out of deleted folders.

Metadata and artifact lists respect canonical folder placement; stale snapshots
cannot resurrect deleted folders. Computers page their deletion inventory back to
a restored older hub, with task authorization before mutation and strict cursors.
Duplicate artifact delete attempts return their original receipt after the resource
is gone.

Validation: 108 tests across 20 suites pass, plus 16 focused final regressions,
including two-computer offline/reconnect/older-hub restore and native restart/task
isolation cases. Four affected typechecks, both bundles and changed-file lint pass.
Remaining: orphan diagnostic/privacy marker audit; computer-owned E2E seeding and
desktop/mobile E2E; long-session budgets; packaging/full lint/registered suites;
final rebase/review and safe main merge.

Unresolved questions: none.

## Privacy and desktop parity checkpoint

Rich chat diagnostics now stay on the owning computer. Generic hub diagnostics
strip conversation content before queueing or offloading. Legacy diagnostics with
provable ownership migrate with their task; ambiguous rows and referenced
screenshots remain explicitly held on the original hub until attributable.

E2E fixtures seed/read the real computer store through bounded, strictly test-only
ports. A disk scan test verifies saved history, draft and upload markers never
appear anywhere under the hub data root and survive a computer restart. It passes.

The full desktop chat run passed 152 tests, failed 15, and skipped one opt-in real
Codex test. Failures exposed missing attention/state notifications, session ledger
updates, native handoff release acknowledgement, injected workspace readers and
tab-only side-question cancellation. Fixes are covered by units and targeted E2E;
all previously failing cases have passed their focused reruns. Full rerun pending.

Session labels/counts read summaries computed from full computer event history,
independently of the 500-prompt recall cap. Early prompts bind to their native
session on delivery. Manual-reset cutoffs migrate with their original timestamps.
Backup policy publication is durable before the running policy changes; failed
publication leaves the previous policy intact.

Remaining: latest-main rebase, broad registered units/types/lint/build, full chat
rerun, native/computer desktop and mobile checks, performance budgets, final review
and safe local main merge. No push or release.

Unresolved questions: none.
