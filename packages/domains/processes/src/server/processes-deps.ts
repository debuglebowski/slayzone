import type { TypedEmitter } from '@slayzone/platform/events'
import type { ProcessInfo, ProcessEventMap } from '../shared'

// Processes deps — the long-running child-process manager. Lifecycle ops plus the
// live `processEvents` TypedEmitter the 4 streaming subscriptions wrap. Injected by
// the composition root via setProcessesDeps(); the same emitter also drives the
// legacy `win.webContents.send` IPC (dual-emit, coexistence until slice 5).
export type ProcessesDeps = {
  create: (
    projectId: string | null,
    taskId: string | null,
    label: string,
    command: string,
    cwd: string,
    autoRestart: boolean
  ) => string | Promise<string>
  spawn: (
    projectId: string | null,
    taskId: string | null,
    label: string,
    command: string,
    cwd: string,
    autoRestart: boolean
  ) => string | Promise<string>
  update: (
    processId: string,
    updates: Partial<
      Pick<ProcessInfo, 'label' | 'command' | 'cwd' | 'autoRestart' | 'taskId' | 'projectId'>
    >
  ) => boolean | Promise<boolean>
  stop: (processId: string) => boolean | Promise<boolean>
  kill: (processId: string) => boolean | Promise<boolean>
  restart: (processId: string) => boolean | Promise<boolean>
  listForTask: (taskId: string | null, projectId: string | null) => ProcessInfo[]
  listAll: () => ProcessInfo[]
  killTask: (taskId: string) => void
  events: TypedEmitter<ProcessEventMap>
}

let processesDeps: ProcessesDeps | null = null

export function setProcessesDeps(deps: ProcessesDeps): void {
  processesDeps = deps
}

export function getProcessesDeps(): ProcessesDeps {
  if (!processesDeps)
    throw new Error('processesDeps not initialized — call setProcessesDeps() in main host first')
  return processesDeps
}
