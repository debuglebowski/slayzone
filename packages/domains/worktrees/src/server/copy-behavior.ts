import type { Database } from 'better-sqlite3'
import type { WorktreeCopyBehavior, WorktreeSubmoduleInit } from '@slayzone/projects/shared'

export function resolveCopyBehavior(db: Database, projectId?: string): { behavior: WorktreeCopyBehavior; customPaths: string[] } {
  if (projectId) {
    try {
      const row = db.prepare('SELECT worktree_copy_behavior, worktree_copy_paths FROM projects WHERE id = ?')
        .get(projectId) as { worktree_copy_behavior: string | null; worktree_copy_paths: string | null } | undefined
      if (row?.worktree_copy_behavior) {
        const behavior = row.worktree_copy_behavior as WorktreeCopyBehavior
        const customPaths = behavior === 'custom' && row.worktree_copy_paths
          ? row.worktree_copy_paths.split(',').map(p => p.trim()).filter(Boolean)
          : []
        return { behavior, customPaths }
      }
    } catch { /* fall through to global setting */ }
  }

  const settingRow = db.prepare("SELECT value FROM settings WHERE key = 'worktree_copy_behavior'")
    .get() as { value: string } | undefined
  const behavior = (settingRow?.value as WorktreeCopyBehavior) || 'ask'
  let customPaths: string[] = []
  if (behavior === 'custom') {
    const pathsRow = db.prepare("SELECT value FROM settings WHERE key = 'worktree_copy_paths'")
      .get() as { value: string } | undefined
    customPaths = pathsRow?.value ? pathsRow.value.split(',').map(p => p.trim()).filter(Boolean) : []
  }

  return { behavior, customPaths }
}

export function resolveSubmoduleInitBehavior(db: Database, projectId?: string): WorktreeSubmoduleInit {
  if (projectId) {
    try {
      const row = db.prepare('SELECT worktree_submodule_init FROM projects WHERE id = ?')
        .get(projectId) as { worktree_submodule_init: string | null } | undefined
      if (row?.worktree_submodule_init) return row.worktree_submodule_init as WorktreeSubmoduleInit
    } catch { /* column may not exist on stale DB — fall through */ }
  }

  const settingRow = db.prepare("SELECT value FROM settings WHERE key = 'worktree_submodule_init'")
    .get() as { value: string } | undefined
  return (settingRow?.value as WorktreeSubmoduleInit) || 'auto'
}
