/**
 * Agent-turn snapshots on this computer (robustness plan §9, P0; hub migration
 * v207). A turn boundary snapshots the checkout into a turn ref
 * (`refs/slayzone/turns/<id>`), is dropped when nothing changed since the previous
 * turn (or, for the first, since HEAD), and the newest {@link MAX_TURNS_PER_WORKTREE}
 * per checkout are kept, each with its ref. The diff panel lists them filtered
 * (`filterTurns`: work already committed or reverted is not shown).
 *
 * The git runs through {@link TurnGit}, which the computer's handler jails to its
 * allowed roots; the rows are only here.
 *
 * @module chat-runtime/server/agent-turns
 */
import { randomUUID } from 'node:crypto'
import {
  turnsRequestSchema,
  type StoredAgentTurn,
  type StoredAgentTurnRange,
  type TurnListResult,
  type TurnRecordResult
} from '../shared/agent-turns'
import type { ChatStorage } from './storage'

/** Keep each checkout's turn history bounded; the oldest beyond go with their refs. */
export const MAX_TURNS_PER_WORKTREE = 50

/** The turn git this computer runs (`@slayzone/agent-turns/turn-git`, jailed). */
export interface TurnGit {
  /** The checkout's canonical path here (realpath, else as given). */
  canonical(repoPath: string): Promise<string>
  /** Snapshot the working tree into the turn's ref; null when it cannot. */
  snapshot(
    repoPath: string,
    turnId: string
  ): Promise<{ snapshotSha: string; headSha: string } | null>
  deleteTurnRef(repoPath: string, turnId: string): Promise<void>
  diffIsEmpty(repoPath: string, from: string, to: string, cached?: boolean): Promise<boolean>
  /** The list's display filter and rethread (`filterAndRethread`). */
  filterTurns(repoPath: string, rows: StoredAgentTurnRange[]): Promise<StoredAgentTurnRange[]>
}

/** The `agent_turns` table of this computer's chat store. */
export function agentTurnsStore(storage: ChatStorage) {
  const db = storage.compose((raw) => raw)
  return {
    insert(t: StoredAgentTurn): void {
      db.prepare(
        `INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        t.id,
        t.worktree_path,
        t.task_id,
        t.terminal_tab_id,
        t.snapshot_sha,
        t.head_sha_at_snap,
        t.prompt_preview,
        t.created_at
      )
    },
    /** Insert unless a turn with this id is already here (a hand-off delivered twice). */
    insertIfAbsent(t: StoredAgentTurn): void {
      db.prepare(
        `INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at)
         VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING`
      ).run(
        t.id,
        t.worktree_path,
        t.task_id,
        t.terminal_tab_id,
        t.snapshot_sha,
        t.head_sha_at_snap,
        t.prompt_preview,
        t.created_at
      )
    },
    get(id: string): StoredAgentTurn | null {
      return (
        (db.prepare('SELECT * FROM agent_turns WHERE id=?').get(id) as
          | StoredAgentTurn
          | undefined) ?? null
      )
    },
    delete(id: string): void {
      db.prepare('DELETE FROM agent_turns WHERE id=?').run(id)
    },
    latest(worktreePath: string): StoredAgentTurn | null {
      return (
        (db
          .prepare(
            'SELECT * FROM agent_turns WHERE worktree_path=? ORDER BY created_at DESC, rowid DESC LIMIT 1'
          )
          .get(worktreePath) as StoredAgentTurn | undefined) ?? null
      )
    },
    /** Every turn of a checkout, oldest first, each with the previous one's snapshot. */
    ranges(worktreePath: string): StoredAgentTurnRange[] {
      const rows = db
        .prepare(
          'SELECT * FROM agent_turns WHERE worktree_path=? ORDER BY created_at ASC, rowid ASC'
        )
        .all(worktreePath) as StoredAgentTurn[]
      return rows.map((row, i) => ({
        ...row,
        prev_snapshot_sha: i === 0 ? null : rows[i - 1].snapshot_sha
      }))
    },
    /** Ids of a checkout's turns, oldest first. */
    ids(worktreePath: string): string[] {
      return (
        db
          .prepare(
            'SELECT id FROM agent_turns WHERE worktree_path=? ORDER BY created_at ASC, rowid ASC'
          )
          .all(worktreePath) as Array<{ id: string }>
      ).map((r) => r.id)
    },
    /** The oldest turns beyond the per-checkout cap. */
    excess(worktreePath: string): string[] {
      const ids = this.ids(worktreePath)
      return ids.length <= MAX_TURNS_PER_WORKTREE
        ? []
        : ids.slice(0, ids.length - MAX_TURNS_PER_WORKTREE)
    },
    /** Forget a deleted task's turns (with its other content, in the purge's transaction). */
    deleteForTask(taskId: string): void {
      db.prepare('DELETE FROM agent_turns WHERE task_id=?').run(taskId)
    },
    /** Ids of turns whose task is deleted on this computer (at most 100). */
    ofDeletedTasks(): string[] {
      return (
        db
          .prepare(
            `SELECT a.id FROM agent_turns a JOIN task_lifecycle l ON l.task_id=a.task_id
              WHERE l.state='deleted' LIMIT 100`
          )
          .all() as Array<{ id: string }>
      ).map((r) => r.id)
    },
    /**
     * Retention: blank the prompt previews of turns older than `cutoff` (ms). The
     * turn stays: its ref still pins a snapshot that only the cap removes, with it.
     */
    redactPreviewsBefore(cutoff: number): number {
      return db
        .prepare(
          "UPDATE agent_turns SET prompt_preview='' WHERE created_at<? AND prompt_preview<>''"
        )
        .run(cutoff).changes
    }
  }
}

/** Reject control bytes and ESC (raw terminal input), allow tab / LF / CR. */
function isCleanPrompt(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if ((c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) || c === 0x7f) return false
  }
  return true
}

export function createAgentTurns(storage: ChatStorage, git: TurnGit) {
  const store = agentTurnsStore(storage)
  // A deleted task's turns go with its other content (its chat records, prompts).
  storage.onTaskPurge((taskId) => store.deleteForTask(taskId))

  async function record(input: {
    taskId: string
    tabId: string
    repoPath: string
    promptPreview: string
  }): Promise<TurnRecordResult> {
    // A deleted task's work is gone here; a paused one still records (it stopped).
    if (storage.taskLifecycle(input.taskId).state === 'deleted') return { recorded: false }
    const worktreePath = await git.canonical(input.repoPath)
    const id = randomUUID()
    const snap = await git.snapshot(worktreePath, id)
    if (!snap) return { recorded: false }
    const prev = store.latest(worktreePath)
    // Compare content, never the commit (its message names the turn id).
    const unchanged = prev
      ? await git.diffIsEmpty(worktreePath, prev.snapshot_sha, snap.snapshotSha, true)
      : await git.diffIsEmpty(worktreePath, `${snap.snapshotSha}^`, snap.snapshotSha)
    if (unchanged) {
      await git.deleteTurnRef(worktreePath, id)
      return { recorded: false }
    }
    const createdAt = Date.now()
    try {
      // Checked again: an erasure may have run while git did.
      if (storage.taskLifecycle(input.taskId).state === 'deleted') throw new Error('Task deleted')
      store.insert({
        id,
        worktree_path: worktreePath,
        task_id: input.taskId,
        terminal_tab_id: input.tabId,
        snapshot_sha: snap.snapshotSha,
        head_sha_at_snap: snap.headSha,
        prompt_preview: isCleanPrompt(input.promptPreview)
          ? input.promptPreview.replace(/\s+/g, ' ').trim().slice(0, 200)
          : '',
        created_at: createdAt
      })
    } catch (error) {
      await git.deleteTurnRef(worktreePath, id)
      if (storage.taskLifecycle(input.taskId).state === 'deleted') return { recorded: false }
      throw error
    }
    for (const stale of store.excess(worktreePath)) {
      store.delete(stale)
      await git.deleteTurnRef(worktreePath, stale)
    }
    return { recorded: true, id, worktreePath, createdAt }
  }

  async function list(repoPath: string): Promise<TurnListResult> {
    const worktreePath = await git.canonical(repoPath)
    const rows = store.ranges(worktreePath)
    return { worktreePath, rows: rows.length ? await git.filterTurns(worktreePath, rows) : [] }
  }

  return {
    store,
    /** One `chat.request` of kind `turns`. */
    async handle(raw: unknown): Promise<TurnRecordResult | TurnListResult | string[]> {
      const request = turnsRequestSchema.parse(raw)
      if (request.op === 'record') {
        if (!request.repoPath)
          throw new Error('turn record needs its checkout (resolved by the computer)')
        return record({ ...request, repoPath: request.repoPath })
      }
      if (request.op === 'list') {
        if (!request.repoPath)
          throw new Error('turn list needs its checkout (resolved by the computer)')
        return list(request.repoPath)
      }
      return store.ofDeletedTasks()
    }
  }
}
export type AgentTurns = ReturnType<typeof createAgentTurns>
