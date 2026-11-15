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

Timeline projection records (`kind='timeline'`, derived from the events) are never
decoded to drop a page range: drops are SQL on ids. Compatibility summary and search
APIs use JSON paths without loading whole pages; worker reads stay encoded as above.
A stored projection goes in byte-bounded steps (`dropTimelineStep`,
`TIMELINE_DROP_STEP_BYTES` 4 MiB,
checkpoint first; `dropTimelineInSteps` runs one step per turn of the process's
history work): its pages can be hundreds of MB and `secure_delete` zero-fills every
freed byte — the backfill's reset of 63 chats at once froze the computer 12.7 s.

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
