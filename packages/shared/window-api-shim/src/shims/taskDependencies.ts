// cap-shell-10 — taskDependencies shim. Backs window.api.taskDependencies.*
// with JSON-RPC calls into the sidecar's task-dependencies:* handlers.
//
// Public API mirrors Electron (packages/apps/app/src/preload/index.ts):
//   addBlocker(taskId, blockerTaskId)
//   removeBlocker(taskId, blockerTaskId)
//   setBlockers(taskId, blockerTaskIds)
//   getBlockers(taskId)      → Task[]  (currently returns id-only synth shapes)
//   getBlocking(taskId)      → Task[]
//   getAllBlockedTaskIds()   → string[]

import type { Task } from '@slayzone/task/shared'
import { jsonRpcCall } from '../transport/mojo'

const nowIso = (): string => new Date().toISOString()

function synthTaskStub(id: string): Task {
  return {
    id,
    project_id: '',
    parent_id: null,
    title: '',
    description: null,
    description_format: 'markdown',
    assignee: null,
    status: 'todo' as Task['status'],
    priority: 3,
    order: 0,
    due_date: null,
    archived_at: null,
    terminal_mode: 'shell' as Task['terminal_mode'],
    provider_config: {} as Task['provider_config'],
    terminal_shell: null,
    claude_conversation_id: null,
    codex_conversation_id: null,
    cursor_conversation_id: null,
    gemini_conversation_id: null,
    opencode_conversation_id: null,
    claude_flags: '',
    codex_flags: '',
    cursor_flags: '',
    gemini_flags: '',
    opencode_flags: '',
    dangerously_skip_permissions: false,
    panel_visibility: null,
    worktree_path: null,
    worktree_parent_branch: null,
    base_dir: null,
    browser_url: null,
    browser_tabs: null,
    web_panel_urls: null,
    editor_open_files: null,
    merge_state: null,
    merge_context: null,
    ccs_profile: null,
    loop_config: null,
    snoozed_until: null,
    created_at: nowIso(),
    updated_at: nowIso(),
  } as unknown as Task
}

export const taskDependenciesShim = {
  addBlocker: async (taskId: string, blockerTaskId: string): Promise<void> => {
    await jsonRpcCall('task-dependencies:add-blocker', { taskId, blockerTaskId })
  },
  removeBlocker: async (taskId: string, blockerTaskId: string): Promise<void> => {
    await jsonRpcCall('task-dependencies:remove-blocker', { taskId, blockerTaskId })
  },
  setBlockers: async (taskId: string, blockerTaskIds: string[]): Promise<void> => {
    await jsonRpcCall('task-dependencies:set-blockers', { taskId, blockerTaskIds })
  },
  getBlockers: async (taskId: string): Promise<Task[]> => {
    const { ids } = await jsonRpcCall<{ ids: string[] }>(
      'task-dependencies:get-blockers',
      { taskId },
    )
    return (ids ?? []).map(synthTaskStub)
  },
  getBlocking: async (taskId: string): Promise<Task[]> => {
    const { ids } = await jsonRpcCall<{ ids: string[] }>(
      'task-dependencies:get-blocking',
      { taskId },
    )
    return (ids ?? []).map(synthTaskStub)
  },
  getAllBlockedTaskIds: async (): Promise<string[]> => {
    const { ids } = await jsonRpcCall<{ ids: string[] }>(
      'task-dependencies:get-all-blocked-ids',
      {},
    )
    return ids ?? []
  },
}
