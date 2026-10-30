/**
 * ClaudeSessionDriver: the Claude half of the chat prompt protocol — which
 * inbound control requests reach the timeline, how the host's answers are
 * written and recorded, and what is refused.
 *
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/terminal/src/server/agents/claude-session-driver.test.ts
 */
import { describe, expect, test } from 'vitest'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { claudeChatBackend } from './claude-session-driver'
import type { ChatSessionDriver } from './types'

const BASH_INPUT = { command: 'npm run build', description: 'Build the project' }
const BASH_SUGGESTIONS = [
  {
    type: 'addRules',
    rules: [{ toolName: 'Bash', ruleContent: 'npm run build' }],
    behavior: 'allow',
    destination: 'localSettings'
  }
]

function setup(): { driver: ChatSessionDriver; written: unknown[]; emitted: AgentEvent[] } {
  const written: unknown[] = []
  const emitted: AgentEvent[] = []
  const driver = claudeChatBackend.createDriver()
  void driver.start({
    write: (line) => written.push(JSON.parse(line)),
    emit: (ev) => emitted.push(ev),
    cwd: '/repo',
    sessionId: 's1',
    resume: false,
    providerFlags: [],
    chatModel: null,
    chatEffort: null,
    chatMode: null,
    chatCollaboration: null,
    chatFastMode: false
  })
  return { driver, written, emitted }
}

function canUseTool(requestId: string, request: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'control_request',
    request_id: requestId,
    request: { subtype: 'can_use_tool', ...request }
  })
}

function bashRequest(driver: ChatSessionDriver, requestId = 'req_bash'): void {
  driver.handleLine(
    canUseTool(requestId, {
      tool_name: 'Bash',
      input: BASH_INPUT,
      permission_suggestions: BASH_SUGGESTIONS,
      tool_use_id: 'toolu_bash'
    })
  )
}

function controlResponse(requestId: string, response: Record<string, unknown>): unknown {
  return {
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response }
  }
}

describe('ClaudeSessionDriver — prompts', () => {
  test('ExitPlanMode reaches the timeline like any request (no automatic deny)', () => {
    const { driver, written, emitted } = setup()
    driver.handleLine(
      canUseTool('req_plan', {
        tool_name: 'ExitPlanMode',
        input: { plan: '1. Write hello.txt' },
        tool_use_id: 'toolu_plan',
        requires_user_interaction: true
      })
    )
    expect(written).toEqual([])
    expect(emitted).toMatchObject([
      { kind: 'permission-request', requestId: 'req_plan', toolName: 'ExitPlanMode' }
    ])
  })

  test('answering writes the control_response and records permission-resolved', () => {
    const { driver, written, emitted } = setup()
    bashRequest(driver)
    expect(
      driver.respondPermission?.({
        requestId: 'req_bash',
        decision: { behavior: 'allow', updatedPermissions: BASH_SUGGESTIONS },
        optionId: 'yes-always'
      })
    ).toBe(true)
    expect(written).toEqual([
      controlResponse('req_bash', {
        behavior: 'allow',
        updatedInput: BASH_INPUT,
        updatedPermissions: BASH_SUGGESTIONS
      })
    ])
    expect(emitted.at(-1)).toEqual({
      kind: 'permission-resolved',
      requestId: 'req_bash',
      decision: {
        behavior: 'allow',
        updatedInput: BASH_INPUT,
        updatedPermissions: BASH_SUGGESTIONS
      },
      optionId: 'yes-always'
    })
  })

  test('a second answer, an unknown id, or an answer after the CLI cancelled is refused', () => {
    const { driver, written } = setup()
    const allow = { behavior: 'allow' as const }
    expect(driver.respondPermission?.({ requestId: 'nope', decision: allow })).toBe(false)

    bashRequest(driver)
    expect(driver.respondPermission?.({ requestId: 'req_bash', decision: allow })).toBe(true)
    expect(driver.respondPermission?.({ requestId: 'req_bash', decision: allow })).toBe(false)

    bashRequest(driver, 'req_bash_2')
    driver.handleLine(JSON.stringify({ type: 'control_cancel_request', request_id: 'req_bash_2' }))
    expect(driver.respondPermission?.({ requestId: 'req_bash_2', decision: allow })).toBe(false)
    expect(written).toHaveLength(1)
  })

  test('the approved input is the one the CLI asked about — a client cannot swap the command', () => {
    const { driver, written } = setup()
    bashRequest(driver)
    driver.respondPermission?.({
      requestId: 'req_bash',
      decision: { behavior: 'allow', updatedInput: { command: 'rm -rf ~' } }
    })
    expect(written).toEqual([
      controlResponse('req_bash', { behavior: 'allow', updatedInput: BASH_INPUT })
    ])
  })

  test('AskUserQuestion: only answers + annotations are merged into the asked input', () => {
    const { driver, written } = setup()
    const input = {
      questions: [{ question: 'Color?', header: 'C', multiSelect: false, options: [] }]
    }
    driver.handleLine(
      canUseTool('req_q', { tool_name: 'AskUserQuestion', input, tool_use_id: 'toolu_q' })
    )
    driver.respondPermission?.({
      requestId: 'req_q',
      decision: {
        behavior: 'allow',
        updatedInput: {
          questions: [],
          answers: { 'Color?': 'Blue' },
          annotations: { 'Color?': { notes: 'darker' } }
        }
      }
    })
    expect(written).toEqual([
      controlResponse('req_q', {
        behavior: 'allow',
        updatedInput: {
          ...input,
          answers: { 'Color?': 'Blue' },
          annotations: { 'Color?': { notes: 'darker' } }
        }
      })
    ])
  })

  test('permission rules must come from the request; session mode switches to auto / acceptEdits are allowed', () => {
    const { driver, written } = setup()
    bashRequest(driver)
    const forged = [
      {
        type: 'addRules',
        rules: [{ toolName: 'Bash' }],
        behavior: 'allow',
        destination: 'userSettings'
      }
    ]
    expect(
      driver.respondPermission?.({
        requestId: 'req_bash',
        decision: { behavior: 'allow', updatedPermissions: forged }
      })
    ).toBe(false)
    expect(written).toEqual([])

    const auto = [{ type: 'setMode', mode: 'auto', destination: 'session' }]
    expect(
      driver.respondPermission?.({
        requestId: 'req_bash',
        decision: { behavior: 'allow', updatedPermissions: auto }
      })
    ).toBe(true)
    expect(written).toEqual([
      controlResponse('req_bash', {
        behavior: 'allow',
        updatedInput: BASH_INPUT,
        updatedPermissions: auto
      })
    ])
  })

  test('deny + interrupt (the TUI "No") also marks the turn interrupted', () => {
    const { driver, written, emitted } = setup()
    bashRequest(driver)
    driver.respondPermission?.({
      requestId: 'req_bash',
      decision: { behavior: 'deny', message: 'no', interrupt: true }
    })
    expect(written).toEqual([
      controlResponse('req_bash', { behavior: 'deny', message: 'no', interrupt: true })
    ])
    expect(emitted.slice(-2).map((e) => e.kind)).toEqual(['permission-resolved', 'interrupted'])
  })

  test('deny with feedback keeps the turn going (no interrupt flag, no interrupted marker)', () => {
    const { driver, written, emitted } = setup()
    bashRequest(driver)
    driver.respondPermission?.({
      requestId: 'req_bash',
      decision: { behavior: 'deny', message: 'use pnpm' }
    })
    expect(written).toEqual([
      controlResponse('req_bash', { behavior: 'deny', message: 'use pnpm' })
    ])
    expect(emitted.at(-1)?.kind).toBe('permission-resolved')
  })

  test('a CLI cancel is forwarded only for a pending request', () => {
    const { driver, emitted } = setup()
    bashRequest(driver)
    const before = emitted.length
    driver.handleLine(JSON.stringify({ type: 'control_cancel_request', request_id: 'other' }))
    driver.handleLine(JSON.stringify({ type: 'control_cancel_request', request_id: 'req_bash' }))
    driver.handleLine(JSON.stringify({ type: 'control_cancel_request', request_id: 'req_bash' }))
    expect(emitted.slice(before)).toEqual([{ kind: 'permission-cancelled', requestId: 'req_bash' }])
  })

  test('a write that throws answers nothing and keeps the request pending', () => {
    const emitted: AgentEvent[] = []
    let fail = true
    const written: string[] = []
    const driver = claudeChatBackend.createDriver()
    void driver.start({
      write: (line) => {
        if (fail) throw new Error('EPIPE')
        written.push(line)
      },
      emit: (ev) => emitted.push(ev),
      cwd: '/repo',
      sessionId: 's1',
      resume: false,
      providerFlags: [],
      chatModel: null,
      chatEffort: null,
      chatMode: null,
      chatCollaboration: null,
      chatFastMode: false
    })
    bashRequest(driver)
    expect(
      driver.respondPermission?.({ requestId: 'req_bash', decision: { behavior: 'allow' } })
    ).toBe(false)
    expect(emitted.map((e) => e.kind)).toEqual(['permission-request'])
    fail = false
    expect(
      driver.respondPermission?.({ requestId: 'req_bash', decision: { behavior: 'allow' } })
    ).toBe(true)
    expect(written).toHaveLength(1)
  })
})

describe('ClaudeSessionDriver — other control requests', () => {
  test('a control request the host does not implement gets an immediate error reply and is not emitted', () => {
    const { driver, written, emitted } = setup()
    driver.handleLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'req_hook',
        request: { subtype: 'hook_callback', callback_id: 'ups', input: {} }
      })
    )
    expect(written).toEqual([
      {
        type: 'control_response',
        response: {
          subtype: 'error',
          request_id: 'req_hook',
          error: 'SlayZone does not handle control request "hook_callback"'
        }
      }
    ])
    expect(emitted).toEqual([])
  })
})

describe('ClaudeSessionDriver — permission mode', () => {
  function status(mode: string): string {
    return JSON.stringify({ type: 'system', subtype: 'status', status: null, permissionMode: mode })
  }
  function init(mode: string): string {
    return JSON.stringify({
      type: 'system',
      subtype: 'init',
      session_id: 's1',
      permissionMode: mode
    })
  }

  test('a mode change is emitted once per change, seeded by the turn-init', () => {
    const { driver, emitted } = setup()
    driver.handleLine(init('plan'))
    driver.handleLine(status('plan'))
    driver.handleLine(status('auto'))
    driver.handleLine(status('auto'))
    driver.handleLine(init('auto'))
    driver.handleLine(status('default'))
    expect(emitted.filter((e) => e.kind === 'permission-mode-changed').map((e) => e.mode)).toEqual([
      'auto',
      'default'
    ])
  })
})

describe('ClaudeSessionDriver — command tasks (plan 3.9)', () => {
  const taskLine = (subtype: string, fields: Record<string, unknown>) =>
    JSON.stringify({ type: 'system', subtype, ...fields, uuid: 'u', session_id: 's1' })
  const bashUse = (id: string) =>
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm1',
        content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ticks' } }]
      },
      parent_tool_use_id: null
    })
  /** The last control_request the driver wrote, and a line answering it. */
  function lastRequest(written: unknown[]) {
    const req = written.filter(
      (w): w is { request_id: string; request: Record<string, unknown> } =>
        (w as { type?: string }).type === 'control_request'
    )
    const last = req[req.length - 1]
    return {
      request: last?.request,
      answer: (response: Record<string, unknown>) =>
        JSON.stringify(controlResponse(last.request_id, response))
    }
  }
  const flush = () => new Promise((r) => setTimeout(r, 0))

  test('a Bash task is a command-task, a sub-agent stays a sub-agent; cli-task never leaves', () => {
    const { driver, emitted } = setup()
    driver.handleLine(bashUse('toolu_b'))
    driver.handleLine(
      taskLine('task_started', {
        task_id: 'tb',
        tool_use_id: 'toolu_b',
        description: 'Ticks',
        is_backgrounded: false,
        task_type: 'local_bash'
      })
    )
    driver.handleLine(
      taskLine('task_started', {
        task_id: 'ta',
        tool_use_id: 'toolu_a',
        description: 'Find',
        task_type: 'local_agent'
      })
    )
    driver.handleLine(taskLine('task_updated', { task_id: 'ta', patch: { status: 'completed' } }))
    const kinds = emitted.map((e) => e.kind)
    expect(kinds).toEqual(['tool-call', 'command-task', 'sub-agent'])
    expect(emitted[1]).toMatchObject({
      kind: 'command-task',
      taskId: 'tb',
      toolUseId: 'toolu_b',
      status: 'running',
      backgrounded: false
    })
    expect(typeof (emitted[1] as { startedAt?: number }).startedAt).toBe('number')
    expect(emitted[2]).toMatchObject({
      kind: 'sub-agent',
      toolUseId: 'toolu_a',
      phase: 'in-flight'
    })
  })

  test('commandTaskOutput polls get_task_output and normalizes the reply', async () => {
    const { driver, written } = setup()
    driver.handleLine(
      taskLine('task_started', { task_id: 'tb', tool_use_id: 'toolu_b', task_type: 'local_bash' })
    )
    const p = driver.commandTaskOutput!('tb')
    const { request, answer } = lastRequest(written)
    expect(request).toEqual({ subtype: 'get_task_output', task_id: 'tb' })
    driver.handleLine(answer({ output: 'tick 1\n', total_bytes: 7, truncated: false }))
    expect(await p).toEqual({
      state: 'running',
      output: 'tick 1\n',
      totalBytes: 7,
      truncated: false
    })
    expect(await driver.commandTaskOutput!('unknown')).toEqual({ state: 'gone' })
  })

  test('stop and move to background send the CLI’s requests', async () => {
    const { driver, written } = setup()
    driver.handleLine(
      taskLine('task_started', { task_id: 'tb', tool_use_id: 'toolu_b', task_type: 'local_bash' })
    )
    const moved = driver.backgroundCommandTask!('toolu_b')
    const bg = lastRequest(written)
    expect(bg.request).toEqual({ subtype: 'background_tasks', tool_use_id: 'toolu_b' })
    driver.handleLine(bg.answer({ backgrounded: true }))
    expect(await moved).toBe(true)

    driver.handleLine(taskLine('task_updated', { task_id: 'tb', patch: { is_backgrounded: true } }))
    const stopped = driver.stopCommandTask!('tb')
    const stop = lastRequest(written)
    expect(stop.request).toEqual({ subtype: 'stop_task', task_id: 'tb' })
    driver.handleLine(stop.answer({}))
    await stopped
  })

  test('a finished background command’s output is read and emitted once', async () => {
    const { driver, written, emitted } = setup()
    driver.handleLine(
      taskLine('task_started', {
        task_id: 'tb',
        tool_use_id: 'toolu_b',
        task_type: 'local_bash',
        is_backgrounded: true
      })
    )
    driver.handleLine(
      taskLine('task_updated', { task_id: 'tb', patch: { status: 'completed', end_time: 5 } })
    )
    const { request, answer } = lastRequest(written)
    expect(request).toEqual({ subtype: 'get_task_output', task_id: 'tb' })
    driver.handleLine(answer({ output: 'done\n', total_bytes: 5, truncated: false }))
    await flush()
    expect(emitted.filter((e) => e.kind === 'command-task-output')).toEqual([
      {
        kind: 'command-task-output',
        taskId: 'tb',
        toolUseId: 'toolu_b',
        output: 'done\n',
        totalBytes: 5,
        truncated: false
      }
    ])
  })

  test('after dispose (process gone) every task is gone', async () => {
    const { driver } = setup()
    driver.handleLine(
      taskLine('task_started', { task_id: 'tb', tool_use_id: 'toolu_b', task_type: 'local_bash' })
    )
    driver.dispose()
    expect(await driver.commandTaskOutput!('tb')).toEqual({ state: 'gone' })
  })
})
