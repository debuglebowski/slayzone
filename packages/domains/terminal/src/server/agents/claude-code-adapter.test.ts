/**
 * Tests for ClaudeCodeAdapter against real fixtures captured in Spike B.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/terminal/src/server/agents/claude-code-adapter.test.ts
 */
import { describe, expect, test } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { claudeCodeAdapter } from './claude-code-adapter'
import type { AgentEvent } from '@slayzone/terminal-contracts'

const FIXTURES_DIR = fileURLToPath(new URL('../../../test/fixtures/claude-stream', import.meta.url))

function parseFixture(name: string): AgentEvent[] {
  const raw = readFileSync(join(FIXTURES_DIR, name), 'utf8')
  const lines = raw.split('\n').filter((l) => l.trim())
  return lines.map((l) => claudeCodeAdapter.parseLine(l)!).filter(Boolean)
}

describe('ClaudeCodeAdapter tests', () => {
  // ---- Fixture-driven coverage ----
  const fixtureFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith('.ndjson'))
  for (const f of fixtureFiles) {
    test(`parses ${f} end-to-end (no parse-error events)`, () => {
      const events = parseFixture(f)
      expect(events.length).toBeGreaterThan(0)
      const parseErrors = events.filter((e) => e.kind === 'unknown' && e.reason === 'parse-error')
      expect(parseErrors.length).toBe(0)
      // Every fixture should end with a result event
      const last = events[events.length - 1]
      expect(last.kind).toBe('result')
    })
  }

  // ---- Specific shape assertions ----

  test('edit.ndjson: tool-call Edit → tool-result with structuredPatch', () => {
    const events = parseFixture('edit.ndjson')
    const editCall = events.find((e) => e.kind === 'tool-call' && e.name === 'Edit')
    if (!editCall || editCall.kind !== 'tool-call') throw new Error('no Edit tool-call')
    const input = editCall.input as { old_string?: string; new_string?: string }
    expect(input.old_string).toBe('hi')
    expect(input.new_string).toBe('hello')

    const editResult = events.find((e) => e.kind === 'tool-result' && e.toolUseId === editCall.id)
    if (!editResult || editResult.kind !== 'tool-result') throw new Error('no Edit result')
    const structured = editResult.structured as { structuredPatch?: unknown[] }
    expect(structured.structuredPatch).toBeInstanceOf(Array)
  })

  test('read.ndjson: tool-result carries structured file content', () => {
    const events = parseFixture('read.ndjson')
    const readCall = events.find((e) => e.kind === 'tool-call' && e.name === 'Read')
    if (!readCall || readCall.kind !== 'tool-call') throw new Error('no Read call')
    const result = events.find((e) => e.kind === 'tool-result' && e.toolUseId === readCall.id)
    if (!result || result.kind !== 'tool-result') throw new Error('no Read result')
    const s = result.structured as { file?: { content?: string; numLines?: number } }
    expect(typeof s.file?.content).toBe('string')
    expect(s.file?.numLines ?? 0).toBeGreaterThan(0)
  })

  test('todowrite.ndjson: structured oldTodos/newTodos present', () => {
    const events = parseFixture('todowrite.ndjson')
    const call = events.find((e) => e.kind === 'tool-call' && e.name === 'TodoWrite')
    if (!call || call.kind !== 'tool-call') throw new Error('no TodoWrite call')
    const result = events.find((e) => e.kind === 'tool-result' && e.toolUseId === call.id)
    if (!result || result.kind !== 'tool-result') throw new Error('no TodoWrite result')
    const s = result.structured as { newTodos?: unknown[] }
    expect(s.newTodos).toBeInstanceOf(Array)
    expect((s.newTodos as unknown[]).length).toBe(3)
  })

  test('thinking.ndjson: assistant-thinking event with signature flag', () => {
    const events = parseFixture('thinking.ndjson')
    const thinking = events.find((e) => e.kind === 'assistant-thinking')
    if (!thinking || thinking.kind !== 'assistant-thinking') throw new Error('no thinking')
    expect(thinking.hasSignature).toBe(true)
  })

  test('any fixture: rate-limit event normalized', () => {
    let found = false
    for (const f of fixtureFiles) {
      const events = parseFixture(f)
      const rl = events.find((e) => e.kind === 'rate-limit')
      if (rl && rl.kind === 'rate-limit') {
        expect(rl.status).toBe('allowed')
        found = true
        break
      }
    }
    expect(found).toBeTruthy()
  })

  test('turn-init has session id + model + tools', () => {
    const events = parseFixture('bash.ndjson')
    const init = events.find((e) => e.kind === 'turn-init')
    if (!init || init.kind !== 'turn-init') throw new Error('no turn-init')
    expect(init.sessionId.length).toBeGreaterThan(0)
    expect(init.model.length).toBeGreaterThan(0)
    expect(init.tools.length).toBeGreaterThan(0)
  })

  test('result event has cost + usage + modelUsage', () => {
    const events = parseFixture('edit.ndjson')
    const result = events[events.length - 1]
    if (result.kind !== 'result') throw new Error('no result')
    expect(result.totalCostUsd).toBeGreaterThan(0)
    expect(result.usage.outputTokens).toBeGreaterThan(0)
    expect(Object.keys(result.modelUsage).length).toBeGreaterThan(0)
  })

  // ---- Lenient / forward-compat ----

  test('malformed JSON → unknown with reason=parse-error', () => {
    const ev = claudeCodeAdapter.parseLine('{not valid json')
    if (!ev) throw new Error('expected event')
    if (ev.kind !== 'unknown') throw new Error(`expected unknown, got ${ev.kind}`)
    expect(ev.reason).toBe('parse-error')
  })

  test('unknown top-level type → unknown with reason=unknown-type', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({ type: 'speculative_new_thing', foo: 'bar' })
    )
    if (!ev || ev.kind !== 'unknown') throw new Error('expected unknown')
    expect(ev.reason).toBe('unknown-type')
  })

  test('shape-mismatched assistant → unknown with reason=shape-mismatch', () => {
    const ev = claudeCodeAdapter.parseLine(JSON.stringify({ type: 'assistant' /* no message */ }))
    if (!ev || ev.kind !== 'unknown') throw new Error('expected unknown')
    expect(ev.reason).toBe('shape-mismatch')
  })

  test('empty line → null', () => {
    expect(claudeCodeAdapter.parseLine('')).toBe(null)
    expect(claudeCodeAdapter.parseLine('   ')).toBe(null)
  })

  test('unknown assistant content block → unknown-type (does not throw)', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'x', content: [{ type: 'speculative_block', foo: 'bar' }] }
      })
    )
    if (!ev || ev.kind !== 'unknown') throw new Error('expected unknown')
    expect(ev.reason).toBe('unknown-type')
  })

  // ---- Spawn args + serialize ----

  test('buildSpawnArgs: fresh session', () => {
    const { args } = claudeCodeAdapter.buildSpawnArgs({
      sessionId: 'abc',
      resume: false,
      cwd: '/tmp',
      providerFlags: ['--allow-dangerously-skip-permissions']
    })
    expect(args).toContain('--session-id')
    expect(args).toContain('abc')
    expect(args).not.toContain('--resume')
    expect(args).toContain('--input-format')
    expect(args).toContain('stream-json')
  })

  test('buildSpawnArgs: resume uses --resume not --session-id', () => {
    const { args } = claudeCodeAdapter.buildSpawnArgs({
      sessionId: 'abc',
      resume: true,
      cwd: '/tmp',
      providerFlags: []
    })
    expect(args).toContain('--resume')
    expect(args).not.toContain('--session-id')
  })

  test('serializeUserMessage emits a single NDJSON object (no newline)', () => {
    const out = claudeCodeAdapter.serializeUserMessage('hello', 'sid')
    expect(out.endsWith('\n')).toBe(false)
    const parsed = JSON.parse(out)
    expect(parsed.type).toBe('user')
    expect(parsed.message.content).toBe('hello')
  })

  test('hook_started / hook_response / task_progress → null (drop noise)', () => {
    for (const subtype of ['hook_started', 'hook_response', 'task_progress']) {
      const out = claudeCodeAdapter.parseLine(
        JSON.stringify({ type: 'system', subtype, hook_id: 'x' })
      )
      expect(out).toBe(null)
    }
  })

  test('user/text record → null (dup of synthetic user-message)', () => {
    const out = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }
      })
    )
    expect(out).toBe(null)
  })

  test('parent_tool_use_id propagates through assistant tool_use, text, thinking', () => {
    const tool = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          id: 'm1',
          content: [{ type: 'tool_use', id: 'tu_inner', name: 'Grep', input: { pattern: 'x' } }]
        },
        parent_tool_use_id: 'tu_TASK'
      })
    )
    if (!tool || tool.kind !== 'tool-call') throw new Error('expected tool-call')
    expect(tool.parentToolUseId).toBe('tu_TASK')

    const text = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm2', content: [{ type: 'text', text: 'hi' }] },
        parent_tool_use_id: 'tu_TASK'
      })
    )
    if (!text || text.kind !== 'assistant-text') throw new Error('expected assistant-text')
    expect(text.parentToolUseId).toBe('tu_TASK')

    const think = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm3', content: [{ type: 'thinking', thinking: '...' }] },
        parent_tool_use_id: 'tu_TASK'
      })
    )
    if (!think || think.kind !== 'assistant-thinking')
      throw new Error('expected assistant-thinking')
    expect(think.parentToolUseId).toBe('tu_TASK')
  })

  test('parent_tool_use_id propagates through tool_result', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tu_inner', content: 'ok' }]
        },
        parent_tool_use_id: 'tu_TASK'
      })
    )
    if (!ev || ev.kind !== 'tool-result') throw new Error('expected tool-result')
    expect(ev.parentToolUseId).toBe('tu_TASK')
  })

  test('parent_tool_use_id propagates through stream events (block-start, delta, stop)', () => {
    const start = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'tu_inner', name: 'Bash' }
        },
        parent_tool_use_id: 'tu_TASK'
      })
    )
    if (!start || start.kind !== 'stream-block-start')
      throw new Error('expected stream-block-start')
    expect(start.parentToolUseId).toBe('tu_TASK')

    const delta = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'a' } },
        parent_tool_use_id: 'tu_TASK'
      })
    )
    if (!delta || delta.kind !== 'stream-block-delta')
      throw new Error('expected stream-block-delta')
    expect(delta.parentToolUseId).toBe('tu_TASK')

    const stop = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
        parent_tool_use_id: 'tu_TASK'
      })
    )
    if (!stop || stop.kind !== 'stream-block-stop') throw new Error('expected stream-block-stop')
    expect(stop.parentToolUseId).toBe('tu_TASK')
  })

  test('null parent_tool_use_id → undefined parentToolUseId (top-level events)', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'assistant',
        message: { id: 'm1', content: [{ type: 'text', text: 'hi' }] },
        parent_tool_use_id: null
      })
    )
    if (!ev || ev.kind !== 'assistant-text') throw new Error('expected assistant-text')
    expect(ev.parentToolUseId).toBe(undefined)
  })

  test('extractSessionId: pulls from turn-init, null otherwise', () => {
    const init: AgentEvent = {
      kind: 'turn-init',
      sessionId: 'sid-123',
      model: 'x',
      cwd: '/',
      tools: []
    }
    expect(claudeCodeAdapter.extractSessionId(init)).toBe('sid-123')

    const result: AgentEvent = {
      kind: 'result',
      subtype: 'success',
      isError: false,
      durationMs: 0,
      durationApiMs: 0,
      numTurns: 0,
      totalCostUsd: 0,
      stopReason: null,
      terminalReason: null,
      text: null,
      modelUsage: {},
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0
      },
      permissionDenials: []
    }
    expect(claudeCodeAdapter.extractSessionId(result)).toBe(null)
  })

  test('serializeToolResult: emits user-envelope tool_result keyed by tool_use_id', () => {
    const out = claudeCodeAdapter.serializeToolResult?.({
      toolUseId: 'tu_42',
      content: '{"answers":{"Q":"A"}}',
      sessionId: 'sid-1'
    })
    if (typeof out !== 'string') throw new Error('expected string')
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed.type).toBe('user')
    const message = parsed.message as { role: string; content: Array<Record<string, unknown>> }
    expect(message.role).toBe('user')
    const block = message.content[0]
    expect(block.type).toBe('tool_result')
    expect(block.tool_use_id).toBe('tu_42')
    expect(block.content).toBe('{"answers":{"Q":"A"}}')
    // is_error omitted when not set — keeps wire payload minimal.
    expect('is_error' in block).toBe(false)
  })

  test('buildSpawnArgs: enables stdio permission_prompt_tool', () => {
    const { args } = claudeCodeAdapter.buildSpawnArgs({
      sessionId: 'abc',
      resume: false,
      cwd: '/tmp',
      providerFlags: []
    })
    const idx = args.indexOf('--permission-prompt-tool')
    if (idx === -1) throw new Error('expected --permission-prompt-tool flag')
    expect(args[idx + 1]).toBe('stdio')
  })

  test('parseLine: incoming control_request can_use_tool → permission-request event', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'cu_1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'AskUserQuestion',
          input: {
            questions: [{ question: 'Pick one', header: 'P', multiSelect: false, options: [] }]
          },
          tool_use_id: 'tu_42'
        }
      })
    )
    if (!ev || ev.kind !== 'permission-request') throw new Error('expected permission-request')
    expect(ev.requestId).toBe('cu_1')
    expect(ev.toolName).toBe('AskUserQuestion')
    expect(ev.toolUseId).toBe('tu_42')
  })

  test('parseLine: can_use_tool keeps the display fields the card needs (Bash, CLI 2.1.312)', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'cu_bash',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          display_name: 'Bash',
          input: { command: 'python3 -c "print(6*7)"', description: 'Print 6*7' },
          description: 'Print 6*7',
          permission_suggestions: [
            {
              type: 'addRules',
              rules: [{ toolName: 'Bash', ruleContent: 'python3 -c "print(6*7)"' }],
              behavior: 'allow',
              destination: 'localSettings'
            }
          ],
          decision_reason: 'This command requires approval',
          decision_reason_type: 'other',
          blocked_path: '/repo/out.txt',
          tool_use_id: 'toolu_bash'
        }
      })
    )
    expect(ev).toEqual({
      kind: 'permission-request',
      requestId: 'cu_bash',
      toolName: 'Bash',
      toolUseId: 'toolu_bash',
      input: { command: 'python3 -c "print(6*7)"', description: 'Print 6*7' },
      permissionSuggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash', ruleContent: 'python3 -c "print(6*7)"' }],
          behavior: 'allow',
          destination: 'localSettings'
        }
      ],
      displayName: 'Bash',
      description: 'Print 6*7',
      decisionReason: 'This command requires approval',
      decisionReasonType: 'other',
      blockedPath: '/repo/out.txt'
    })
  })

  test('parseLine: can_use_tool keeps subagent, MCP and card-shaping flags', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'control_request',
        request_id: 'cu_mcp',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'mcp__spike__echo',
          mcp_server: { name: 'spike', source: 'dynamic' },
          display_name: 'Echo',
          title: 'Echo tool',
          input: { text: 'abc1' },
          server_policy_ask_only: true,
          suppress_always_allow_rule: true,
          default_to_no: true,
          requires_user_interaction: true,
          agent_id: 'a20fbe83',
          tool_use_id: 'toolu_mcp'
        }
      })
    )
    if (!ev || ev.kind !== 'permission-request') throw new Error('expected permission-request')
    expect(ev).toMatchObject({
      toolName: 'mcp__spike__echo',
      mcpServer: { name: 'spike', source: 'dynamic' },
      displayName: 'Echo',
      title: 'Echo tool',
      serverPolicyAskOnly: true,
      suppressAlwaysAllow: true,
      defaultToNo: true,
      requiresUserInteraction: true,
      agentId: 'a20fbe83'
    })
    // Absent wire fields stay absent (no `undefined` keys persisted).
    expect(Object.keys(ev)).not.toContain('decisionReason')
    expect(Object.keys(ev)).not.toContain('blockedPath')
  })

  test('parseLine: control_request the host must answer but does not handle → host-control-request', () => {
    for (const subtype of ['hook_callback', 'mcp_message', 'some_future_subtype']) {
      const ev = claudeCodeAdapter.parseLine(
        JSON.stringify({
          type: 'control_request',
          request_id: `r_${subtype}`,
          request: { subtype, callback_id: 'h1' }
        })
      )
      expect(ev).toEqual({ kind: 'host-control-request', requestId: `r_${subtype}`, subtype })
    }
  })

  test('parseLine: control_request without a request_id → unknown shape-mismatch (cannot be answered)', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({ type: 'control_request', request: { subtype: 'can_use_tool' } })
    )
    if (!ev || ev.kind !== 'unknown') throw new Error('expected unknown')
    expect(ev.reason).toBe('shape-mismatch')
  })

  test('parseLine: control_cancel_request → permission-cancelled', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'control_cancel_request',
        request_id: '2bb5b252-9242-4a74-a45f-8de393d35219'
      })
    )
    expect(ev).toEqual({
      kind: 'permission-cancelled',
      requestId: '2bb5b252-9242-4a74-a45f-8de393d35219'
    })
  })

  test('parseLine: control_cancel_request without a request_id → unknown shape-mismatch', () => {
    const ev = claudeCodeAdapter.parseLine(JSON.stringify({ type: 'control_cancel_request' }))
    if (!ev || ev.kind !== 'unknown') throw new Error('expected unknown')
    expect(ev.reason).toBe('shape-mismatch')
  })

  test('parseLine: system/status carrying permissionMode → permission-mode-changed', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'status',
        status: null,
        permissionMode: 'acceptEdits',
        uuid: '68d2d067',
        session_id: 'b68b548e'
      })
    )
    expect(ev).toEqual({ kind: 'permission-mode-changed', mode: 'acceptEdits' })
  })

  test('serializeControlResponse: success carries response payload', () => {
    const out = claudeCodeAdapter.serializeControlResponse?.({
      requestId: 'cu_1',
      response: { behavior: 'allow', updatedInput: { answers: { Q: 'A' } } }
    })
    if (typeof out !== 'string') throw new Error('expected string')
    const parsed = JSON.parse(out) as { response: Record<string, unknown> }
    expect(parsed.response.subtype).toBe('success')
    expect(parsed.response.request_id).toBe('cu_1')
    const inner = parsed.response.response as {
      behavior: string
      updatedInput: Record<string, unknown>
    }
    expect(inner.behavior).toBe('allow')
    const updatedInput = inner.updatedInput as { answers: Record<string, string> }
    expect(updatedInput.answers.Q).toBe('A')
  })

  test('serializeControlResponse: error carries error subtype + message', () => {
    const out = claudeCodeAdapter.serializeControlResponse?.({
      requestId: 'cu_2',
      isError: true,
      error: 'user dismissed'
    })
    if (typeof out !== 'string') throw new Error('expected string')
    const parsed = JSON.parse(out) as { response: Record<string, unknown> }
    expect(parsed.response.subtype).toBe('error')
    expect(parsed.response.error).toBe('user dismissed')
  })

  test('serializeControlRequest: wraps payload in control_request envelope', () => {
    const out = claudeCodeAdapter.serializeControlRequest?.({
      requestId: 'req_1_abc',
      request: { subtype: 'set_permission_mode', mode: 'acceptEdits' }
    })
    if (typeof out !== 'string') throw new Error('expected string')
    const parsed = JSON.parse(out) as Record<string, unknown>
    expect(parsed.type).toBe('control_request')
    expect(parsed.request_id).toBe('req_1_abc')
    const req = parsed.request as Record<string, unknown>
    expect(req.subtype).toBe('set_permission_mode')
    expect(req.mode).toBe('acceptEdits')
  })

  test('parseLine: control_response success → control-response event with isError=false', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'success', request_id: 'req_42' }
      })
    )
    if (!ev || ev.kind !== 'control-response') throw new Error('expected control-response')
    expect(ev.requestId).toBe('req_42')
    expect(ev.isError).toBe(false)
  })

  test('parseLine: control_response error → carries error message', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'control_response',
        response: { subtype: 'error', request_id: 'req_99', error: 'bad mode' }
      })
    )
    if (!ev || ev.kind !== 'control-response') throw new Error('expected control-response')
    expect(ev.requestId).toBe('req_99')
    expect(ev.isError).toBe(true)
    expect(ev.error).toBe('bad mode')
  })

  test('serializeToolResult: includes is_error flag when set', () => {
    const out = claudeCodeAdapter.serializeToolResult?.({
      toolUseId: 'tu_err',
      content: 'failed',
      isError: true,
      sessionId: 'sid-1'
    })
    if (typeof out !== 'string') throw new Error('expected string')
    const parsed = JSON.parse(out) as Record<string, unknown>
    const message = parsed.message as { content: Array<Record<string, unknown>> }
    expect(message.content[0].is_error).toBe(true)
  })
})

// Recorded against Claude Code 2.1.312 (haiku): `chatui-local-commands` = /compact on an
// empty session (fails), /context, /cost, /usage; `chatui-compact-session` = two turns,
// a successful /compact, a recall turn and /context.
describe('ClaudeCodeAdapter — slash commands, compaction, usage', () => {
  test('turn-init carries the CLI command list, terminal-only subset, skills and version', () => {
    const init = parseFixture('chatui-local-commands.ndjson').find((e) => e.kind === 'turn-init')
    if (!init || init.kind !== 'turn-init') throw new Error('no turn-init')
    expect(init.slashCommands).toContain('compact')
    expect(init.slashCommands).toContain('context')
    expect(init.terminalSlashCommands).toEqual(['doctor', 'color', 'focus', 'reload-plugins'])
    expect(init.skills).toContain('simplify')
    expect(init.cliVersion).toBe('2.1.312')
  })

  test('turn-init without a command list (older CLI / other envelope) leaves the fields undefined', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'init',
        session_id: 's',
        model: 'm',
        cwd: '/',
        tools: []
      })
    )
    if (!ev || ev.kind !== 'turn-init') throw new Error('expected turn-init')
    expect(ev.slashCommands).toBeUndefined()
    expect(ev.terminalSlashCommands).toBeUndefined()
    expect(ev.skills).toBeUndefined()
  })

  test('status compacting → compact-status started; failed result → compact-status failed + error', () => {
    const statuses = parseFixture('chatui-local-commands.ndjson').filter(
      (e) => e.kind === 'compact-status'
    )
    expect(statuses).toEqual([
      { kind: 'compact-status', phase: 'started' },
      { kind: 'compact-status', phase: 'failed', error: 'Not enough messages to compact.' }
    ])
  })

  test('successful compaction → started, succeeded, boundary with metadata', () => {
    const events = parseFixture('chatui-compact-session.ndjson')
    expect(events.filter((e) => e.kind === 'compact-status')).toEqual([
      { kind: 'compact-status', phase: 'started' },
      { kind: 'compact-status', phase: 'succeeded' }
    ])
    expect(events.find((e) => e.kind === 'compact-boundary')).toEqual({
      kind: 'compact-boundary',
      trigger: 'manual',
      preTokens: 49079,
      postTokens: 6408,
      durationMs: 3476
    })
  })

  test('plain null status → dropped (no persisted noise)', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'status',
        status: null,
        session_id: 's',
        uuid: 'u'
      })
    )
    expect(ev).toBeNull()
  })

  test('status requesting / thinking_tokens → transport-internal heartbeat (proof of life)', () => {
    expect(
      claudeCodeAdapter.parseLine(
        JSON.stringify({ type: 'system', subtype: 'status', status: 'requesting', uuid: 'u' })
      )
    ).toEqual({ kind: 'heartbeat', source: 'status:requesting' })
    expect(
      claudeCodeAdapter.parseLine(
        JSON.stringify({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 50 })
      )
    ).toEqual({ kind: 'heartbeat', source: 'thinking_tokens' })
  })

  test('command_lifecycle → command-lifecycle (the CLI confirming a message uuid)', () => {
    for (const state of ['queued', 'started', 'completed', 'cancelled'] as const) {
      expect(
        claudeCodeAdapter.parseLine(
          JSON.stringify({ type: 'command_lifecycle', command_uuid: 'm-1', state, uuid: 'x' })
        )
      ).toEqual({ kind: 'command-lifecycle', commandUuid: 'm-1', state })
    }
    expect(
      claudeCodeAdapter.parseLine(JSON.stringify({ type: 'command_lifecycle', state: 'weird' }))
    ).toMatchObject({ kind: 'unknown', reason: 'shape-mismatch' })
  })

  test('a replayed user message → user-replay with its uuid; never a timeline event', () => {
    expect(
      claudeCodeAdapter.parseLine(
        JSON.stringify({
          type: 'user',
          isReplay: true,
          uuid: 'm-1',
          message: { role: 'user', content: 'hello' }
        })
      )
    ).toEqual({ kind: 'user-replay', uuid: 'm-1' })
  })

  test('serializeUserTurn: the message id is the CLI uuid; one text block travels as a string', () => {
    expect(
      JSON.parse(
        claudeCodeAdapter.serializeUserTurn!({ id: 'm-1', content: [{ type: 'text', text: 'hi' }] })
      )
    ).toEqual({ type: 'user', uuid: 'm-1', message: { role: 'user', content: 'hi' } })
    expect(
      JSON.parse(
        claudeCodeAdapter.serializeUserTurn!({
          id: 'm-2',
          content: [
            { type: 'text', text: 'a' },
            { type: 'text', text: 'b' }
          ]
        })
      ).message.content
    ).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' }
    ])
  })

  test('spawn args ask the CLI to echo user messages (delivery confirmation)', () => {
    const { args } = claudeCodeAdapter.buildSpawnArgs({
      sessionId: 's',
      resume: false,
      cwd: '/tmp',
      providerFlags: []
    })
    expect(args).toContain('--replay-user-messages')
  })

  test('local slash command output (assistant with local_command_run) → command-output', () => {
    const outputs = parseFixture('chatui-local-commands.ndjson').filter(
      (e) => e.kind === 'command-output'
    )
    expect(outputs.map((o) => (o.kind === 'command-output' ? o.command : null))).toEqual([
      'compact',
      'context',
      'usage',
      'usage'
    ])
    const ctx = outputs[1]
    if (ctx.kind !== 'command-output') throw new Error('expected command-output')
    expect(ctx.text.startsWith('## Context Usage')).toBe(true)
    expect(ctx.id).toBe('90ba88ba-25ae-4d28-8e57-be002f66fd95')
    // Synthetic local-command messages never surface as assistant text.
    expect(
      parseFixture('chatui-local-commands.ndjson').some((e) => e.kind === 'assistant-text')
    ).toBe(false)
  })

  test('system/local_command_output → command-output', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'local_command_output',
        content: 'Voice mode on',
        uuid: 'u-1',
        session_id: 's'
      })
    )
    expect(ev).toEqual({ kind: 'command-output', id: 'u-1', command: null, text: 'Voice mode on' })
  })

  test('main-thread assistant events carry the API call usage', () => {
    const text = parseFixture('chatui-compact-session.ndjson').find(
      (e) => e.kind === 'assistant-text'
    )
    if (!text || text.kind !== 'assistant-text') throw new Error('no assistant-text')
    expect(text.usage).toEqual({
      inputTokens: 8036,
      outputTokens: 4,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 40990
    })
  })

  test('result modelUsage keeps contextWindow + maxOutputTokens; cost is cumulative', () => {
    const results = parseFixture('chatui-compact-session.ndjson').filter((e) => e.kind === 'result')
    const first = results[0]
    if (first.kind !== 'result') throw new Error('expected result')
    expect(first.modelUsage['claude-haiku-5-5'].contextWindow).toBe(1000000)
    expect(first.modelUsage['claude-haiku-5-5'].maxOutputTokens).toBe(128000)
    const totals = results.map((r) => (r.kind === 'result' ? r.totalCostUsd : 0))
    for (let i = 1; i < totals.length; i++) expect(totals[i]).toBeGreaterThanOrEqual(totals[i - 1])
  })

  test('string-content user records (compaction summary / replays) → dropped', () => {
    const events = parseFixture('chatui-compact-session.ndjson')
    expect(events.some((e) => e.kind === 'unknown')).toBe(false)
  })
})

describe('ClaudeCodeAdapter — custom commands', () => {
  const userRecord = (content: string): string =>
    JSON.stringify({
      type: 'user',
      message: { role: 'user', content },
      session_id: 's',
      parent_tool_use_id: null,
      uuid: 'u-1'
    })

  test('a custom command whose `!shell` line was refused → command-output error', () => {
    // CLI 2.1.312, spike item 11: `!python3 …` without allowed-tools.
    const out = claudeCodeAdapter.parseLine(
      userRecord(
        '<local-command-stderr>Shell command permission check failed for pattern "!`python3 -c "print(7*6)"`": This command requires approval</local-command-stderr>'
      )
    )
    expect(out).toEqual({
      kind: 'command-output',
      id: 'u-1',
      command: null,
      text: 'Shell command permission check failed for pattern "!`python3 -c "print(7*6)"`": This command requires approval',
      isError: true
    })
  })

  test('local-command stdout records stay dropped', () => {
    expect(
      claudeCodeAdapter.parseLine(
        userRecord(
          '<local-command-stdout>Compacted PreCompact [notify.sh] completed successfully: {}</local-command-stdout>'
        )
      )
    ).toBe(null)
  })
})

describe('ClaudeCodeAdapter — hook output', () => {
  test('buildSpawnArgs asks the CLI for every hook event', () => {
    const { args } = claudeCodeAdapter.buildSpawnArgs({
      sessionId: 'abc',
      resume: false,
      cwd: '/tmp',
      providerFlags: []
    })
    expect(args).toContain('--include-hook-events')
  })

  test('chatui-hooks.ndjson: only hooks that changed something or told Claude something', () => {
    const events = parseFixture('chatui-hooks.ndjson')
    const hooks = events.filter((e) => e.kind === 'hook-output')
    expect(
      hooks.map((e) => (e.kind === 'hook-output' ? `${e.hookName}:${e.effect}:${e.audience}` : ''))
    ).toEqual([
      'SessionStart:startup:context:agent',
      'UserPromptSubmit:context:agent',
      'PreToolUse:Bash:blocked:agent',
      'PostToolUse:Bash:failed:user',
      'Stop:cancelled:user'
    ])
    expect(events.filter((e) => e.kind === 'notice')).toEqual([
      {
        kind: 'notice',
        id: '08f7314f-01bc-47d5-bd78-696fdf888fd4',
        level: 'notice',
        text: 'PostToolUse:Bash says: Formatter ran on 0 files'
      }
    ])
    // Quiet hooks (`{}` like SlayZone's notify.sh, hook_started) never become events.
    const hookUnknowns = events.filter(
      (e) =>
        e.kind === 'unknown' &&
        /^(hook_|informational)/.test(String((e.raw as { subtype?: unknown }).subtype))
    )
    expect(hookUnknowns).toEqual([])
  })

  test('hook_started / hook_progress → null', () => {
    for (const subtype of ['hook_started', 'hook_progress']) {
      const out = claudeCodeAdapter.parseLine(
        JSON.stringify({
          type: 'system',
          subtype,
          hook_id: 'x',
          hook_name: 'Stop',
          hook_event: 'Stop'
        })
      )
      expect(out).toBe(null)
    }
  })

  test('system/informational → notice', () => {
    expect(
      claudeCodeAdapter.parseLine(
        JSON.stringify({
          type: 'system',
          subtype: 'informational',
          content: 'PostToolUse:Bash says: hi',
          level: 'warning',
          uuid: 'n1',
          session_id: 's'
        })
      )
    ).toEqual({ kind: 'notice', id: 'n1', level: 'warning', text: 'PostToolUse:Bash says: hi' })
  })
})

describe('ClaudeCodeAdapter — token streaming + command tasks (plan 3.2 / 3.9)', () => {
  const base = { sessionId: 'abc', resume: false, cwd: '/tmp', providerFlags: [] }

  test('buildSpawnArgs always asks for partial messages (token streaming)', () => {
    expect(claudeCodeAdapter.buildSpawnArgs(base).args).toContain('--include-partial-messages')
    expect(claudeCodeAdapter.buildSpawnArgs({ ...base, resume: true }).args).toContain(
      '--include-partial-messages'
    )
  })

  test('summarized thinking only for a CLI known to accept the flag', () => {
    const at = (cliVersion?: string) => {
      const { args } = claudeCodeAdapter.buildSpawnArgs({ ...base, cliVersion })
      const i = args.indexOf('--thinking-display')
      return i < 0 ? null : args[i + 1]
    }
    expect(at('2.1.312')).toBe('summarized')
    expect(at('2.2.0')).toBe('summarized')
    // Older, unknown or unparseable: an unknown option would kill every spawn.
    expect(at('2.1.311')).toBe(null)
    expect(at(undefined)).toBe(null)
    expect(at('garbage')).toBe(null)
  })

  test('task_started → cli-task with every field the driver needs', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'task_started',
        task_id: 'b00m4bxr8',
        run_id: 'r1',
        tool_use_id: 'toolu_1',
        description: 'Print eight ticks',
        is_backgrounded: false,
        task_type: 'local_bash',
        parent_tool_use_id: 'toolu_parent',
        uuid: 'u1',
        session_id: 's'
      })
    )
    expect(ev).toMatchObject({
      kind: 'cli-task',
      subtype: 'started',
      taskId: 'b00m4bxr8',
      toolUseId: 'toolu_1',
      taskType: 'local_bash',
      description: 'Print eight ticks',
      backgrounded: false,
      parentToolUseId: 'toolu_parent'
    })
  })

  test('task_updated → cli-task with the patch (no tool_use_id on the wire)', () => {
    const killed = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'task_updated',
        task_id: 't1',
        run_id: 'r1',
        patch: { status: 'killed', end_time: 1793282446084 }
      })
    )
    expect(killed).toMatchObject({
      kind: 'cli-task',
      subtype: 'updated',
      taskId: 't1',
      status: 'killed',
      endTime: 1793282446084
    })
    expect(killed && 'toolUseId' in killed ? killed.toolUseId : undefined).toBeUndefined()
    const moved = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'task_updated',
        task_id: 't1',
        patch: { is_backgrounded: true }
      })
    )
    expect(moved).toMatchObject({ kind: 'cli-task', subtype: 'updated', backgrounded: true })
  })

  test('task_notification → cli-task with status, summary and usage', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'task_notification',
        task_id: 'a7',
        tool_use_id: 'tu_42',
        status: 'completed',
        output_file: '',
        summary: 'Find chat history parsing logic',
        usage: { total_tokens: 63119, tool_uses: 23, duration_ms: 52641 }
      })
    )
    expect(ev).toMatchObject({
      kind: 'cli-task',
      subtype: 'notification',
      taskId: 'a7',
      toolUseId: 'tu_42',
      status: 'completed',
      summary: 'Find chat history parsing logic',
      usage: { totalTokens: 63119, toolUses: 23, durationMs: 52641 }
    })
  })

  test('a task frame without task_id is a shape mismatch', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({ type: 'system', subtype: 'task_started', tool_use_id: 'x' })
    )
    expect(ev).toMatchObject({ kind: 'unknown', reason: 'shape-mismatch' })
  })

  test('background_tasks_changed → null (the list follows from the task_* frames)', () => {
    const ev = claudeCodeAdapter.parseLine(
      JSON.stringify({
        type: 'system',
        subtype: 'background_tasks_changed',
        tasks: [{ task_id: 't', run_id: 'r', task_type: 'local_bash', description: 'd' }]
      })
    )
    expect(ev).toBe(null)
  })
})
