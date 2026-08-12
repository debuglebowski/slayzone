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
import assert from 'node:assert/strict'
import { applyAgentHook, createAgentTree, resolveState, subagentIdOf } from './agent-tree'
import type { AgentTree } from './agent-tree'

let passed = 0
let failed = 0
function test(name: string, fn: () => void): void {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`    ${(err as Error).message}`)
  }
}

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

console.log('agent-tree: state ladder')

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

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
