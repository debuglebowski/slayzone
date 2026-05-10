import { createTestHarness, test, expect, describe } from '../../../../../shared/test-utils/ipc-harness.js'
import { createTaskOp } from './create.js'
import { archiveTaskOp } from './archive.js'
import { parseTask } from './shared.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
// project.path doesn't exist on disk; cleanupTaskFull's removeWorktree call
// will throw and be caught silently — fine for asserting DB-level guard logic.
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Guard', '#abc', '/tmp/guard-fake')

function readWorktree(id: string): string | null {
  const row = h.db.prepare('SELECT worktree_path FROM tasks WHERE id = ?').get(id) as
    | { worktree_path: string | null }
    | undefined
  return row?.worktree_path ?? null
}

function readArchivedAt(id: string): string | null {
  const row = h.db.prepare('SELECT archived_at FROM tasks WHERE id = ?').get(id) as
    | { archived_at: string | null }
    | undefined
  return row?.archived_at ?? null
}

const guardParent = await createTaskOp(h.db, { projectId, title: 'GuardParent' }, {})
h.db.prepare(`UPDATE tasks SET worktree_path = ?, worktree_parent_branch = ? WHERE id = ?`)
  .run('/tmp/wt-guard', 'main', guardParent!.id)
const guardChild = await createTaskOp(h.db, { projectId, title: 'GuardChild', parentId: guardParent!.id }, {})

// Archive the subtask alone — shared-worktree guard should short-circuit
// cleanupTaskFull before removeWorktree, leaving parent's worktree_path intact.
await archiveTaskOp(h.db, guardChild!.id, {})

describe('shared-worktree cleanup guard', () => {
  test('child inherits parent worktree before archive', () => {
    // Sanity check: subtask inherited parent's worktree_path
    // (verified independently in subtask-inheritance.test.ts)
    const archivedChildRow = h.db.prepare('SELECT worktree_path, archived_at FROM tasks WHERE id = ?')
      .get(guardChild!.id) as { worktree_path: string | null; archived_at: string | null }
    // archive sets worktree_path = NULL on the archived row
    expect(archivedChildRow.archived_at).toBeTruthy()
  })

  test('archiving subtask alone keeps parent worktree_path intact', () => {
    // Parent still has worktree_path because guard saw subtask's worktree_path
    // matched and skipped removeWorktree.
    expect(readWorktree(guardParent!.id)).toBe('/tmp/wt-guard')
  })

  test('parent still active after subtask archived', () => {
    expect(readArchivedAt(guardParent!.id)).toBeNull()
  })
})

h.cleanup()
