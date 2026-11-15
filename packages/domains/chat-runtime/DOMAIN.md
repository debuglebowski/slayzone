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
chats it could not finish. Space: `chat.sqlite` has no `auto_vacuum`, so pages the
backfill frees are reused, not returned; backups (`db.backup`, every page, plus every
pinned blob) grow by the extracted blobs until a one-time compaction follow-up lands —
a prerequisite for keeping backup size flat.

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

Connection lifecycle: the store owns ONE read-write connection (`openChatConnection`:
WAL, synchronous FULL, secure_delete, `journal_size_limit` 64 MiB). `compose` hands out
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
