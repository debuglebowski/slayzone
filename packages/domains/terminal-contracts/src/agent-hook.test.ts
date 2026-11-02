import { expect, test } from 'vitest'
import { resolveAgentHook, sanitizeAgentHook } from './agent-hook'
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
