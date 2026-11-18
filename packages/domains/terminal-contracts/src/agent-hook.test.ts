import { expect, test } from 'vitest'
import { resolveAgentHook, sanitizeAgentHook, stampWarmHookContext } from './agent-hook'
test('new, legacy and argv hook envelopes retain identity without forwarding content', () => {
  const raw = {
    hook_event_name: 'UserPromptSubmit',
    session_id: 'session',
    prompt: 'private prompt',
    tool_input: { command: 'private command' },
    tool_response: { stdout: 'private output' }
  }
  const envelope = {
    ctx: { v: 1, taskId: 'task', mode: 'custom', agentId: 'claude-code', spawnToken: 'proof' },
    raw,
    arg: null,
    agentId: 'claude-code'
  }
  const hook = resolveAgentHook(envelope)!
  expect(hook).toMatchObject({
    taskId: 'task',
    mode: 'custom',
    agentId: 'claude-code',
    hookEvent: 'UserPromptSubmit',
    sessionId: 'session'
  })
  const safe = sanitizeAgentHook(hook)
  expect(JSON.stringify(safe)).not.toContain('private')
  expect(resolveAgentHook(safe)).toMatchObject({
    taskId: 'task',
    mode: 'custom',
    sessionId: 'session',
    spawnToken: 'proof'
  })
  expect(
    resolveAgentHook({
      agentId: 'opencode',
      ctx: { taskId: 'task' },
      arg: JSON.stringify({ type: 'session.created', session_id: 's', prompt: 'private' })
    })
  ).toMatchObject({ sessionId: 's' })
  expect(
    resolveAgentHook({ agentId: 'codex', taskId: 't', hookEvent: 'Stop', sessionId: 's' })
  ).toMatchObject({ taskId: 't', hookEvent: 'Stop', sessionId: 's' })
})
test('sanitized lifecycle preserves blocking tool and background-job identities', () => {
  const hook = resolveAgentHook({
    agentId: 'claude-code',
    taskId: 't',
    hookEvent: 'PostToolUse',
    raw: {
      tool_name: 'Bash',
      tool_input: { command: 'npm run dev', run_in_background: true },
      tool_response: { backgroundTaskId: 'job', stdout: 'private' }
    }
  })!
  const safe = sanitizeAgentHook(hook)
  expect(safe.raw).toMatchObject({ tool_name: 'Bash', tool_response: { backgroundTaskId: 'job' } })
  expect(JSON.stringify(safe)).not.toContain('private')
})
test('a warm agent’s per-process id rides the hook context, but is never relayed', () => {
  const hook = resolveAgentHook({
    agentId: 'claude-code',
    ctx: { v: 1, taskId: 'boot-task', agentId: 'claude-code', warmId: 'warm:1' },
    raw: { hook_event_name: 'SessionEnd' }
  })!
  expect(hook.warmId).toBe('warm:1')
  // Agent-supplied: the hub only trusts the computer's own assertion (`fromWarm`).
  expect(JSON.stringify(sanitizeAgentHook(hook))).not.toContain('warm:1')
})
test('stampWarmHookContext adds the warm id to the identity blob and reads its task id', () => {
  const ctx = { v: 1, agentId: 'claude-code', taskId: 'boot-task', projectId: 'p' }
  const env = { SLAYZONE_AGENT_HOOK_CONTEXT: JSON.stringify(ctx), OTHER: 'x' }
  const stamped = stampWarmHookContext(env, 'warm:1')
  expect(stamped.bootTaskId).toBe('boot-task')
  expect(stamped.env.OTHER).toBe('x')
  expect(JSON.parse(stamped.env.SLAYZONE_AGENT_HOOK_CONTEXT!)).toEqual({ ...ctx, warmId: 'warm:1' })
  // The caller's env is not mutated.
  expect(JSON.parse(env.SLAYZONE_AGENT_HOOK_CONTEXT)).toEqual(ctx)
})
test('stampWarmHookContext leaves an env without a usable context unchanged', () => {
  expect(stampWarmHookContext(undefined, 'w')).toEqual({ env: undefined })
  expect(stampWarmHookContext({ A: '1' }, 'w')).toEqual({ env: { A: '1' } })
  const bad = { SLAYZONE_AGENT_HOOK_CONTEXT: 'not json' }
  expect(stampWarmHookContext(bad, 'w')).toEqual({ env: bad })
  const arr = { SLAYZONE_AGENT_HOOK_CONTEXT: '[1]' }
  expect(stampWarmHookContext(arr, 'w')).toEqual({ env: arr })
})
