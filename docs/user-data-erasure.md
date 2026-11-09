# Permanent deletion

## Decisions

- **Archive** keeps content and can be reversed. **Delete** permanently erases selected SlayZone content; no Trash or deletion Undo. Upgrade preserves existing Trash in Archive.
- Deleting a task erases **only the selected tasks**. Their unselected subtasks stay, moved to the nearest surviving ancestor (else top level); selecting a parent and its subtask erases both. Project and account erasure erase every task in scope.
- Owners delete their own items. A hub admin with a full session can erase **all content of a disabled user only**, under **Settings → Hubs → selected hub → Users**. This grants no permission to read their content.
- **Disable** revokes access and disconnects that user's computers, keeping content. It has a separate confirmation modal. **Erase all content** requires the selected email and shows counts without previews. The account stays disabled.
- **No new settings:** no grace period, leaver timer, automatic purge or per-user policy. Existing independent backup, diagnostic and opt-in chat retention settings continue. Disabling never schedules deletion.
- Failures and offline computers remain incomplete: **“Data on [computer name] has not been deleted yet.”** Cleanup resumes from durable identifiers on startup/reconnect and manually, and periodically with backoff (30 s, doubling to at most 30 min between automatic attempts per job). A retry repeats only unfinished steps and asks only the computers/tasks that have not confirmed.
- **Database compaction.** Deleted rows leave their bytes in SQLite free pages, unused parts of live pages and WAL frames; `secure_delete` alone does not clear stale cell copies that page splits leave behind. Each erasure is therefore **complete only after a full `VACUUM` and `wal_checkpoint(TRUNCATE)` ran after its deletions**, on the hub database and (for its diagnostics) the diagnostics database. On the hub, item deletion (tasks, projects, artifacts) returns once rows and files are gone; one compaction then runs per burst of deletions (30 s after the last, at most 5 min after the first), and only then does the job report complete. Until then its report is `incomplete` with `compactionPending` and no failure; the UI treats that as deleted. A failed compaction (busy checkpoint, insufficient free disk for the rebuild, roughly the database size) is reported as `DATABASE_HISTORY_NOT_COMPACTED` and retried with backoff. Account erasure compacts before it returns. The diagnostics database is rebuilt only when an erasure removed something from it since its last compaction. A computer rebuilds its chat database for a task's erasure unless an earlier request for the same task already did and nothing was removed since.
- Backups keep their normal retention. Restore handling is a **manual operator procedure**, not automatic replay or backup rewriting.

## Stores and boundaries

| Store | Erased | Kept / limitation |
|---|---|---|
| Main SQLite | Owned projects/tasks, archived items, artifacts/folders/all versions, scoped chats/prompts/queues/drafts, workspace data, activity and automation payloads, non-FK residue | Other owners; shared references are detached before cascades; still-shared session references remain |
| Hub filesystem | Task `artifacts/`, legacy `assets/`, project icons, artifact before/after journals, unreferenced identified blobs and `.gc` links | Shared/durable-consumer blob references and backup pins; unknown legacy ownership is reported |
| Preferences | Erased user's settings, project AI configuration and cached references/titles for deleted items | Others' unrelated layout/preferences and shared hub configuration |
| Diagnostics | Proven task/project/session-owned payloads and screenshot files, including legacy mappings; SQLite free pages/WAL compacted (see **Database compaction**) | Security audit, other owners, unresolved legacy ownership |
| Recorded computers | Scoped chat SQLite, drafts/prompts/receipts, transfers, attachments, originals/all versions/journals, terminal history/buffers and buffered hooks | Other tasks/hub namespaces and retained backup snapshots |
| Already-restored computer archives | Selected task's readable history, originals and versions | Other archived tasks and original retained backups |
| Worktrees | Unshared worktree removed on the computer holding it: recorded, else the task's/project's computer, else the hub's default computer (picked once, then kept); offline computers remain incomplete; a revoked/removed one is reported (`WORKTREE_COMPUTER_GONE`) and needs the operator procedure | Shared worktrees; repository folders, branches and Git object history |
| Account/security | Content erasure does not remove the account | Disabled account, security records, actor/job IDs, counts, times and verification evidence; no content in public reports/audit |

The controlled boundary is the configured hub root and recorded computer stores. Provider-owned native state/services, source repositories, exports/downloads, browser/OS caches, manually copied folders, old v0.35 app-data copies, filesystem snapshots and immutable/offline backups need their owners' separate handling. Completion does not certify those copies or forensic destruction of physical media.

Old deletion may already have destroyed ownership records. Account erasure cannot certify unknown orphan files or held diagnostics. An operator must establish ownership from retained evidence; never guess and erase another user's residue. Keep unresolved limitations visible.

## Erase an account

This document authorizes no production deletion. Verify new installations with disposable data.

1. Select the correct hub/user. Confirm **Disable**, then **Erase all content**, checking email/counts. Owners' ordinary item deletion needs no account disabling.
2. Keep the operation ID; check **Cleanup status**. Resolve failures/computers and retry. Busy checkpoints and running backup leases defer cleanup; item jobs also show as incomplete while their scheduled compaction is pending. Interrupted cleanup retains its retry identifiers after content rows disappear.
3. Save initial and final receipts **outside the hub/computer backup set being restored**. The restoring operator owns this record's availability and durability. Keep it while any affected backup/offline copy can still return.

```sh
slay --hub <hub> hub users disable <email>
slay --hub <hub> hub users erase-content <email>                 # preview only
slay --hub <hub> hub users erase-content <email> --confirm <email>
slay --hub <hub> hub users erasure-status <email> --json
slay --hub <hub> hub users retry-erasure <job-id> --json
slay --hub <hub> hub users erasure-receipt <job-id> --output <external-receipt.json>
```

Incomplete cleanup returns CLI exit status `2`. Reports/receipts contain IDs, counts and status, never content or private file paths. The live job database alone is insufficient: an old snapshot also restores old job records.

## Disabled/offline computer

Revoked credentials cannot reconnect. Do not restore access just for cleanup. An operator with legitimate local filesystem access can export an ID-only request, stop the computer host/processes, clean locally and import its receipt:

```sh
slay --hub <hub> hub users computer-erasure-request <job-id> <computer-id> \
  --computer-hub-url wss://<host>/computers --output <request.json>

# On the stopped computer, SLAYZONE_ROOT must identify its original root:
slayzone-computer --erase-data <request.json> --receipt <computer-receipt.json>

slay --hub <hub> hub users confirm-computer-erasure <computer-receipt.json>
```

`--computer-hub-url` may differ from the computer's configured `hubUrl` only in scheme/host case, a default port or trailing slashes. If the computer last ran a build before this rule and was configured with another spelling, cleanup refuses (deleting nothing) when that journal holds the tasks' agent events; repeat with the exact configured `hubUrl`.

If the request lists worktrees, first establish their paths/ownership locally and verify removal of unshared task worktrees. Preserve repository roots/shared worktrees. Only then add `--worktrees-verified`. An unidentified worktree remains unresolved.

The command checks stored computer identity/hub namespace and verifies scoped managed cleanup, including readable restored archives. The hub checks the issued request, computer/task scope and current deletion revisions. Offline receipts are **operator-attested evidence**, not cryptographic proof of a remote wipe; worktree verification is the local operator's responsibility. UI/audit distinguish this from a connected computer's acknowledgement. Unreachable, lost, removed or revoked devices are never automatically counted as erased.

## Restore procedure and precise guarantee

**Restored content stays inaccessible until the operator reapplies relevant erasures and verifies results.** SlayZone does not enforce this gate automatically. Ignoring the procedure can resurrect content; backup expiry alone does not prevent that.

1. Close user access; stop hub/computers. Restore coherent storage units using [Backup and restore](backup-and-restore.md).
2. Retrieve external erasure receipts covering the snapshot's age. Missing records mean restoration cannot be certified.
3. Start only isolated administration access. Match account **IDs**, not just emails, against receipts. Keep erased accounts disabled even if an old auth snapshot reactivated them.
4. Repeat confirmed whole-account erasure for the same account. It inventories restored rows/files again and resumes historical incomplete jobs. Resolve computer copies and restored readable archives using the local procedure above.
5. For individual item receipts, the authorised owner repeats the **same selected deletion** by its recorded IDs. Do not broaden it to account erasure. Keep affected restored content inaccessible until authority and cleanup are available.
6. Verify completion, residue, all computers and isolation of unrelated users. Save new external receipts, then reopen access.

The restoring operator owns the access gate and external record. Existing immutable backup generations expire normally; they are not instantly edited. Recovery requires an erasure-aware build. An old binary, an unmanaged copy or publication without this procedure bypasses this procedural guarantee.

## Release handoff

SlayZone product branch `feat/user-data-erasure`; inspected upstream base `494521e09` / `0.38.2`; schema migrations **198** (erasure journal and write fences) and **199** (fences reinstalled from `installContentErasureFences`; retained-backup pins stay rebuildable for erased items). A later migration that creates or rebuilds a table with `task_id`/`tab_id` must call `installContentErasureFences`; `v199-content-erasure-fences-migration.test.ts` fails otherwise. Feature is **unreleased** until a product tag includes it. Release compatible hub, computer, desktop/mobile and CLI builds together. Older computers cannot provide the new acknowledgement and remain incomplete.

Deployment owners must pin the eventual product tag/commit and run disposable-account checks separately. A product implementation and its tests do not prove that a particular installation has deployed or live-verified it.
