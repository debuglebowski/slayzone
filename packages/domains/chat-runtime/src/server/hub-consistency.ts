import type { SlayzoneDb } from '@slayzone/platform'
import { TASK_COMPUTER_EXPR } from '@slayzone/computers/server'
import {
  LEGACY_CHAT_TABLES,
  LEGACY_CHAT_TABLES_DROPPED_SETTING
} from '@slayzone/platform/legacy-chat-tables'
import type { ChatComputerRequest } from './migration'
import type { ChatMetadataSnapshot } from './local-data'
import { COMPUTER_OWNED_CHAT_KEYS } from '../shared'
import { isStorageOnlyChatOwner } from './storage-mode'

/**
 * Rules the hub's chat bookkeeping must satisfy after every pass. A violation is
 * drift the passes failed to prevent or repair: a user meets it later as a tab
 * that will not open, an agent that will not start, or a file in the wrong task.
 *
 * The hub checks its own rules after each recovery pass and logs violations,
 * so drift in real installs shows in the logs instead of as a broken tab. Tests
 * assert there are none after every simulated restart.
 */
export interface ChatConsistencyViolation {
  rule: string
  /** The conversations, files or tasks involved (at most a few). */
  ids: string[]
  detail: string
}

const HUB_RULES: Array<{ rule: string; detail: string; sql: string }> = [
  // ── §9 Phase 8: the legacy chat tables (dropped at boot once every chat migrated) ──
  {
    rule: 'legacy-chat-tables-back-after-drop',
    detail:
      'This install dropped its legacy chat tables, yet they exist again with no chat left to migrate: the boot step that drops them did not run or failed',
    sql: `SELECT m.name AS id FROM sqlite_master m WHERE m.type='table' AND m.name IN (${LEGACY_CHAT_TABLES.map(
      (t) => `'${t}'`
    ).join(',')})
      AND EXISTS(SELECT 1 FROM settings WHERE key='${LEGACY_CHAT_TABLES_DROPPED_SETTING}')
      AND NOT EXISTS(SELECT 1 FROM chat_ownership WHERE state IN ('legacy','copying','verified')
        OR (state='active' AND cleanup_pending=1))`
  },
  // ── P3: per-item faults (item_faults, migration v203) ──
  {
    rule: 'fault-for-erased-task',
    detail: 'A Needs-attention fault still names a permanently erased task',
    sql: `SELECT f.pass||':'||f.item_key AS id FROM item_faults f
      JOIN content_erasure_tasks e ON e.task_id=f.task_id`
  },
  {
    rule: 'computer-fault-for-unknown-computer',
    detail:
      'A mirrored computer fault names a computer the hub does not know: it can never be retried',
    sql: `SELECT f.pass||':'||f.item_key AS id FROM item_faults f WHERE f.origin='computer'
      AND NOT EXISTS(SELECT 1 FROM computers c WHERE c.id=f.computer_id)`
  },
  {
    rule: 'structural-fault-never-retried',
    detail:
      'A quarantined hub fault has neither a fingerprint nor a backoff: no change can ever lift it',
    sql: `SELECT pass||':'||item_key AS id FROM item_faults WHERE origin='hub'
      AND kind='structural' AND fingerprint IS NULL AND next_retry_at IS NULL`
  },
  {
    rule: 'deleted-chat-pending-forever',
    detail:
      'A deleted chat is marked pending although every computer acknowledged its removal: its task cannot start agents',
    sql: `SELECT o.id FROM chat_ownership o WHERE o.state='deleted' AND o.cleanup_pending=1
      AND NOT EXISTS(SELECT 1 FROM chat_deletion_targets d WHERE d.conversation_id=o.id AND d.acknowledged=0)`
  },
  {
    rule: 'file-location-task-mismatch',
    detail: "A computer-held file's task differs from the task of the conversation holding it",
    sql: `SELECT a.id FROM chat_artifact_locations l JOIN task_artifacts a ON a.id=l.artifact_id
      JOIN chat_ownership o ON o.id=l.conversation_id WHERE a.task_id<>o.task_id`
  },
  {
    rule: 'folder-location-task-mismatch',
    detail: "A computer-held folder's task differs from the task of the conversation holding it",
    sql: `SELECT f.id FROM chat_folder_locations l JOIN artifact_folders f ON f.id=l.folder_id
      JOIN chat_ownership o ON o.id=l.conversation_id WHERE f.task_id<>o.task_id`
  },
  {
    rule: 'file-location-owner-not-active',
    detail: 'A computer-held file is located in a conversation that is not active',
    sql: `SELECT l.artifact_id AS id FROM chat_artifact_locations l
      JOIN chat_ownership o ON o.id=l.conversation_id WHERE o.state<>'active'`
  },
  {
    rule: 'tab-binding-task-mismatch',
    detail: 'A chat tab is bound to a conversation of another task',
    sql: `SELECT b.conversation_id AS id FROM chat_tab_bindings b JOIN terminal_tabs t ON t.id=b.tab_id
      JOIN chat_ownership o ON o.id=b.conversation_id WHERE o.task_id<>t.task_id`
  },
  {
    rule: 'active-chat-without-computer',
    detail: 'An active conversation names no computer: its chat cannot open',
    sql: "SELECT id FROM chat_ownership WHERE state='active' AND computer_id IS NULL"
  },
  {
    rule: 'retired-computer-pending-work',
    detail:
      'Work is still addressed to a computer that was re-enrolled or removed: it can never be delivered there',
    sql: `SELECT d.conversation_id AS id FROM chat_deletion_targets d JOIN computer_retirements r ON r.computer_id=d.computer_id WHERE d.acknowledged=0
      UNION SELECT b.conversation_id FROM chat_bootstrap_reservations b JOIN computer_retirements r ON r.computer_id=b.computer_id
      UNION SELECT t.id FROM chat_provider_transitions t JOIN computer_retirements r ON r.computer_id=t.computer_id WHERE t.state='reserved'
      UNION SELECT c.task_id FROM chat_task_computers c JOIN computer_retirements r ON r.computer_id=c.computer_id`
  },
  {
    rule: 'reenrolled-computer-still-named',
    detail: 'A chat still names a computer id that was re-enrolled under a new id',
    sql: `SELECT o.id FROM chat_ownership o JOIN computer_retirements r
      ON r.computer_id IN (o.computer_id,o.source_computer_id,o.destination_computer_id) WHERE r.successor_id IS NOT NULL`
  },
  {
    rule: 'removed-computer-chat-not-unavailable',
    detail: 'A chat on a removed computer does not say so: it looks openable but can never open',
    sql: `SELECT o.id FROM chat_ownership o JOIN computer_retirements r ON r.computer_id=o.computer_id
      WHERE r.successor_id IS NULL AND o.state='active' AND NOT EXISTS(
        SELECT 1 FROM chat_unavailable_owners u WHERE u.conversation_id=o.id AND u.computer_id=o.computer_id AND u.epoch=o.epoch)`
  },
  {
    rule: 'provider-transition-reserved-stale',
    detail:
      'A reserved provider switch can never run (its chat moved past it): it blocks every later switch of its tab',
    sql: `SELECT t.id FROM chat_provider_transitions t JOIN chat_ownership o ON o.id=t.conversation_id
      WHERE t.state='reserved' AND (o.state='deleted' OR o.computer_id IS NOT t.computer_id OR o.epoch>t.epoch)
      AND NOT (o.state='active' AND o.tab_id=t.archive_tab_id AND o.epoch=t.epoch+1)`
  },
  {
    rule: 'folder-placeholder-without-wait',
    detail: 'A placeholder folder waits on no chat: it would show "awaiting computer" forever',
    sql: `SELECT p.folder_id AS id FROM chat_folder_placeholders p WHERE NOT EXISTS(
      SELECT 1 FROM chat_folder_placeholder_waits w WHERE w.folder_id=p.folder_id)`
  },
  {
    rule: 'lifecycle-ack-ahead',
    detail: "A computer acknowledged a newer task state than the hub's",
    sql: `SELECT a.task_id AS id FROM chat_lifecycle_acks a JOIN chat_task_lifecycle l ON l.task_id=a.task_id
      WHERE a.revision>l.revision`
  },
  {
    rule: 'metadata-receipt-ahead-of-cursor',
    detail:
      'An applied, unconfirmed metadata update lies beyond its conversation cursor: a redelivery would be misread',
    sql: `SELECT r.conversation_id AS id FROM chat_metadata_receipts r JOIN chat_metadata_progress p
      ON p.conversation_id=r.conversation_id WHERE r.acked=0 AND r.sequence>p.sequence`
  },
  // ── P0 / decision 2: chat settings live only on the chat's computer (v205) ──
  {
    rule: 'hub-chat-settings-for-owned-chat',
    detail:
      "The hub still holds chat settings or a chat session id of a chat its computer owns: a second copy that can drift from the computer's",
    sql: `SELECT DISTINCT o.task_id||':'||o.mode AS id FROM chat_ownership o JOIN tasks t ON t.id=o.task_id
      WHERE o.state='active' AND o.computer_id IS NOT NULL
        AND o.tab_id NOT LIKE 'artifact-store:%' AND o.tab_id<>'task-content:'||o.task_id
        AND json_valid(t.provider_config) AND (${COMPUTER_OWNED_CHAT_KEYS.map(
          (key) => `json_type(t.provider_config,'$.'||json_quote(o.mode)||'.${key}') IS NOT NULL`
        ).join(' OR ')})`
  },
  // ── P0: computer-only data still waiting on the hub (computer_data_handoff, v204) ──
  {
    rule: 'handoff-for-erased-task',
    detail: 'Computer-only data of a permanently erased task is still held by the hub',
    sql: `SELECT h.kind||':'||h.item_key AS id FROM computer_data_handoff h
      JOIN content_erasure_tasks e ON e.task_id=h.task_id`
  },
  {
    rule: 'handoff-for-missing-task',
    detail:
      'Computer-only data of a task that no longer exists is still held by the hub: it can never be delivered',
    sql: `SELECT h.kind||':'||h.item_key AS id FROM computer_data_handoff h
      WHERE NOT EXISTS(SELECT 1 FROM tasks t WHERE t.id=h.task_id)
        AND NOT EXISTS(SELECT 1 FROM content_erasure_tasks e WHERE e.task_id=h.task_id)`
  },
  {
    rule: 'handoff-target-retired',
    detail:
      'Computer-only data waits for a computer that was re-enrolled under a new id the task was never repointed to',
    sql: `SELECT DISTINCT h.task_id AS id FROM computer_data_handoff h
      JOIN tasks t ON t.id=h.task_id LEFT JOIN projects p ON p.id=t.project_id
      JOIN computer_retirements r ON r.computer_id=COALESCE(
        (SELECT o.computer_id FROM chat_ownership o WHERE o.task_id=h.task_id AND o.state='active'
          AND o.computer_id IS NOT NULL ORDER BY o.epoch DESC LIMIT 1),
        ${TASK_COMPUTER_EXPR})
      WHERE r.successor_id IS NOT NULL`
  },
  // ── P0 (7e, v211): a task's folders live only on the computer holding them ──
  {
    rule: 'hub-task-path-column-present',
    detail:
      "The hub's task table holds a worktree path or base dir column again: a second copy of the computer's folders",
    sql: `SELECT name AS id FROM pragma_table_info('tasks') WHERE name IN ('worktree_path','base_dir')`
  },
  {
    rule: 'task-folder-without-holder',
    detail:
      'A task has a worktree or base dir but no computer holds it and nothing is on its way: its folder can be read nowhere',
    sql: `SELECT t.id FROM tasks t WHERE (t.has_worktree=1 OR t.has_base_dir=1)
      AND t.worktree_computer_id IS NULL AND t.archived_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM computer_data_handoff h WHERE h.kind='task-path' AND h.task_id=t.id)
      AND NOT EXISTS(SELECT 1 FROM content_erasure_tasks e WHERE e.task_id=t.id)`
  },
  // Terminal agent sessions are scoped per tab (v201; main tab id = task id).
  {
    rule: 'hub-session-id-held',
    detail:
      'A task row holds a terminal session id: the session ledger is only on the computer running the agents (robustness plan §9)',
    sql: `SELECT t.id FROM tasks t, json_each(CASE WHEN json_valid(t.provider_config) THEN t.provider_config ELSE '{}' END) m
      WHERE json_type(m.value)='object'
        AND (json_type(m.value,'$.conversationId') IS NOT NULL OR json_type(m.value,'$.conversationHistory') IS NOT NULL)`
  },
  {
    rule: 'session-intent-ack-orphaned',
    detail: 'A computer is recorded as holding a session reset/deletion the hub does not have',
    sql: `SELECT a.intent_id AS id FROM session_intent_acks a
      WHERE NOT EXISTS(SELECT 1 FROM session_resets r WHERE r.id=a.intent_id)
        AND NOT EXISTS(SELECT 1 FROM session_deletions d WHERE d.id=a.intent_id)`
  },
  {
    rule: 'reset-tab-task-mismatch',
    detail: "A session reset names another task's tab: it resets nothing it should",
    sql: `SELECT r.id FROM session_resets r JOIN terminal_tabs t ON t.id=r.tab_id WHERE t.task_id<>r.task_id`
  }
]

/** The hub's own rules (SQL only, cheap): run after every recovery pass. */
export async function checkHubChatConsistency(db: SlayzoneDb): Promise<ChatConsistencyViolation[]> {
  const violations: ChatConsistencyViolation[] = []
  for (const r of HUB_RULES) {
    const rows = await db.all<{ id: string }>(`${r.sql} LIMIT 5`)
    if (rows.length) violations.push({ rule: r.rule, ids: rows.map((x) => x.id), detail: r.detail })
  }
  return violations
}

/**
 * The hub and one computer agree (plan §5: no stamp is trusted as proof):
 * - each file and folder the computer reports for a conversation exists on the
 *   hub under that conversation's task and is located in that conversation;
 * - each entry the hub locates in a conversation is held by the computer, or
 *   marked "unavailable on computer" (`computer-file-missing`);
 * - the hub's metadata cursor is not ahead of the computer's counter and counts
 *   in the computer's chat database (`metadata-cursor-ahead`);
 * - the hub routes the tab each chat is held under to that chat, so its queued
 *   messages (reached through their tab, v208) are reachable (`queue-tab-unrouted`);
 * - every task state the hub counts as acknowledged is the computer's, and the
 *   computer holds no revision past the hub's (`lifecycle-divergence`);
 * - no turn snapshot of a task deleted on the computer survives there
 *   (`turn-of-deleted-task`);
 * - a task the hub says has a worktree / base dir has it on the computer holding its
 *   folders, and none the hub says has none (`task-path-flag-drift`).
 * Reads one metadata snapshot per active conversation, so it is for tests and
 * diagnostics, not every pass.
 */
export async function checkComputerChatConsistency(
  db: SlayzoneDb,
  request: ChatComputerRequest,
  computerId: string
): Promise<ChatConsistencyViolation[]> {
  const violations: ChatConsistencyViolation[] = []
  const grouped = new Map<string, { ids: string[]; detail: string }>()
  const report = (rule: string, id: string, detail: string) => {
    const v = grouped.get(rule) ?? { ids: [], detail }
    if (v.ids.length < 5) v.ids.push(id)
    grouped.set(rule, v)
  }
  // Every session intent the hub counts as delivered is held there (§9).
  const acked = await db.all<{ intent_id: string }>(
    'SELECT intent_id FROM session_intent_acks WHERE computer_id=?',
    [computerId]
  )
  if (acked.length) {
    const held = new Set(
      (await request(computerId, {
        kind: 'ledger',
        value: { op: 'heldIntents', args: { ids: acked.map((a) => a.intent_id) } }
      })) as string[]
    )
    for (const { intent_id } of acked)
      if (!held.has(intent_id))
        report(
          'session-intent-not-applied',
          intent_id,
          'The hub counts a session reset/deletion as delivered, but the computer does not hold it'
        )
  }
  // A deleted task's turn snapshots go with its erasure here (§9, v207).
  for (const id of (await request(computerId, {
    kind: 'turns',
    value: { op: 'deletedTaskTurns' }
  })) as string[])
    report(
      'turn-of-deleted-task',
      id,
      `A turn snapshot of a task deleted on computer ${computerId} survived its erasure there`
    )
  // The hub keeps only whether a task's worktree / base dir is set (§9, P0, 7e v211):
  // the computer holding its folders must hold exactly those — unless a change is
  // staged for delivery (it is on its way).
  const pathTasks = await db.all<{ id: string; has_worktree: number; has_base_dir: number }>(
    `SELECT t.id, t.has_worktree, t.has_base_dir FROM tasks t
      WHERE t.worktree_computer_id = ?
        AND NOT EXISTS (SELECT 1 FROM computer_data_handoff h WHERE h.kind='task-path' AND h.task_id=t.id)
        AND NOT EXISTS (SELECT 1 FROM content_erasure_tasks e WHERE e.task_id=t.id)`,
    [computerId]
  )
  if (pathTasks.length) {
    const held = new Map(
      (
        (await request(computerId, {
          kind: 'taskPaths',
          value: { op: 'get', taskIds: pathTasks.map((t) => t.id) }
        })) as Array<{ taskId: string; worktreePath: string | null; baseDir: string | null }>
      ).map((r) => [r.taskId, r])
    )
    for (const t of pathTasks) {
      const row = held.get(t.id)
      if (!!row?.worktreePath !== !!t.has_worktree || !!row?.baseDir !== !!t.has_base_dir)
        report(
          'task-path-flag-drift',
          t.id,
          `Whether a task has a worktree / base dir on the hub differs from what computer ${computerId} holds, with nothing staged`
        )
    }
  }
  const owners = await db.all<{ id: string }>(
    `SELECT o.id FROM chat_ownership o WHERE o.computer_id=? AND o.state='active' AND NOT EXISTS(
      SELECT 1 FROM chat_unavailable_owners u WHERE u.conversation_id=o.id AND u.computer_id=o.computer_id AND u.epoch=o.epoch)`,
    [computerId]
  )
  for (const { id } of owners) {
    const snapshot = (await request(computerId, {
      kind: 'metadata.snapshot',
      id
    })) as ChatMetadataSnapshot
    const progress = await db.get<{ sequence: number; store_id: string | null }>(
      'SELECT sequence,store_id FROM chat_metadata_progress WHERE conversation_id=?',
      [id]
    )
    if (
      progress &&
      (progress.sequence > snapshot.counter ||
        (progress.store_id !== null && progress.store_id !== snapshot.storeId))
    )
      report(
        'metadata-cursor-ahead',
        id,
        `The hub's metadata cursor (${progress.sequence} in ${progress.store_id ?? '?'}) is ahead of computer ${computerId}'s counter (${snapshot.counter} in ${snapshot.storeId}): its updates would be dropped`
      )
    const held = { artifact: new Set<string>(), folder: new Set<string>() }
    for (const update of snapshot.updates) {
      if (update.kind !== 'artifact-changed' && update.kind !== 'folder-changed') continue
      const folder = update.kind === 'folder-changed',
        entry = String((update.value as { id: string }).id)
      held[folder ? 'folder' : 'artifact'].add(entry)
      const row = await db.get<{ task_id: string; conversation_id: string | null }>(
        folder
          ? 'SELECT f.task_id,l.conversation_id FROM artifact_folders f LEFT JOIN chat_folder_locations l ON l.folder_id=f.id WHERE f.id=?'
          : 'SELECT a.task_id,l.conversation_id FROM task_artifacts a LEFT JOIN chat_artifact_locations l ON l.artifact_id=a.id WHERE a.id=?',
        [entry]
      )
      const problem = !row
        ? 'missing on the hub'
        : row.task_id !== snapshot.identity.taskId
          ? `in task ${row.task_id} on the hub, ${snapshot.identity.taskId} on the computer`
          : row.conversation_id !== id
            ? `located in ${row.conversation_id ?? 'no conversation'} on the hub, ${id} on the computer`
            : null
      if (problem)
        violations.push({
          rule: folder ? 'computer-folder-drift' : 'computer-file-drift',
          ids: [entry, id],
          detail: `${folder ? 'Folder' : 'File'} held by computer ${computerId} is ${problem}`
        })
    }
    // Artifact-store conversations report no file entries in a snapshot.
    if (!snapshot.identity.tabId.startsWith('artifact-store:'))
      for (const [kind, table, column] of [
        ['artifact', 'chat_artifact_locations', 'artifact_id'],
        ['folder', 'chat_folder_locations', 'folder_id']
      ] as const)
        for (const row of await db.all<{ id: string }>(
          `SELECT ${column} AS id FROM ${table} WHERE conversation_id=? AND unavailable_reason IS NULL`,
          [id]
        ))
          if (!held[kind].has(row.id))
            report(
              'computer-file-missing',
              row.id,
              `An entry the hub locates on computer ${computerId} is not held there and not marked unavailable: opening it fails`
            )
    // A queued message is reached through its tab (v208): the hub must route the
    // tab the computer holds this conversation under to this conversation.
    if (!isStorageOnlyChatOwner(snapshot.identity)) {
      const bound = await db.get<{ conversation_id: string }>(
        'SELECT conversation_id FROM chat_tab_bindings WHERE tab_id=?',
        [snapshot.identity.tabId]
      )
      if (bound?.conversation_id !== id)
        report(
          'queue-tab-unrouted',
          id,
          `Computer ${computerId} holds this chat under tab ${snapshot.identity.tabId}, which the hub routes to ${bound?.conversation_id ?? 'nothing'}: its queued messages are unreachable`
        )
    }
  }
  const lifecycles = (await request(computerId, { kind: 'task.lifecycles' })) as Array<{
    taskId: string
    state: string
    revision: number
  }>
  const onComputer = new Map(lifecycles.map((l) => [l.taskId, l]))
  const hub = await db.all<{
    taskId: string
    state: string
    revision: number
    acked: number | null
  }>(
    `SELECT l.task_id AS taskId,l.state,l.revision,a.revision AS acked FROM chat_task_computers c
      JOIN chat_task_lifecycle l ON l.task_id=c.task_id
      LEFT JOIN chat_lifecycle_acks a ON a.task_id=c.task_id AND a.computer_id=c.computer_id
      WHERE c.computer_id=? ORDER BY l.task_id`,
    [computerId]
  )
  for (const row of hub) {
    const held = onComputer.get(row.taskId) ?? { state: 'active', revision: 0 }
    const acknowledged = row.acked !== null && row.acked >= row.revision
    if (
      held.revision > row.revision ||
      (acknowledged && (held.state !== row.state || held.revision !== row.revision))
    )
      report(
        'lifecycle-divergence',
        row.taskId,
        `Task state on computer ${computerId} (${held.state} @${held.revision}) differs from the hub's (${row.state} @${row.revision}): the hub would not redeliver it`
      )
  }
  for (const [rule, v] of grouped) violations.push({ rule, ids: v.ids, detail: v.detail })
  return violations
}
