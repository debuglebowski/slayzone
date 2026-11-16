/**
 * Hand-off kinds of a task's prompt history and turn snapshots (robustness plan §9,
 * P0; hub migration v207): the hub's `agent_prompts` and `agent_turns` rows,
 * delivered once by `computer-data-handoff`. Idempotent by id; a row already here
 * stays as it is.
 *
 * @module chat-runtime/server/history-imports
 */
import { z } from 'zod'
import { TURN_PREVIEW_MAX } from '../shared/agent-turns'
import { agentTurnsStore } from './agent-turns'
import { storePrompt } from './prompts'
import type { DataImportKind, DataImportKinds } from './task-data'

const id = z.string().min(1).max(500)
const ts = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)

const agentPrompt = z.object({
  id,
  agentId: id,
  cliSessionId: id.nullable(),
  text: z.string().max(1_000_000),
  createdAt: ts
})

const agentTurn = z.object({
  id,
  worktreePath: z.string().min(1).max(10_000),
  /** Null: the turn's task was deleted on the hub (its checkout's history keeps it). */
  taskId: id.nullable(),
  tabId: id,
  snapshotSha: id,
  headShaAtSnap: id.nullable(),
  promptPreview: z.string().max(TURN_PREVIEW_MAX * 4),
  createdAt: ts
})

/** One `agent_prompts` row: a prompt of the task's history. */
export const agentPromptImport: DataImportKind<z.infer<typeof agentPrompt>> = {
  value: agentPrompt,
  apply(storage, item) {
    storePrompt(storage, { ...item.value, taskId: item.taskId }, true)
  }
}

/**
 * One `agent_turns` row. Its preview, when the hub had already blanked it because
 * the legacy chat migration moved it here (`legacy-turn-preview:<id>`), comes back.
 */
export const agentTurnImport: DataImportKind<z.infer<typeof agentTurn>> = {
  value: agentTurn,
  apply(storage, item) {
    const r = item.value
    if (r.taskId !== null && r.taskId !== item.taskId) throw new Error('Turn of another task')
    let preview = r.promptPreview.slice(0, TURN_PREVIEW_MAX)
    if (!preview) {
      const moved = storage.findRecords('settings', item.taskId, {
        id: `legacy-turn-preview:${r.id}`
      })[0]?.value as { promptPreview?: unknown } | undefined
      if (typeof moved?.promptPreview === 'string')
        preview = moved.promptPreview.slice(0, TURN_PREVIEW_MAX)
    }
    agentTurnsStore(storage).insertIfAbsent({
      id: r.id,
      worktree_path: r.worktreePath,
      task_id: r.taskId,
      terminal_tab_id: r.tabId,
      snapshot_sha: r.snapshotSha,
      head_sha_at_snap: r.headShaAtSnap,
      prompt_preview: preview,
      created_at: r.createdAt
    })
  }
}

/** Every history hand-off kind, by the name the hub stages it under. */
export const historyImports: DataImportKinds = {
  'agent-prompt': agentPromptImport,
  'agent-turn': agentTurnImport
}
