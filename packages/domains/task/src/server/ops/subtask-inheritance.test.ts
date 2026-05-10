import { createTestHarness, test, expect, describe } from '../../../../../shared/test-utils/ipc-harness.js'
import type { Task } from '@slayzone/task/shared'
import { createTaskOp } from './create.js'
import { parseTask } from './shared.js'

const h = await createTestHarness()

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Inh', '#abc', '/tmp/inh')

function readTask(id: string): Task | null {
  const row = h.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return parseTask(row)
}

const wtParent = await createTaskOp(h.db, { projectId, title: 'WtParent' }, {})
h.db.prepare(`UPDATE tasks SET worktree_path = ?, worktree_parent_branch = ?, base_dir = ?, repo_name = ? WHERE id = ?`)
  .run('/tmp/wt-parent', 'main', '/tmp/base', 'repo-x', wtParent!.id)

const wtChild = await createTaskOp(h.db, { projectId, title: 'WtChild', parentId: wtParent!.id }, {})

const noWtParent = await createTaskOp(h.db, { projectId, title: 'NoWtParent' }, {})
const noWtChild = await createTaskOp(h.db, { projectId, title: 'NoWtChild', parentId: noWtParent!.id }, {})

const repoParent = await createTaskOp(h.db, { projectId, title: 'RepoParent' }, {})
h.db.prepare('UPDATE tasks SET repo_name = ? WHERE id = ?').run('parent-repo', repoParent!.id)
const repoChild = await createTaskOp(h.db, { projectId, title: 'RepoChild', parentId: repoParent!.id, repoName: 'caller-repo' }, {})

describe('subtask worktree inheritance', () => {
  test('inherits parent worktree fields', () => {
    const child = readTask(wtChild!.id)
    expect(child?.worktree_path).toBe('/tmp/wt-parent')
    expect(child?.worktree_parent_branch).toBe('main')
    expect(child?.base_dir).toBe('/tmp/base')
    expect(child?.repo_name).toBe('repo-x')
  })

  test('null when parent has no worktree', () => {
    const child = readTask(noWtChild!.id)
    expect(child?.worktree_path).toBeNull()
    expect(child?.worktree_parent_branch).toBeNull()
    expect(child?.base_dir).toBeNull()
  })

  test('parent repo_name overrides caller-supplied value', () => {
    const child = readTask(repoChild!.id)
    expect(child?.repo_name).toBe('parent-repo')
  })
})

h.cleanup()
