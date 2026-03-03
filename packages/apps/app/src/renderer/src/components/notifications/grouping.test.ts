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
  task_backend: 'db',
  feature_repo_integration_enabled: 0,
  feature_repo_features_path: 'features',
  auto_create_worktree_on_task_create: null,
  worktree_source_branch: null,
  columns_config: [
    { id: 'queued', label: 'Queue', color: 'gray', position: 0, category: 'unstarted' },
    { id: 'finished', label: 'Finished', color: 'green', position: 1, category: 'completed' }
  ],
  created_at: '',
  updated_at: ''
}

const projectB: Project = {
  id: 'project-b',
  name: 'B',
  color: '#222222',
  path: null,
  task_backend: 'db',
  feature_repo_integration_enabled: 0,
  feature_repo_features_path: 'features',
  auto_create_worktree_on_task_create: null,
  worktree_source_branch: null,
  columns_config: [
    { id: 'queued', label: 'Inbox', color: 'gray', position: 0, category: 'triage' },
    { id: 'finished', label: 'Done', color: 'green', position: 1, category: 'completed' }
  ],
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

  const queued = groups.find((group) => group.status === 'queued')
  const finished = groups.find((group) => group.status === 'finished')

  assert.equal(queued?.label, 'Inbox')
  assert.equal(finished?.label, 'Done')
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
