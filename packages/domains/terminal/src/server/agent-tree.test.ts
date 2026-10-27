/**
 * Unit tests for the claude agent TREE state ladder (`agent-tree.ts`).
 *
 * Pure model, no PTY/DB — asserts the priority that the whole design rests on:
 *   awaiting the user > main loop working > background helpers > nothing
 *
 * The bug these lock down: a claude session is one main loop + N CONCURRENT
 * background subagents sharing one PTY and one hook context, so a helper's
 * `PreToolUse` used to assert "the agent is working" over a main loop parked on an
 * unanswered question (measured live: 37 min of green spinner on a task that was
 * waiting for the user, amber cue wiped).
 *
 * Run: pnpm exec tsx packages/domains/terminal/src/server/agent-tree.test.ts
 */
import { test } from 'vitest'
import assert from 'node:assert/strict'
import {
  applyAgentHook,
  applyBackgroundJobHook,
  createAgentTree,
  resolveState,
  dropBackgroundJobs,
  subagentIdOf
} from './agent-tree'
import type { AgentTree } from './agent-tree'

const SUB = 'a283110c20b8651d8'
const SUB2 = 'a9c6c3878eac7195d'

/** Main-loop hook (no agent_id). */
const main = (
  tree: AgentTree,
  hookEvent: string,
  toolName?: string
): ReturnType<typeof applyAgentHook> => applyAgentHook(tree, { hookEvent, toolName })

/** Background-subagent hook (agent_id present). */
const sub = (
  tree: AgentTree,
  hookEvent: string,
  subagentId = SUB,
  toolName?: string
): ReturnType<typeof applyAgentHook> => applyAgentHook(tree, { hookEvent, toolName, subagentId })

// --- agent-tree: state ladder ---

test('subagentIdOf discriminates main-loop from subagent payloads', () => {
  assert.equal(subagentIdOf({ tool_name: 'Bash' }), undefined)
  assert.equal(subagentIdOf({ tool_name: 'Bash', agent_id: SUB }), SUB)
  assert.equal(subagentIdOf({ agent_id: '' }), undefined)
  assert.equal(subagentIdOf(undefined), undefined)
})

test('fresh tree is idle', () => {
  assert.equal(resolveState(createAgentTree()), 'idle')
})

test('main turn: prompt → running, Stop → idle', () => {
  const t = createAgentTree()
  assert.equal(main(t, 'UserPromptSubmit'), 'running')
  assert.equal(main(t, 'PreToolUse', 'Bash'), 'running')
  assert.equal(main(t, 'PostToolUse', 'Bash'), null) // mid-turn no-op (no flicker)
  assert.equal(main(t, 'Stop'), 'idle')
})

test('blocking tool parks the main loop and latches awaitingUser', () => {
  const t = createAgentTree()
  main(t, 'UserPromptSubmit')
  assert.equal(main(t, 'PreToolUse', 'AskUserQuestion'), 'idle')
  assert.equal(t.awaitingUser, true)
  assert.equal(t.mainWorking, false)
  assert.equal(main(t, 'PreToolUse', 'ExitPlanMode'), 'idle')
  assert.equal(t.awaitingUser, true)
})

test('THE BUG: a helper cannot resume a main loop parked on a question', () => {
  const t = createAgentTree()
  main(t, 'UserPromptSubmit')
  main(t, 'PreToolUse', 'AskUserQuestion')
  // Helper churns away for the whole time the user is thinking.
  assert.equal(sub(t, 'PreToolUse', SUB, 'Bash'), 'idle')
  assert.equal(sub(t, 'PostToolUse', SUB, 'Bash'), 'idle')
  assert.equal(sub(t, 'PreToolUse', SUB2, 'Read'), 'idle')
  // Latch survives untouched → hibernation gate still knows not to kill it.
  assert.equal(t.awaitingUser, true)
  // Helpers are still tracked, they just don't get to speak for the main loop.
  assert.equal(t.subagents.size, 2)
})

test('answering resumes running even with helpers still in flight', () => {
  const t = createAgentTree()
  main(t, 'UserPromptSubmit')
  sub(t, 'PreToolUse', SUB, 'Bash')
  main(t, 'PreToolUse', 'AskUserQuestion')
  assert.equal(resolveState(t), 'idle')
  // A blocking tool's PostToolUse only fires on accept/answer — the sole proof.
  assert.equal(main(t, 'PostToolUse', 'AskUserQuestion'), 'running')
  assert.equal(t.awaitingUser, false)
})

test('reject/Esc: no PostToolUse ever arrives → stays parked', () => {
  const t = createAgentTree()
  main(t, 'UserPromptSubmit')
  main(t, 'PreToolUse', 'ExitPlanMode')
  assert.equal(resolveState(t), 'idle')
  assert.equal(t.awaitingUser, true)
  // Replying by typing instead resumes it.
  assert.equal(main(t, 'UserPromptSubmit'), 'running')
  assert.equal(t.awaitingUser, false)
})

test('helper work while the main loop works → running (no downgrade)', () => {
  const t = createAgentTree()
  main(t, 'UserPromptSubmit')
  assert.equal(sub(t, 'PreToolUse', SUB, 'Bash'), 'running')
  assert.equal(sub(t, 'SubagentStop', SUB), 'running')
})

test('turn ends with helpers alive → background, draining to idle', () => {
  const t = createAgentTree()
  main(t, 'UserPromptSubmit')
  sub(t, 'PreToolUse', SUB, 'Bash')
  sub(t, 'PreToolUse', SUB2, 'Read')
  assert.equal(main(t, 'Stop'), 'background')
  assert.equal(sub(t, 'SubagentStop', SUB), 'background') // one left
  assert.equal(sub(t, 'SubagentStop', SUB2), 'idle') // last one out
})

test('SubagentStop for an unknown id is harmless (no negative count)', () => {
  const t = createAgentTree()
  main(t, 'UserPromptSubmit')
  main(t, 'Stop')
  assert.equal(sub(t, 'SubagentStop', 'never-seen'), 'idle')
  assert.equal(t.subagents.size, 0)
})

test('repeat hooks from one helper do not double-count it', () => {
  const t = createAgentTree()
  main(t, 'Stop')
  sub(t, 'PreToolUse', SUB, 'Bash')
  sub(t, 'PreToolUse', SUB, 'Read')
  sub(t, 'PostToolUse', SUB, 'Read')
  assert.equal(t.subagents.size, 1)
  assert.equal(sub(t, 'SubagentStop', SUB), 'idle')
})

test('main loop resuming outranks background helpers', () => {
  const t = createAgentTree()
  sub(t, 'PreToolUse', SUB, 'Bash')
  main(t, 'Stop')
  assert.equal(resolveState(t), 'background')
  assert.equal(main(t, 'PreToolUse', 'Read'), 'running')
})

test('Notification ends the working stretch without latching awaitingUser', () => {
  // Its dominant subtype is idle_prompt (waiting for the NEXT instruction) —
  // exactly the stale case idle-close SHOULD still be allowed to hibernate.
  const t = createAgentTree()
  main(t, 'UserPromptSubmit')
  assert.equal(main(t, 'Notification'), 'idle')
  assert.equal(t.awaitingUser, false)
})

test('SessionStart / PreCompact / unknown → no state opinion', () => {
  const t = createAgentTree()
  main(t, 'UserPromptSubmit')
  assert.equal(main(t, 'SessionStart'), null)
  assert.equal(main(t, 'PreCompact'), null)
  assert.equal(main(t, 'WhoKnows'), null)
  assert.equal(resolveState(t), 'running') // untouched
})

test('SessionEnd clears the turn and reports remaining helpers', () => {
  const t = createAgentTree()
  main(t, 'UserPromptSubmit')
  assert.equal(main(t, 'SessionEnd'), 'idle')
  sub(t, 'PreToolUse', SUB, 'Bash')
  assert.equal(main(t, 'SessionEnd'), 'background')
})

// --- agent-tree: background jobs (Bash run_in_background / Monitor) ---

// Payload shapes copied from live claude 2.1.311 hooks (dev-hub diagnostics).
const bgBashPost = (id: string, command = 'sleep 300') => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Bash',
  tool_input: { command, run_in_background: true },
  tool_response: {
    stdout: '',
    stderr: '',
    interrupted: false,
    backgroundTaskId: id
  }
})
const monitorPost = (id: string, command = 'tail -f log') => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'Monitor',
  tool_input: { command, description: 'x', timeout_ms: 60000 },
  tool_response: { taskId: id, timeoutMs: 60000, persistent: false }
})
const taskStopPost = (id: string) => ({
  hook_event_name: 'PostToolUse',
  tool_name: 'TaskStop',
  tool_input: { task_id: id },
  tool_response: {
    message: 'Successfully stopped task',
    task_id: id,
    task_type: 'local_bash'
  }
})

test('explicit run_in_background Bash registers a shell job', () => {
  const t = createAgentTree()
  assert.equal(applyBackgroundJobHook(t, 'PostToolUse', bgBashPost('bg7siv1aw')), true)
  assert.deepEqual(
    [...t.backgroundJobs.values()],
    [{ id: 'bg7siv1aw', kind: 'shell', command: 'sleep 300' }]
  )
})

test('a foreground Bash auto-backgrounded on timeout registers too', () => {
  const t = createAgentTree()
  const raw = bgBashPost('b9hnjq8y3', 'grep -r x .')
  delete (raw.tool_input as { run_in_background?: boolean }).run_in_background
  ;(raw.tool_response as Record<string, unknown>).timedOutAfterMs = 120000
  assert.equal(applyBackgroundJobHook(t, 'PostToolUse', raw), true)
  assert.equal(t.backgroundJobs.get('b9hnjq8y3')?.kind, 'shell')
})

test('Monitor registers a monitor job with its command', () => {
  const t = createAgentTree()
  assert.equal(applyBackgroundJobHook(t, 'PostToolUse', monitorPost('b9pbuzi0i')), true)
  assert.deepEqual(t.backgroundJobs.get('b9pbuzi0i'), {
    id: 'b9pbuzi0i',
    kind: 'monitor',
    command: 'tail -f log'
  })
})

test('a plain foreground Bash / PreToolUse / other tools register nothing', () => {
  const t = createAgentTree()
  const fg = {
    tool_name: 'Bash',
    tool_input: { command: 'ls' },
    tool_response: { stdout: '' }
  }
  assert.equal(applyBackgroundJobHook(t, 'PostToolUse', fg), false)
  assert.equal(applyBackgroundJobHook(t, 'PreToolUse', bgBashPost('x1')), false)
  assert.equal(applyBackgroundJobHook(t, 'PostToolUse', { tool_name: 'Read' }), false)
  assert.equal(applyBackgroundJobHook(t, 'Stop', undefined), false)
  assert.equal(t.backgroundJobs.size, 0)
})

test('TaskStop removes the job by id; unknown id is a no-op', () => {
  const t = createAgentTree()
  applyBackgroundJobHook(t, 'PostToolUse', bgBashPost('a1'))
  applyBackgroundJobHook(t, 'PostToolUse', bgBashPost('a2'))
  assert.equal(applyBackgroundJobHook(t, 'PostToolUse', taskStopPost('nope')), false)
  assert.equal(applyBackgroundJobHook(t, 'PostToolUse', taskStopPost('a1')), true)
  assert.deepEqual([...t.backgroundJobs.keys()], ['a2'])
})

test('legacy KillShell (shell_id) removes the job', () => {
  const t = createAgentTree()
  applyBackgroundJobHook(t, 'PostToolUse', bgBashPost('a1'))
  const kill = {
    tool_name: 'KillShell',
    tool_input: { shell_id: 'a1' },
    tool_response: {}
  }
  assert.equal(applyBackgroundJobHook(t, 'PostToolUse', kill), true)
  assert.equal(t.backgroundJobs.size, 0)
})

test('a subagent-launched background job is tracked like a main-loop one', () => {
  const t = createAgentTree()
  assert.equal(
    applyBackgroundJobHook(t, 'PostToolUse', {
      ...bgBashPost('s1'),
      agent_id: SUB
    }),
    true
  )
  assert.equal(t.backgroundJobs.size, 1)
})

test('background jobs never change the TerminalState ladder', () => {
  // A long-lived dev server must not hold the session in 'background': the turn
  // ending has to reach 'idle' so the amber "your turn" cue still fires.
  const t = createAgentTree()
  main(t, 'UserPromptSubmit')
  applyBackgroundJobHook(t, 'PostToolUse', bgBashPost('dev'))
  assert.equal(main(t, 'Stop'), 'idle')
  assert.equal(resolveState(t), 'idle')
})

test('dropBackgroundJobs removes exactly the given ids', () => {
  // The probe result only speaks for the ids it was asked about: a job started
  // while the probe was in flight must survive it.
  const t = createAgentTree()
  applyBackgroundJobHook(t, 'PostToolUse', bgBashPost('a1'))
  applyBackgroundJobHook(t, 'PostToolUse', monitorPost('m1'))
  assert.equal(dropBackgroundJobs(t, []), false)
  assert.equal(dropBackgroundJobs(t, ['not-tracked']), false)
  assert.equal(dropBackgroundJobs(t, ['a1']), true)
  assert.deepEqual([...t.backgroundJobs.keys()], ['m1'])
})
