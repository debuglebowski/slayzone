/**
 * Idle task selection tests.
 * Run with: npx tsx packages/apps/app/src/renderer/src/components/agent-status/useIdleTasks.test.ts
 */
import { buildIdleTasks, buildActiveSessionTaskIds } from './useIdleTasks'
import type { TerminalState } from '@slayzone/terminal/shared'
import type { Task } from '@slayzone/task/shared'

interface AgentSessionRow {
  sessionId: string
  taskId: string
  mode: string
  lastOutputTime: number
  state: TerminalState
}

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
    panel_sizes: null,
    worktree_path: null,
    worktree_parent_branch: null,
    base_dir: null,
    browser_url: null,
    browser_tabs: null,
    web_panel_urls: null,
    editor_open_files: null,
    merge_state: null,
    merge_context: null,
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

function makePty(
  sessionId: string,
  taskId: string,
  lastOutputTime: number,
  state: TerminalState = 'idle',
  mode: string = 'claude-code'
): AgentSessionRow {
  return {
    sessionId,
    taskId,
    lastOutputTime,
    mode,
    state
  }
}

const NOW = 100_000

test('deduplicates multiple idle sessions for the same task', () => {
  const task = makeTask('t1', 'p1', 'Task 1')
  const ptys: AgentSessionRow[] = [makePty('s1', 't1', NOW - 5000), makePty('s2', 't1', NOW - 3000)]
  const result = buildIdleTasks(ptys, [task], null, NOW)
  expect(result.length).toBe(1)
  expect(result[0]?.sessionId).toBe('s2')
})

test('keeps the most recent session per task', () => {
  const task = makeTask('t1', 'p1', 'Task 1')
  const ptys: AgentSessionRow[] = [
    makePty('older', 't1', NOW - 10_000),
    makePty('newer', 't1', NOW - 5000)
  ]
  const result = buildIdleTasks(ptys, [task], null, NOW)
  expect(result[0]?.sessionId).toBe('newer')
  expect(result[0]?.lastOutputTime).toBe(NOW - 5000)
})

test('applies project filter', () => {
  const task1 = makeTask('t1', 'p1', 'Task 1')
  const task2 = makeTask('t2', 'p2', 'Task 2')
  const ptys: AgentSessionRow[] = [makePty('s1', 't1', NOW - 5000), makePty('s2', 't2', NOW - 5000)]
  const result = buildIdleTasks(ptys, [task1, task2], 'p1', NOW)
  expect(result.map((item) => item.task.id)).toEqual(['t1'])
})

test('excludes non-idle states', () => {
  const task = makeTask('t1', 'p1', 'Task 1')
  const ptys: AgentSessionRow[] = [
    makePty('running', 't1', NOW - 5000, 'running'),
    makePty('starting', 't1', NOW - 5000, 'starting'),
    makePty('error', 't1', NOW - 5000, 'error'),
    makePty('dead', 't1', NOW - 5000, 'dead')
  ]
  expect(buildIdleTasks(ptys, [task], null, NOW).length).toBe(0)
})

test('excludes plain terminal mode', () => {
  const task = makeTask('t1', 'p1', 'Task 1')
  const ptys: AgentSessionRow[] = [makePty('shell', 't1', NOW - 5000, 'idle', 'terminal')]
  expect(buildIdleTasks(ptys, [task], null, NOW).length).toBe(0)
})

test('includes AI agent modes', () => {
  const task = makeTask('t1', 'p1', 'Task 1')
  const modes = [
    'claude-code',
    'codex',
    'gemini',
    'cursor-agent',
    'opencode',
    'qwen-code',
    'copilot'
  ]
  for (const mode of modes) {
    const ptys: AgentSessionRow[] = [makePty('s', 't1', NOW - 5000, 'idle', mode)]
    expect(buildIdleTasks(ptys, [task], null, NOW).length).toBe(1)
  }
})

test('excludes pty younger than 2s idle threshold', () => {
  const task = makeTask('t1', 'p1', 'Task 1')
  const ptys: AgentSessionRow[] = [
    makePty('fresh', 't1', NOW - 1500),
    makePty('exact', 't1', NOW - 2000),
    makePty('stale', 't1', NOW - 3000)
  ]
  // Keeps the most recent within threshold-respecting set: 'exact' (2000ms old).
  const result = buildIdleTasks(ptys, [task], null, NOW)
  expect(result.length).toBe(1)
  expect(result[0]?.sessionId).toBe('exact')
})

test('skips ptys with no matching task', () => {
  const ptys: AgentSessionRow[] = [makePty('orphan', 'missing', NOW - 5000)]
  expect(buildIdleTasks(ptys, [], null, NOW).length).toBe(0)
})

test('dedupes PTY + chat rows for same task by most recent lastOutputTime', () => {
  const task = makeTask('t1', 'p1', 'Task 1')
  // PTY row: format `${taskId}`. Chat row: format `${taskId}:${tabId}`.
  const rows: AgentSessionRow[] = [
    makePty('t1', 't1', NOW - 8000), // PTY, older
    makePty('t1:tab-a', 't1', NOW - 4000) // chat, newer
  ]
  const result = buildIdleTasks(rows, [task], null, NOW)
  expect(result.length).toBe(1)
  expect(result[0]?.sessionId).toBe('t1:tab-a')
  expect(result[0]?.lastOutputTime).toBe(NOW - 4000)
})

test('keeps PTY row when older chat row exists for same task', () => {
  const task = makeTask('t1', 'p1', 'Task 1')
  const rows: AgentSessionRow[] = [
    makePty('t1:tab-a', 't1', NOW - 8000), // chat, older
    makePty('t1', 't1', NOW - 4000) // PTY, newer
  ]
  const result = buildIdleTasks(rows, [task], null, NOW)
  expect(result.length).toBe(1)
  expect(result[0]?.sessionId).toBe('t1')
})

test('excludes tasks in terminal status (defensive: agent should already be killed)', () => {
  const task = makeTask('t1', 'p1', 'Task 1')
  task.status = 'done'
  const ptys: AgentSessionRow[] = [makePty('s1', 't1', NOW - 5000)]
  const result = buildIdleTasks(ptys, [task], null, NOW)
  expect(result.length).toBe(0)
})

test('PTY + chat rows for different tasks both surface', () => {
  const task1 = makeTask('t1', 'p1', 'Task 1')
  const task2 = makeTask('t2', 'p1', 'Task 2')
  const rows: AgentSessionRow[] = [
    makePty('t1', 't1', NOW - 5000), // PTY for t1
    makePty('t2:tab-a', 't2', NOW - 5000) // chat for t2
  ]
  const result = buildIdleTasks(rows, [task1, task2], null, NOW)
  expect(result.length).toBe(2)
  expect(result.map((r) => r.task.id).sort()).toEqual(['t1', 't2'])
})

// --- buildActiveSessionTaskIds ---

test('buildActiveSessionTaskIds: includes alive PTY rows', () => {
  const set = buildActiveSessionTaskIds(
    [
      { taskId: 't1', state: 'running' },
      { taskId: 't2', state: 'idle' },
      { taskId: 't3', state: 'starting' },
      { taskId: 't4', state: 'error' }
    ],
    []
  )
  expect(set.size).toBe(4)
  for (const id of ['t1', 't2', 't3', 't4']) {
    expect(set.has(id)).toBe(true)
  }
})

test('buildActiveSessionTaskIds: excludes dead PTY rows', () => {
  const set = buildActiveSessionTaskIds(
    [
      { taskId: 't1', state: 'dead' },
      { taskId: 't2', state: 'running' }
    ],
    []
  )
  expect(set.size).toBe(1)
  expect(set.has('t1')).toBe(false)
  expect(set.has('t2')).toBe(true)
})

test('buildActiveSessionTaskIds: excludes dead chat rows', () => {
  const set = buildActiveSessionTaskIds(
    [],
    [
      { taskId: 't1', state: 'dead' },
      { taskId: 't2', state: 'idle' }
    ]
  )
  expect(set.has('t1')).toBe(false)
  expect(set.has('t2')).toBe(true)
})

test('buildActiveSessionTaskIds: dedupes when PTY + chat both alive for same task', () => {
  const set = buildActiveSessionTaskIds(
    [{ taskId: 't1', state: 'running' }],
    [{ taskId: 't1', state: 'idle' }]
  )
  expect(set.size).toBe(1)
  expect(set.has('t1')).toBe(true)
})

test('buildActiveSessionTaskIds: dead PTY does not mask live chat for same task', () => {
  const set = buildActiveSessionTaskIds(
    [{ taskId: 't1', state: 'dead' }],
    [{ taskId: 't1', state: 'running' }]
  )
  expect(set.size).toBe(1)
  expect(set.has('t1')).toBe(true)
})

test('buildActiveSessionTaskIds: empty input → empty set', () => {
  const set = buildActiveSessionTaskIds([], [])
  expect(set.size).toBe(0)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
