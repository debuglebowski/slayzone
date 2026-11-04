import type { TelemetryEventName, TelemetryEventProps } from './types'

/**
 * Maps IPC channels to telemetry events. When an IPC handler succeeds,
 * the hook checks this map and forwards matching events to the renderer.
 *
 * Props extractors receive (args, result) from the IPC call and return
 * the telemetry payload. Return undefined to skip the event conditionally.
 */
export interface IpcTelemetryEntry<E extends TelemetryEventName = TelemetryEventName> {
  event: E
  props: (args: unknown[], result: unknown) => TelemetryEventProps[E] | undefined
}

// Helper for bare events (no payload)
const bare = <E extends TelemetryEventName>(event: E): IpcTelemetryEntry<E> => ({
  event,
  props: () => ({}) as TelemetryEventProps[E]
})

export const IPC_TELEMETRY_MAP: Record<string, IpcTelemetryEntry> = {
  // Task lifecycle
  'db:tasks:create': {
    event: 'task_created',
    props: (_args, result) => {
      const task = result as Record<string, unknown> | null
      return {
        provider: (task?.agent_id as string) ?? 'terminal',
        from_template: false
      }
    }
  },
  // task_deleted handled inline (client knows was_temporary)
  'db:tasks:archive': {
    event: 'task_archived',
    props: () => ({ bulk: false })
  },
  'db:tasks:archiveMany': {
    event: 'task_archived',
    props: () => ({ bulk: true })
  },
  'db:taskDependencies:addBlocker': bare('task_dependency_added'),

  // Git operations
  'git:commitFiles': {
    event: 'git_operation',
    props: () => ({ op: 'commit' })
  },
  'git:push': {
    event: 'git_operation',
    props: () => ({ op: 'push' })
  },
  'git:pull': {
    event: 'git_operation',
    props: () => ({ op: 'pull' })
  },
  'git:fetch': {
    event: 'git_operation',
    props: () => ({ op: 'fetch' })
  },
  'git:stageAll': bare('stage_all'),
  'git:discardFile': bare('discard_changes'),
  'git:createBranch': bare('branch_created'),
  'git:checkoutBranch': bare('branch_checked_out'),
  'git:createWorktree': {
    event: 'worktree_created',
    props: () => ({ auto_vs_manual: 'manual' as const })
  },
  'git:copyIgnoredFiles': bare('worktree_files_copied'),
  'git:createPr': bare('pr_created'),
  'git:mergePr': bare('pr_merged'),
  'git:addPrComment': bare('pr_commented'),
  'git:continueRebase': {
    event: 'rebase_action',
    props: () => ({ action: 'continue' as const })
  },
  'git:skipRebaseCommit': {
    event: 'rebase_action',
    props: () => ({ action: 'skip' as const })
  },
  'git:abortRebase': {
    event: 'rebase_action',
    props: () => ({ action: 'abort' as const })
  },

  // Terminal
  'pty:clearBuffer': bare('terminal_buffer_cleared'),
  'terminalModes:create': bare('custom_mode_created'),
  'tabs:create': {
    event: 'terminal_group_created',
    props: () => ({ split_vs_new: 'new' as const })
  },
  'tabs:split': {
    event: 'terminal_group_created',
    props: () => ({ split_vs_new: 'split' as const })
  },

  // Project
  'db:projects:create': bare('project_created'),

  // Processes
  'processes:create': bare('process_created'),
  'processes:stop': bare('process_stopped'),
  'processes:remove': bare('process_stopped'),

  // Backup
  'backup:create': bare('backup_created'),
  'backup:restore': bare('backup_restored'),

  // Data
  'exportImport:exportProject': {
    event: 'data_exported',
    props: () => ({ format: 'slay' })
  },
  'exportImport:import': bare('data_imported')
}
