# Computer-owned chat implementation

Approved scope: computer-owned runtime and SQLite for local and remote computers;
hub metadata and transient relay only. General task artifact originals and existing
hub backups remain documented exceptions. Provider transcripts stay provider-managed;
backup restore guarantees readable history, not agent resumability.

## Worktree

Branch `feat/computer-owned-chat`, based on local main. Preserve unrelated main
edits. Integrate latest main and validate before fast-forwarding it. No remote push.

## Required implementation

- [x] Independent transport, conversation registry, and queue instances.
- [x] Per-hub SQLite events, records, operation receipts, ownership fencing,
      deletion tombstones, verified staged migration.
- [x] Computer-local data adapter and injectable chat handlers.
- [x] Local save-before-display path and driver-context attachment readers.
- [ ] Computer protocol handlers and local process backend.
- [ ] Hub metadata ownership registry, routing facade, and owner-policy integration.
- [ ] Attachment upload/read forwarding, artifact compatibility, and blob GC.
- [ ] Prompt hooks/history, workspace diffs, and metadata reconciliation.
- [ ] Consistent history/blob backups, export and safe restore.
- [ ] Task delete/undo, offline tombstones, retention policy.
- [ ] Resumable migration, fenced cutover, cleanup and old-backup reconciliation.
- [ ] Desktop/mobile availability and migration-state UI.
- [ ] Packaging, full parity/failure/performance validation and main integration.

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
