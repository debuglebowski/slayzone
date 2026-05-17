/**
 * REST: POST /api/agent-hook full-chain integration.
 *
 * Verifies hook → state-transition → handleAttentionTransition → DB flag for
 * the scenarios that matter under the new hook-driven Claude state machine:
 *   - Stop hook with user input flags the task
 *   - Notification hook (permission request) flags the task
 *   - PostToolUse fires no state transition (no flag flicker mid-turn)
 *   - Stop without user input does NOT flag (boot/banner gate)
 *   - UserPromptSubmit clears an existing flag (running clears attention)
 *
 * State-machine drive is injected via the TerminalStateBridge dep so this test
 * does not pull in node-pty / Electron native modules. The injected bridge
 * mirrors the prod wire: transition fires the same listener app/index.ts
 * registers on onGlobalStateChange — i.e. handleAttentionTransition.
 *
 * Run with: pnpm tsx --loader ./packages/shared/test-utils/loader.ts \
 *   packages/apps/app/src/main/rest-api/agent-hook-attention.test.ts
 */
import express from 'express'
import { createTestHarness, test, expect, describe } from '../../../../../shared/test-utils/ipc-harness.js'
import { mountRestApp } from '../../../../../shared/test-utils/rest-harness.js'
import { handleAttentionTransition } from '@slayzone/task/main'
import type { TerminalState } from '@slayzone/terminal/shared'
import { registerAgentHookRoute, type TerminalStateBridge } from './agent-hook.js'

const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)')
  .run(projectId, 'Proj', '#abc', '/tmp/attn')

function seedTask(): string {
  const id = crypto.randomUUID()
  h.db.prepare(
    'INSERT INTO tasks (id, project_id, title, status, priority, terminal_mode, provider_config) VALUES (?, ?, ?, ?, 3, ?, ?)'
  ).run(id, projectId, `attn-${id.slice(0, 6)}`, 'todo', 'claude-code', '{}')
  return id
}

function readFlag(id: string): number {
  const row = h.db.prepare('SELECT needs_attention FROM tasks WHERE id = ?').get(id) as
    | { needs_attention: number }
    | undefined
  return row?.needs_attention ?? -1
}

// Bridge stub:
//   - findSession echoes taskId (we treat the row id as the sessionId).
//   - transition mirrors prod by firing a listener that calls
//     handleAttentionTransition w/ the in-memory DB + per-test user-input flag.
//   - markActive tracks the silence-timer clock refreshes hooks should drive.
let currentState: TerminalState = 'idle'
let hasUserInput = false
let lastActivityAt = 0
const activityLog: Array<{ kind: 'transition' | 'markActive'; sessionId: string; at: number }> = []
const bridge: TerminalStateBridge = {
  findSession: (taskId) => taskId,
  transition: (sessionId, newState) => {
    const prev = currentState
    currentState = newState
    lastActivityAt = Date.now()
    activityLog.push({ kind: 'transition', sessionId, at: lastActivityAt })
    handleAttentionTransition(h.db, sessionId, newState, prev, hasUserInput)
    return true
  },
  markActive: (sessionId) => {
    lastActivityAt = Date.now()
    activityLog.push({ kind: 'markActive', sessionId, at: lastActivityAt })
    return true
  },
}

const app = express()
registerAgentHookRoute(app, { db: h.db, notifyRenderer: () => {} }, bridge)
const rest = await mountRestApp(app)

interface HookRes { ok?: boolean; error?: string }

async function postHook(taskId: string, hookEvent: string, raw?: unknown): Promise<number> {
  const res = await rest.request<HookRes>('POST', '/api/agent-hook', {
    agentId: 'claude-code',
    hookEvent,
    taskId,
    ...(raw !== undefined ? { raw } : {}),
  })
  return res.status
}

await describe('POST /api/agent-hook → handleAttentionTransition', () => {
  test('Stop hook + user input → needs_attention set', async () => {
    const id = seedTask()
    currentState = 'running'
    hasUserInput = true
    expect(await postHook(id, 'Stop')).toBe(200)
    expect(readFlag(id)).toBe(1)
  })

  test('Notification hook (permission request) + user input → needs_attention set', async () => {
    const id = seedTask()
    currentState = 'running'
    hasUserInput = true
    expect(await postHook(id, 'Notification')).toBe(200)
    expect(readFlag(id)).toBe(1)
  })

  test('PreToolUse AskUserQuestion + user input → needs_attention set (blocking tool)', async () => {
    // Native blocking tool never fires Notification — PreToolUse must flip to
    // idle on its own so attention transition picks up running→idle.
    const id = seedTask()
    currentState = 'running'
    hasUserInput = true
    expect(await postHook(id, 'PreToolUse', { tool_name: 'AskUserQuestion' })).toBe(200)
    expect(currentState).toBe('idle')
    expect(readFlag(id)).toBe(1)
  })

  test('PreToolUse Bash → running (non-blocking tool unchanged)', async () => {
    const id = seedTask()
    currentState = 'idle'
    hasUserInput = true
    expect(await postHook(id, 'PreToolUse', { tool_name: 'Bash' })).toBe(200)
    expect(currentState).toBe('running')
    expect(readFlag(id)).toBe(0)
  })

  test('PostToolUse hook → markActive only, state stays running, flag stays 0', async () => {
    const id = seedTask()
    currentState = 'running'
    hasUserInput = true
    activityLog.length = 0
    expect(await postHook(id, 'PostToolUse')).toBe(200)
    expect(readFlag(id)).toBe(0)
    expect(currentState).toBe('running')
    expect(activityLog.length).toBe(1)
    expect(activityLog[0].kind).toBe('markActive')
  })

  test('Stop hook WITHOUT user input → flag stays 0 (boot/banner gate)', async () => {
    const id = seedTask()
    currentState = 'running'
    hasUserInput = false
    expect(await postHook(id, 'Stop')).toBe(200)
    expect(readFlag(id)).toBe(0)
  })

  test('UserPromptSubmit clears existing needs_attention (resumes work)', async () => {
    const id = seedTask()
    h.db.prepare('UPDATE tasks SET needs_attention = 1 WHERE id = ?').run(id)
    currentState = 'idle'
    hasUserInput = true
    expect(await postHook(id, 'UserPromptSubmit')).toBe(200)
    expect(readFlag(id)).toBe(0)
    expect(currentState).toBe('running')
  })

  test('SessionStart hook → no state transition (PTY owns its starting→idle settle)', async () => {
    const id = seedTask()
    currentState = 'idle'
    hasUserInput = true
    expect(await postHook(id, 'SessionStart')).toBe(200)
    expect(readFlag(id)).toBe(0)
    expect(currentState).toBe('idle')
  })

  test('SubagentStop hook → markActive only (main agent still working)', async () => {
    const id = seedTask()
    currentState = 'running'
    hasUserInput = true
    activityLog.length = 0
    expect(await postHook(id, 'SubagentStop')).toBe(200)
    expect(readFlag(id)).toBe(0)
    expect(currentState).toBe('running')
    expect(activityLog[0]?.kind).toBe('markActive')
  })

  test('mid-turn hook sequence keeps clock fresh on every hook (no premature idle)', async () => {
    // Regression: the silence-timer used to fire mid-turn because hooks did
    // not refresh `lastOutputTime`. Verify every hook in a realistic turn
    // sequence drives an activity touch (transition OR markActive) so the
    // fail-safe clock keeps re-arming.
    const id = seedTask()
    currentState = 'idle'
    hasUserInput = true
    activityLog.length = 0

    // Realistic flow: prompt → tool 1 (pre/post) → tool 2 (pre/post) → stop
    const flow = ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreToolUse', 'PostToolUse', 'Stop']
    for (const hookEvent of flow) {
      expect(await postHook(id, hookEvent)).toBe(200)
    }

    // Every hook must produce one activity record.
    expect(activityLog.length).toBe(flow.length)
    // Transitions: UserPromptSubmit → running, PreToolUse ×2 → running (same
    // state, still calls transition), Stop → idle. PostToolUse ×2 → markActive.
    const kinds = activityLog.map((e) => e.kind)
    expect(kinds).toEqual(['transition', 'transition', 'markActive', 'transition', 'markActive', 'transition'])
    // Final state: idle. Flag set since running→idle w/ user input.
    expect(currentState).toBe('idle')
    expect(readFlag(id)).toBe(1)
  })

  test('non-claude agent (codex) → bridge not consulted', async () => {
    const id = seedTask()
    currentState = 'running'
    hasUserInput = true
    const res = await rest.request<HookRes>('POST', '/api/agent-hook', {
      agentId: 'codex',
      hookEvent: 'task_complete',
      taskId: id,
    })
    expect(res.status).toBe(200)
    expect(readFlag(id)).toBe(0)
    expect(currentState).toBe('running')
  })
})

await rest.close()
h.cleanup()
