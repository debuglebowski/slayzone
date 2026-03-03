/**
 * Regression tests for worktree-driven session reset behavior.
 * Run with: pnpm --filter @slayzone/app exec electron --import tsx/esm /abs/path/to/this/file
 */
import { createTestHarness, describe, expect, test } from '../../../../shared/test-utils/ipc-harness.js'
import { registerTaskHandlers } from './handlers.js'
import type { Task } from '../shared/types.js'

const h = await createTestHarness()
registerTaskHandlers(h.ipcMain as never, h.db)

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(
  projectId,
  'Worktree Reset',
  '#111',
  '/tmp/worktree-reset'
)

function createTaskWithCodexConversation(conversationId: string): Task {
  const created = h.invoke('db:tasks:create', {
    projectId,
    title: 'Reset me',
    terminalMode: 'codex'
  }) as Task

  return h.invoke('db:tasks:update', {
    id: created.id,
    providerConfig: { codex: { conversationId } }
  }) as Task
}

describe('worktree session reset', () => {
  test('clears codex conversation id when worktree path changes', () => {
    const seeded = createTaskWithCodexConversation('11111111-2222-4333-8444-555555555555')
    expect(seeded.provider_config.codex?.conversationId).toBe('11111111-2222-4333-8444-555555555555')

    const updated = h.invoke('db:tasks:update', {
      id: seeded.id,
      worktreePath: '/tmp/worktree-reset/new-branch',
      worktreeParentBranch: 'main'
    }) as Task

    expect(updated.worktree_path).toBe('/tmp/worktree-reset/new-branch')
    expect(updated.provider_config.codex?.conversationId ?? null).toBeNull()
    expect(updated.codex_conversation_id).toBeNull()
  })
})

console.log('\nDone\n')
