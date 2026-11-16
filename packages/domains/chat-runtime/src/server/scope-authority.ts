/** Stored scope authority. One native transaction; only data crosses its async boundary. */
import type { WirePathScope } from '@slayzone/platform/path-scope'
import type { ChatStorage } from './storage'
import { taskPathsStore, scopeBounds } from './task-paths'
import type { TaskPathRow } from '../shared/task-paths'

export type ChatScopeSnapshot =
  | {
      scope: Extract<WirePathScope, { kind: 'task' }>
      row: TaskPathRow | null
      others: { worktrees: string[]; baseDirs: string[] }
    }
  | { scope: Extract<WirePathScope, { kind: 'project' }>; own: string[]; others: string[] }

/** Compiled owner command, also used by the transitional native store assembly. */
export function readChatScope(storage: ChatStorage, scope: WirePathScope): ChatScopeSnapshot {
  const paths = taskPathsStore(storage)
  return storage.transaction(() =>
    scope.kind === 'task'
      ? { scope, row: paths.get(scope.taskId), others: paths.others(scope.taskId) }
      : { scope, ...paths.ofProject(scope.projectId) }
  )
}

export interface ChatScopeAuthority {
  scope(scope: WirePathScope): Promise<ChatScopeSnapshot>
}
export function createChatScopeAuthority(storage: ChatStorage): ChatScopeAuthority {
  return { scope: async (scope) => readChatScope(storage, scope) }
}

/** Merge a fresh stored snapshot with the host's current project placement/settings. */
export function resolveChatScope(
  snapshot: ChatScopeSnapshot,
  ...args: [
    scope: WirePathScope,
    projectFolder: (id: string) => string | null,
    projectFolders: () => Array<{ projectId: string; path: string }>,
    worktreeBases: (id: string, folder: string) => string[]
  ]
): ReturnType<typeof scopeBounds> {
  const scope = args[0]
  if (
    snapshot.scope.kind !== scope.kind ||
    snapshot.scope.projectId !== scope.projectId ||
    (scope.kind === 'task' &&
      (snapshot.scope.kind !== 'task' || snapshot.scope.taskId !== scope.taskId))
  )
    throw new Error('Stored path scope does not match the request')
  return scopeBounds(
    {
      get: () => {
        if (!('row' in snapshot)) throw new Error('Task scope snapshot required')
        return snapshot.row
      },
      others: () => {
        if (!('row' in snapshot)) throw new Error('Task scope snapshot required')
        return snapshot.others
      },
      ofProject: () => {
        if ('row' in snapshot) throw new Error('Project scope snapshot required')
        return snapshot
      }
    },
    ...args
  )
}
