# Computer-owned chat

Computer-local storage for chat content, scoped to the authenticated hub. The hub
retains task and routing metadata; it is not a fallback content store.

Conversations have storage IDs independent of provider session IDs. Every write
checks a durable ownership epoch and state. Frozen sources refuse writes; staged
migrations require a verified manifest and explicit ownership activation. Deleted
conversations retain tombstones so late commands cannot recreate their history.

SQLite stores ordered JSON events, content records, and durable operation receipts.
A receipt means an operation was accepted, not that a provider received it. Provider
transcripts remain provider-managed. Existing hub backups and separately created
hub task artifacts are outside the live-chat storage boundary.

Chat timeline reduction, checkpoint encoding, page decoding and search run on a
lazy worker shared by this runtime's tabs. The computer bundles the worker source
inside its single executable. The existing SQLite owner commits pre-encoded dirty
pages plus checkpoint atomically, with the captured ownership epoch; it does not
scan or decode old pages to drop a range. Reads hand one encoded page at a time to
the worker. SQLite I/O and IPC string copying still run on the computer thread.
There is no second database writer or extra content store. Worker failure falls
back to event replay; a later projection open starts a new worker. Close drains
accepted projection work before releasing its storage callbacks.

Task/provider settings have one computer authority and monotonic revisions;
per-tab caches and historical session replay cannot overwrite newer settings.
Every retained user attachment reference owns a verified pin. Tool payloads are
opaque and never interpreted as attachment references.

Queue admission reserves durable order before asynchronous attachment transfer.
Later messages can be acknowledged behind the pending head; cancellation,
deletion and restart fence late completions. Side-question results are transient;
their receipts prevent duplicate provider calls without retaining answer text.

First creation reserves hub metadata before bootstrap and activates only after
the computer acknowledges durable storage. Missing committed history is isolated
as unavailable; recovery never fabricates empty replacement history.

Legacy hub migration fails closed when timeline records exist without events or
a checkpoint's sequence exceeds the newest stored event. Fixed-count indexed
header probes select no page/checkpoint JSON. Unknown/expired residue (including
a checkpoint with no pages) stays in place; migration does not infer intentional
expiry or restore it into current history. `LEGACY_CHAT_HISTORY_UNREPLAYABLE`
reports the retained source and recovery steps; background migration records a
retryable fault. Fresh, prepared/verified and activation-ACK retries check before
proceeding. Cleanup rechecks the captured owner/epoch/migration and history in the
same write transaction as its deletes; an already-activated owner keeps cleanup
pending when preservation cannot be proved. Event-backed caches remain derived.
These guards do not prove complete partial-event coverage: a high maximum seq
does not establish replayability. Immutable historical recovery and coverage/
retention compatibility remain separate work; no baseline format is introduced.

`chat_legacy_migration_safety` binds a migration token/source epoch to its manifest
hash and captured newest-event header. Unsafe generations remain durably blocked
after event repair; a zero-event destination proof cannot authorize a nonempty
source. Prepared proofs are checked before reuse/commit. Active cleanup requires a
matching saved source-bound receipt; old committed proofs without one defer too.
Cleanup rechecks both receipt and source headers in its delete transaction. These
are empty-proof/generation vetoes, not a claim that nonzero counts prove full
historical equivalence. Repairing source events alone never clears a blocked
generation. Existing unavailable-owner recovery can reseed at a new fenced epoch
and re-export; copying/verified generations without such recovery stay deferred
for managed recovery/support. No ad hoc ownership reset or new baseline format.

Authorized source cleanup stores `cleanup_owner` in that ledger in the **same
immediate transaction** as its deletes, pin release and compaction-generation
update. It binds the exact owner/task/tab/mode, destination, epoch, token and
manifest hash. A pending retry with that marker checks for source/pin reappearance,
then skips those already-committed mutations. Checkpoint, diagnostics at the frozen
cutoff, blob collection and ownership completion can retry idempotently; a failed
post-step does not make the authorized empty source a repaired/stale generation.
Marker-write failure rolls back the entire cleanup. Mismatched/blocked proofs,
deleted tasks and unexpected source data still fail closed. Old ledger layouts
gain the nullable marker column; an absent marker is never inferred from emptiness.

Binary payloads of saved events (tool-result screenshots and files, base64 ≥ 1 KiB)
are stored once in the content-addressed `blobs/` dir; the event keeps a typed
reference in place (`chat-blobs`, terminal-contracts). Each conversation pins the
hashes it references (`event-blob` records, `saved_at` = newest referencing event),
so GC, retention, erasure and backups treat them like attachment pins. Clients read
the bytes lazily through `readBlob` (pin-scoped, 512 KiB chunks). Transfers and
migrations carry the raw inline form, so any version reads them; the destination
stores it out-of-line again. Events rows are insert-only with ONE sanctioned
in-place rewrite: the v13 backfill turns a legacy row (`blob_form = 0`) into its
stored form — representation only, proven by a verified round trip before commit.
It reads row sizes first (record headers) and a row's body once, only
when the row fits what is left of its slice and is long enough to hold a binary
slot (measured on 4,000 real rows: 6,558 body reads → 1,390). The backfill pauses below a free-disk margin (max(1 GiB, 2 × its slice budget)),
closes its chat sessions only through retention's `withQuiesced` lock, and retries
chats it could not finish. Space: a store created with `auto_vacuum` NONE keeps the
pages the backfill frees (and `db.backup` copies them) until the user compacts it once.

Storage compaction (`storage-compaction.ts`), opt-in: a REBUILD (store at auto_vacuum
NONE, after the backfill finished, with ~live-data size free on disk) copies the store
in a worker on a read-only connection (fresh file, incremental auto-vacuum, the live
schema without triggers, tables copied in key order in throttled batches: fsync and
a pause every 16 MiB, so a live commit never queues behind a write burst);
TEMP triggers capture every changed primary key meanwhile; catch-up rounds replay
them in the worker until the rest fits a small budget; one synchronous window replays
the rest, restores the copy's triggers, checks the schema and swaps the file in
(`maintenance.swapIn`; waits for backup leases and secondary connections). From then
on a RECLAIM returns free pages in `incremental_vacuum` slices — started by the user,
or automatically when an incremental store holds ≥ 64 MiB and ≥ 10 % free. Content
erasure (task purge, `eraseTask`) aborts a running rebuild. Kill -9 at any step leaves
the old or the new file; `compact-*` leftovers go at boot.

Derived indexes over events are trigger-maintained, never written by the JS insert
path: `event_markers` holds the rows that name a native conversation or carry a
prompt (`turn-init`, `conversation-branch`, `user-message`), so session summaries
read those rows by key instead of parsing every event of a task. A conversation is
`event_marker_coverage`-covered from birth; one saved before markers is scanned in
full (same answer) until `event-marker-backfill.ts` reaches it — paced slices,
per-conversation checkpoints, chats a summary waits on first. The ledger's
resume / sessions-list SQL is served by `agent_sessions_task_mode_owned` and
`agent_sessions_conversation_task`; keep a probe's `ORDER BY` and comparisons in
the indexes' exact form when editing those rules.

A task move's export (`session-moves.ts` `exportTask`) freezes each chat only long
enough to open a READ SNAPSHOT of it (`storage.openExportReader`: a second, read-only
connection on `chat.sqlite` in a WAL read transaction, plus a blob lease so GC keeps
every image it references), unfreezes it at once — live writes go on — and streams
the snapshot to the transfer file a page at a time (`writeExportTransfer`, one turn of
the process's history work per step, images resolved back inline per event). The
bytes are exactly `encodeTransfer(exportConversation(...))` of that moment (one shared
line encoder). Readers are short-lived (closed in `finally`, and by `store.close()`);
`hasExportReaders()` lists them. Anything that replaces or swaps the `chat.sqlite`
file (compaction) must wait until no export reader is open — an open reader keeps
reading the file it opened.

Export initialization reads only ownership and counts, never record/receipt bodies.
`timeline` and `event-blob` records are excluded in SQL before loading values (also
for the synchronous compatibility export). Retained records and receipts use
keyset pages in their original `(kind,id)` / `id` order: at most 4 MiB stored bytes
or 2,000 rows, with one oversized row always allowed. Each scheduled turn loads
at most one page and writes at most 4 MiB of encoded lines (one whole row always).
Reader construction, failure and close share connection/lease/timer cleanup;
renewal starts only after construction succeeds. Each reader owns a unique lease,
so closing an overlapping export cannot release another snapshot's blob protection.
The task-move caller owns that reader in an outer `finally` covering unfreeze as
well as streaming. A failed frozen-to-active write closes its snapshot/lease/timer;
the original error remains primary if close also reports a failure.

Timeline projection records (`kind='timeline'`, derived from the events) are never
decoded to drop a page range: drops are SQL on ids. `writeTimeline` and discards
share a per-conversation async queue. A replacement whose affected old/new bytes
and records fit one turn remains atomic, including rollback on failure. Larger
replacements delete the checkpoint, then old pages in scheduled 4 MiB steps,
before publishing replacements. Deletion budgets include cached metadata; write
budgets include overwritten bytes. The new
checkpoint is committed only after every preceding slice succeeds. Each step checks
the captured owner/epoch; interruption leaves the events authoritative and the
projection rebuildable. `secure_delete` still zero-fills freed bytes.

`timeline_page_metadata` holds summaries/search text apart from page bodies. New
encoded writes carry these fields from the projection thread; body+metadata commit
atomically. Triggers invalidate metadata on page insert/update/delete, including
older writers. No version bump: existing projection bodies/checkpoints stay valid.
Missing metadata migrates lazily in 4 MiB / 2,000-page scheduled reads; frozen and
prepared sources read the bounded fallback without writing an index. Hot summaries
never parse page bodies; search scans metadata in byte-bounded turns as well. Worker
metadata callbacks retain the same owner fence, and actual page reads stay encoded.

Content erasure never VACUUMs on the main thread. `finishStoredTaskErasure` deletes and
verifies and says whether the file needs a rewrite (removed rows may survive as stale
copies secure_delete misses — e.g. index divider keys — and in old WAL frames); the
live store then runs a forced rebuild (`compaction.rebuildForErasure`: any mode, any
backfill state; concurrent erasures share one rebuild that started after all their
deletions), a restored archive `rebuildStoreFile` (the same throttled worker copy,
renamed over it). The erasure reports done only after that rewrite. The old file is
unlinked, not overwritten: what the guarantee covers is the store's files as read
through the filesystem (an in-place VACUUM on a copy-on-write filesystem also leaves
old blocks to the filesystem). Backups keep erased content by design.

Connection lifecycle: the store owns ONE read-write connection (`openChatConnection`:
WAL, synchronous NORMAL, `wal_autocheckpoint` 0, secure_delete, `journal_size_limit`
64 MiB). NORMAL still syncs a reused WAL header on its writer thread; the current
legacy runtime therefore does not yet meet the no-main-thread-sync goal (R1 H1).
One off-thread checkpointer per process
(`checkpointer.ts`, its own connection per store) fsyncs each store's WAL and runs a
PASSIVE checkpoint every second; `storage.flush()` is the barrier (an off-thread WAL
sync) the computer awaits before answering a request whose data the hub hands over or
records as done (`durableAck`, apps/computer chat-runtime handler) — never for live
output. `shutdown()` marks the store clean and truncates the WAL off-thread. If the
checkpointer dies the store falls back to FULL commits with autocheckpoint on its own
connection; that pragma switch alone does not fence the older NORMAL tail (R1 H2).
The worker-owned replacement below is awaiting complete caller migration.
**Durability window: a process crash loses nothing; an OS crash or power
loss can lose the commits of the last ~1 s that no durable ack covered.** A start
after such an unclean stop on another machine boot rotates the store id, so the hub
re-reads every conversation (another database = rollback) and clients reload: they
converge on what the computer kept, never on duplicated or interleaved sequences. `compose` hands out
a stable handle (`chat-db-handle`) that always reaches the current connection, so
services may keep it; SQL functions and connection pragmas set through it are
re-applied after a swap. Statements and `transaction()` wrappers must not be kept
across a swap (they fail loudly). Any OTHER connection on the live file (a read-only
export reader, the compaction reader) must be registered for its lifetime with
`storage.maintenance.registerSecondary(label)`: the swap (`maintenance.swapIn`) is
refused while one is open; a WAL surviving the close is the backstop. An interrupted
swap is finished at boot (`chat.sqlite.compact-*` removed, `chat.sqlite.pre-compact`
dropped, or restored when it is the only copy).

## Decisions

- 2026-11-02: Dedicated per-hub SQLite schema, WAL and synchronous FULL. No hub
  schema import; local storage failures surface instead of creating hub copies.
- 2026-11-02: Keep existing terminal runtime exports while adding independent
  transport, conversation-registry, and queue instances for computer composition.
- 2026-11-14: History reads are bounded pages (`getEventPage`, `getReplayPage`;
  `readPage` cuts at a byte budget from `octet_length` before loading rows). The
  computer advertises `chatHistoryPages`; the hub relay forwards page reads and
  assembles an older caller's whole read from pages, and asks an older computer
  for the whole read it knows.
- 2026-11-14 (crash fix 4): out-of-line event payloads (schema v13). 97 % of a
  5.6 GB store was inline screenshots riding every history read, relay and transfer
  (one 202 MB whole-history frame closed the hub socket). Reused the attachment blob
  dir instead of a second store: its GC, backup, erasure and transfer wiring apply
  unchanged. Extraction escapes reference-shaped objects in raw tool output, so a
  tool can never forge a reference. v13 also stops older builds opening the store:
  their GC knows only attachment pins and would delete event blobs.
- 2026-11-15 (FU5 computer stalls): event markers as SQLite triggers + a derived
  table, no schema version: every writer — an older build reopening the file included —
  keeps them exact, so downgrade stays possible; a `json_valid` guard means the index
  can never refuse an event write. Backfill done = no uncovered conversation left (no
  done flag to go stale after a backup restore).
- 2026-11-15 (fu-2): swappable connection. Compaction must replace the file without
  restarting the runtime (that would end live chat sessions), and four services keep
  the `compose` handle for their lifetime — so the handle forwards to the current
  connection instead of every caller being rewritten. No schema bump.
- 2026-11-15 (fu-2): compaction = throttled batched copy + captured delta + swap,
  once; then
  incremental auto-vacuum. In-place VACUUM held the write lock 5.2 s on a 4 GB store
  (a write failed); switching a NONE store to incremental needs that rebuild anyway.
  Capture is TEMP triggers (connection-local: nothing persists after a crash or the
  swap) keyed by primary key (VACUUM may renumber rowids); replay is delete + insert
  with the copy's own triggers dropped, so derived rows are copied, never re-derived.
- 2026-11-15 (fu-2, S2b): no `VACUUM INTO`. It is one native call that writes the
  whole store at once; the OS then flushes gigabytes and a live FULL commit waited
  4.7 s behind them (bench). The batched copy bounds our unsynced bytes instead.
- 2026-11-15 (fu-2, S4): erasure without a main-thread VACUUM (seconds frozen on a
  large store, trigger B of the 2026-11-14 crash chain). Same guarantee, proven by a
  test whose stale copy survives a plain delete with secure_delete and is gone after
  the rewrite; the erasure waits for the rewrite. A rebuild needs about the live data
  size free on disk — an in-place VACUUM needed the same in temporary space.
- 2026-11-15 (fu-2, S5; corrected by R1 below): targeted no fsync on the computer's
  main thread in steady state, but NORMAL WAL reuse still syncs on its writer. A
  FULL commit waited 32 s behind a disk backlog (FU4), longer than the hub's 10 s
  heartbeat timeout. NORMAL + off-thread checkpointer + durable acks keep every
  hand-over durable before it is acknowledged; live output is unchanged. Measured with
  a 2 GB-burst writer: commit p99 16-17 ms vs 51-117 ms (FULL), max 124-172 vs
  272-288 ms. Under three steady competing writers both stay under 1 s but NORMAL's
  tail is not better (p99 ~220 vs ~160-200 ms): that cost is the write path itself, not
  the fsync. Exceptions that still fsync on this thread: boot (the store-session mark),
  the compaction swap window (replay commit, directory sync) and `close()` without
  `shutdown()`.

- 2026-11-16 (fu-2 R1, S6a preparation): reuse the platform SQLite worker with
  connection epochs, async final-close hooks and preserved recovery error chains.
  `storage-fence.ts` supplies a real FULL marker commit for an owner worker. It is
  not yet wired into the live runtime: S5's main-thread WAL restart sync and unsafe
  inactive-checkpointer flush remain pending the full S6 caller/event migration.

- 2026-11-16 (fu-2 R1, S6b1): actual storage-owner entry + async host facade, using
  the main-owned shared checkpointer through a private MessagePort. The opt-in owner
  profile opens/migrates/restarts WAL/closes on its worker, executes real FULL fences,
  coalesces only the same issued prefix, and retains file ownership until registered
  helper lifetimes end. Single-bin dispatch selects storage before CLI initialization.
  Legacy runtime/event callers still await migration; generic control-route/scope
  responsiveness and streaming/transaction/blob/fault adapters remain required.

- 2026-11-16 (fu-2 R1, S6b2b1): the async owner includes inherited encoded timeline,
  metadata/marker and legacy-row APIs. Export snapshots stay on that owner behind
  private tokens; only metadata and bounded pages cross threads. Every native export
  reader registers a secondary, including failed construction cleanup. Failed physical
  close retains its registration and retry callback; shutdown drains readers before
  its clean mark. Host fences await the captured pending asynchronous mutations before
  posting the real FULL fence; close releases pauses before draining deferred fences.
  `exited` exposes physical owner exit independently from lease-dependent cleanup.
  Production runtime/composed-store callers still require cutover; these adapters and
  tests do not complete H1/H2 or prove actual computer control responsiveness.


- 2026-11-16 (fu-2 R1, S6b2b2): offline erasure now awaits the canonical async
  maintenance owner. Its already-open writer assembles the same local-data, ledger,
  attachment/artifact, backup/archive, transfer, retention and compaction services;
  no second store or serialized transaction/callback is involved. The private
  compiled erasure command admits its FULL fence before yielding to concurrent
  close. Offline credential/hub/process/worktree checks still precede owner open.
  Only that verified stopped-host profile clears abandoned ephemeral blob leases.
  The CLI passes its bundled entry explicitly; worker dispatch stays isolated.
  Copy helpers are main-owned through a typed private broker, also for archive
  rewrites. Completion/secondary release wait for physical helper exit; writer death
  drains helpers independently of writer shutdown. The broker module loads no native
  SQLite. Online host/runtime handlers and fixture/seeder callers still require
  migration; full H1/H2, actual control responsiveness, S7/S8 and publication-file
  adoption remain open. The approved pure publication helper is not wired here.

- 2026-11-16 (fu-2 integration item 6): `chatStorageCompaction` now comes from the
  implementing host's `ComputerIdentity`; connectors forward it and both enroll
  and hello advertise only an explicit true value (absent/false stay false).
  Retained same-contract busy-host proof preserves historical chat schemas and
  verifies new connectors do not invent this capability. Its bundle fixture
  matches schema indentation and the current summaries refinement explicitly.


- 2026-11-16 (fu-2 R1, S6b2b3): online path controllers now await a fresh store
  scope snapshot before judging filesystem/spawn/chat paths. Stored task roots and
  exclusions are captured in one synchronous native transaction; current host
  placements/settings are merged after the await. Unavailable project task
  authority refuses the request rather than losing exclusions. The same compiled
  read is available on the canonical owner as `chatAuthority.scope` / `readScope`;
  it neither assembles the offline profile nor clears live leases. Online runtime
  assembly still uses the transitional native store adapter: this slice migrates
  production async callers, not the complete online owner.
  Existing-identity ping, proc/pty stop and shutdown controls bypass path-store
  and login-PATH readiness while retaining actor and per-hub process checks.
  Generic dispatch now answers ping with the existing timestamp wire shape;
  network dialer ping/heartbeat handling remains unchanged. Scoped filesystem
  requests await fresh authority and reject read errors. Relocation holds admission
  while awaiting its controller idle check. Delayed-scope multi-hub dispatch tests
  are controller evidence, not blocked-native production latency proof. Full
  runtime/local-data/event/caller cutover, chat cancel, provider/control ACK flow,
  staged publication, S7/S8 and final native/scale acceptance remain pending.


- 2026-11-16 (fu-2 R1, S6b2b4): production computer handler readiness now opens
  `openComputerChatRuntime`. Main retains transport/provider/process/queue controllers,
  scoped filesystem IO, authoritative async readiness, and physical copy/checker
  lifetimes. Its canonical worker composes local data, queue/prompt transactions,
  ledger/turn/task-path/import services, attachments/artifacts, transfers, backups,
  fault ledger, retention/backfills and compaction using the existing transaction
  bodies. No transaction spans an await. Private compiled typed groups carry data;
  no callbacks/native handles cross threads. Custom import test fixtures compile
  their registrations into isolated worker entries. Offline lease purge remains
  exclusive to the verified stopped maintenance profile.
  Mutations and metadata notifications await actual owner FULL fences. History
  publication uses the committed sequence returned by that worker. A failed fence
  latches the online store unavailable and suppresses notifications; cleanup remains
  available. Timeline methods retain captured owner/store identities through
  private data-only adapters. Maintenance holds a main admission/quiescence lease
  through controller drain, native work and restoration, including failures. Task
  spawn permits reserve lifetime before fresh native authority and recheck revocation
  before physical spawn. Lifecycle/deletion/close stop admission and drain accepted
  main callers, queue drainers and projections before releasing native ownership;
  stale lifecycle deliveries retain the active controller. Pending starts cannot
  survive kill/disposal. Hook capture
  ACK/relay and usage cursor ACKs await the worker's durable reply. Main subscriptions
  drain late async watch setup after grant revocation; close preserves failed results.
  POSIX native VFS proofs cover the actual online history pipeline and production
  actor-validated/scoped multi-hub ping/process stop during blocked native xSync,
  failed-fence suppression and zero main native calls. Full heartbeat/chat-cancel
  while provider stdout is held, all-provider/control-ACK bounded-flow proof, shared
  history scheduling/scale, staged publication/inventory/lifetimes, S7/S8 and fresh
  review remain required. This production cutover slice does not complete H1/H2.

- 2026-11-16 (fu-2 R1, S6b2b5): the canonical worker now implements private staged-PATH
  artifact publication through the existing `chatRuntime.call` surface. Main holds
  exact upload leases through positively matched file quiescence or physical owner
  exit; the owner uses the reviewed bounded file helper, existing blob/version and
  working-copy journal semantics, atomic receipt/outbox completion and real FULL
  fences. Preparing/claimed ownership and orphan blob hashes participate in recovery
  and erasure. All artifact mutations share the full async mutation lane. See
  [ARTIFACT_PUBLICATION.md](./ARTIFACT_PUBLICATION.md) for FU1 API/lifetime duties,
  evidence and remaining integration. Public staging/final-invoke adapters, whole
  H2/native/scale/control acceptance, S7/S8 and independent review remain open.
