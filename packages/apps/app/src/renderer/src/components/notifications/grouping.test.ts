/**
 * Notification status grouping tests
 * Run with: npx tsx packages/apps/app/src/renderer/src/components/notifications/grouping.test.ts
 */
import assert from 'node:assert/strict'
import { groupAttentionTasksByStatus } from './grouping.js'
import type { AttentionTask } from './useAttentionTasks.js'
import type { Project } from '@slayzone/projects/shared'

function runTest(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
  } catch (error) {
    console.error(`  ✗ ${name}`)
    throw error
  }
}

function makeAttention(projectId: string, status: string): AttentionTask {
  return {
    task: {
      id: crypto.randomUUID(),
      project_id: projectId,
      status,
      title: `${projectId}:${status}`
    } as AttentionTask['task'],
    sessionId: crypto.randomUUID(),
    lastOutputTime: Date.now()
  }
}

const projectA: Project = {
  id: 'project-a',
  name: 'A',
  color: '#111111',
  path: null,
  auto_create_worktree_on_task_create: null,
  worktree_source_branch: null,
  worktree_copy_behavior: null,
  worktree_copy_paths: null,
  columns_config: [
    { id: 'queued', label: 'Queue', color: 'gray', position: 0, category: 'unstarted' },
    { id: 'finished', label: 'Finished', color: 'green', position: 1, category: 'completed' }
  ],
  execution_context: null,
  selected_repo: null,
  sort_order: 0,
  created_at: '',
  updated_at: ''
}

const projectB: Project = {
  id: 'project-b',
  name: 'B',
  color: '#222222',
  path: null,
  auto_create_worktree_on_task_create: null,
  worktree_source_branch: null,
  worktree_copy_behavior: null,
  worktree_copy_paths: null,
  columns_config: [
    { id: 'queued', label: 'Inbox', color: 'gray', position: 0, category: 'triage' },
    { id: 'finished', label: 'Done', color: 'green', position: 1, category: 'completed' }
  ],
  execution_context: null,
  selected_repo: null,
  sort_order: 1,
  created_at: '',
  updated_at: ''
}

console.log('\nnotification grouping')

runTest('uses project-aware labels in all-project mode', () => {
  const groups = groupAttentionTasksByStatus(
    [
      makeAttention(projectA.id, 'queued'),
      makeAttention(projectB.id, 'queued'),
      makeAttention(projectB.id, 'queued'),
      makeAttention(projectB.id, 'finished')
    ],
    [projectA, projectB],
    false,
    projectA.id
  )

  // Projects A and B both have column id 'queued' but with different labels
  // ('Queue' vs 'Inbox'). Grouping by label splits them into separate groups.
  const queue = groups.find((group) => group.label === 'Queue')
  const inbox = groups.find((group) => group.label === 'Inbox')
  const done = groups.find((group) => group.label === 'Done')

  assert.equal(queue?.tasks.length, 1)
  assert.equal(inbox?.tasks.length, 2)
  assert.equal(done?.tasks.length, 1)
})

runTest('merges custom columns with same label across projects', () => {
  const projX: Project = {
    ...projectA,
    id: 'project-x',
    columns_config: [
      { id: 'status-4', label: 'Stashed', color: 'yellow', position: 0, category: 'backlog' },
      { id: 'done-x', label: 'Done', color: 'green', position: 1, category: 'completed' }
    ]
  }
  const projY: Project = {
    ...projectB,
    id: 'project-y',
    columns_config: [
      { id: 'status-3', label: 'Stashed', color: 'yellow', position: 0, category: 'backlog' },
      { id: 'done-y', label: 'Done', color: 'green', position: 1, category: 'completed' }
    ]
  }

  const groups = groupAttentionTasksByStatus(
    [
      makeAttention(projX.id, 'status-4'),
      makeAttention(projY.id, 'status-3'),
      makeAttention(projX.id, 'done-x')
    ],
    [projX, projY],
    false,
    projX.id
  )

  const stashed = groups.find((g) => g.label === 'Stashed')
  const done = groups.find((g) => g.label === 'Done')

  assert.equal(stashed?.tasks.length, 2, 'same-label columns should merge')
  assert.equal(done?.tasks.length, 1)
})

runTest('uses selected project labels in current-project mode', () => {
  const groups = groupAttentionTasksByStatus(
    [
      makeAttention(projectA.id, 'queued'),
      makeAttention(projectA.id, 'finished')
    ],
    [projectA, projectB],
    true,
    projectA.id
  )

  assert.equal(groups[0]?.label, 'Queue')
  assert.equal(groups[1]?.label, 'Finished')
})

console.log('\nDone')
