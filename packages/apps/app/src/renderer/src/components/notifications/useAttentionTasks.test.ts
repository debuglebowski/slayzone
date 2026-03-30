/**
 * Regression tests for attention task deduplication.
 * Run with: npx tsx packages/apps/app/src/renderer/src/components/notifications/useAttentionTasks.test.ts
 */
import { buildAttentionTasks } from './useAttentionTasks'
import type { PtyInfo } from '@slayzone/terminal/shared'
import type { Task } from '@slayzone/task/shared'

let passed = 0
let failed = 0

function test(name: string, fn: () => void) {
  try {
    fn()
    console.log(`✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`✗ ${name}`)
    console.error(`  ${e}`)
    failed++
  }
}

function expect<T>(actual: T) {
  return {
    toBe(expected: T) {
      if (actual !== expected) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
    },
    toEqual(expected: T) {
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
      }
    }
  }
}

function makeTask(id: string, projectId: string, title: string): Task {
  return {
    id,
    title,
    description: null,
    description_format: 'html',
    assignee: null,
    status: 'todo',
    project_id: projectId,
    parent_id: null,
    priority: 2,
    order: 0,
    due_date: null,
    archived_at: null,
    terminal_mode: 'claude-code',
    provider_config: {},
    terminal_shell: null,
    claude_session_id: null,
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
    is_temporary: false,
    pr_url: null,
    repo_name: null,
    linear_url: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString()
  }
}

function makePty(sessionId: string, taskId: string, lastOutputTime: number): PtyInfo {
  return {
    sessionId,
    taskId,
    lastOutputTime,
    createdAt: Date.now(),
    mode: 'claude-code',
    state: 'attention'
  }
}

test('deduplicates multiple attention sessions for the same task', () => {
  const task = makeTask('t1', 'p1', 'Task 1')
  const ptys: PtyInfo[] = [
    makePty('t1:t1', 't1', 1000),
    makePty('t1:other', 't1', 1100)
  ]

  const result = buildAttentionTasks(ptys, [task], null)

  expect(result.length).toBe(1)
  expect(result[0]?.task.id).toBe('t1')
})

test('keeps the most recent session per task', () => {
  const task = makeTask('t1', 'p1', 'Task 1')
  const ptys: PtyInfo[] = [
    makePty('t1:older', 't1', 1000),
    makePty('t1:newer', 't1', 2000)
  ]

  const result = buildAttentionTasks(ptys, [task], null)

  expect(result.length).toBe(1)
  expect(result[0]?.sessionId).toBe('t1:newer')
  expect(result[0]?.lastOutputTime).toBe(2000)
})

test('applies project filter after deduplication input mapping', () => {
  const task1 = makeTask('t1', 'p1', 'Task 1')
  const task2 = makeTask('t2', 'p2', 'Task 2')
  const ptys: PtyInfo[] = [
    makePty('t1:t1', 't1', 1000),
    makePty('t2:t2', 't2', 1000)
  ]

  const result = buildAttentionTasks(ptys, [task1, task2], 'p1')

  expect(result.map((item) => item.task.id)).toEqual(['t1'])
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
