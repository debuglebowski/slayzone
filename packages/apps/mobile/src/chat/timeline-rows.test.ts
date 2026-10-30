import type { AgentEvent } from '@slayzone/terminal-contracts'
import { initialState, reducer, type ToolInvocation } from '@slayzone/terminal/reducer'
import {
  branchLabel,
  branchToggleLabel,
  agentProblemText,
  formatAge,
  interruptedLabel,
  resultText,
  subAgentItems,
  timelineRows,
  toolBody,
  toolSummary
} from './timeline-rows'

const run = (events: AgentEvent[]) =>
  events.reduce((s, event) => reducer(s, { type: 'event', event }), initialState())

const inv = (fields: Partial<ToolInvocation>): ToolInvocation => ({
  id: 't',
  name: 'Bash',
  input: {},
  status: 'done',
  ...fields
})

describe('timelineRows', () => {
  it("shows the root items desktop shows, sub-agents' own items inside their row", () => {
    const state = run([
      {
        kind: 'turn-init',
        sessionId: 's',
        model: 'm',
        cwd: '/w',
        tools: []
      },
      { kind: 'user-message', id: 'u1', text: 'hi' },
      { kind: 'tool-call', id: 'agent-1', name: 'Agent', input: { description: 'look' } },
      {
        kind: 'sub-agent',
        toolUseId: 'agent-1',
        phase: 'in-flight',
        description: 'look'
      } as AgentEvent,
      { kind: 'assistant-text', messageId: 'sub', text: 'inside', parentToolUseId: 'agent-1' },
      { kind: 'assistant-text', messageId: 'm1', text: 'done' }
    ])
    const rows = timelineRows(state.timeline)
    expect(rows.map((r) => r.item.kind)).toEqual(['user-text', 'sub-agent', 'text'])
    expect(rows[0].key).toBe('user:u1')
    expect(subAgentItems(state, 'agent-1').map((i) => i.kind)).toContain('text')
  })

  it('keeps a streaming row under one key from first fragment to final text', () => {
    const streaming = [
      { kind: 'user-message', id: 'u1', text: 'hi' },
      { kind: 'stream-message-start', messageId: 'm1' },
      { kind: 'stream-block-start', blockIndex: 0, blockType: 'text' },
      { kind: 'stream-block-delta', blockIndex: 0, deltaType: 'text', text: 'Hel' }
    ] as AgentEvent[]
    const live = run(streaming)
    const final = run([...streaming, { kind: 'assistant-text', messageId: 'm1', text: 'Hello' }])
    const key = (s: typeof live) =>
      timelineRows(s.timeline).find((r) => r.item.kind === 'text')?.key
    expect(key(live)).toBe('text:m1:0')
    expect(key(final)).toBe(key(live))
  })
})

describe('conversation branches (rewind / fork / switch, desktop `useChatDisplay` folds)', () => {
  const done = {
    kind: 'result',
    subtype: 'success',
    isError: false,
    durationMs: 1000,
    durationApiMs: 900,
    numTurns: 1,
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
  } as AgentEvent
  // Two answered turns, then the second message is rewound (edit & resend from desktop).
  const rewound = run([
    { kind: 'user-message', id: 'u1', text: 'first' },
    { kind: 'assistant-text', messageId: 'm1', text: 'answer one' },
    done,
    { kind: 'user-message', id: 'u2', text: 'second' },
    { kind: 'assistant-text', messageId: 'm2', text: 'answer two' },
    done,
    { kind: 'conversation-branch', reason: 'rewound', messageId: 'u2' }
  ])
  const texts = (open?: ReadonlySet<string>) =>
    timelineRows(rewound.timeline, open).map((r) =>
      r.item.kind === 'user-text' || r.item.kind === 'text' ? r.item.text : r.item.kind
    )

  it('folds what the conversation no longer holds behind the divider', () => {
    expect(texts()).toEqual(['first', 'answer one', 'result', 'conversation-branch'])
  })

  it('shows the folded rows again once the divider is opened', () => {
    const branch = timelineRows(rewound.timeline).at(-1)
    expect(branch?.key).toBe(branch?.item.kind === 'conversation-branch' ? branch.item.id : null)
    expect(texts(new Set([branch?.key as string]))).toEqual([
      'first',
      'answer one',
      'result',
      'second',
      'answer two',
      'result',
      'conversation-branch'
    ])
  })

  it("says what happened and what is folded, in desktop's words", () => {
    const item = rewound.timeline.at(-1)
    if (item?.kind !== 'conversation-branch') throw new Error('no branch item')
    expect(branchLabel(item)).toBe('Rewound: Claude forgot what came after this point')
    expect(branchToggleLabel(item, false)).toBe('Show rewound (3)')
    expect(branchToggleLabel(item, true)).toBe('Hide rewound')
    const switched = { ...item, reason: 'switched' as const, source: 'terminal' as const }
    expect(branchLabel(switched)).toBe('Continued from the terminal')
    expect(branchToggleLabel(switched, false)).toBe('Show previous conversation (3)')
    expect(branchLabel({ ...item, reason: 'forked' })).toBe('Forked into a new conversation')
    expect(branchToggleLabel({ ...item, hiddenCount: 0 }, false)).toBeNull()
  })

  it('names a turn Claude Code did not run again', () => {
    expect(interruptedLabel({ kind: 'interrupted', timestamp: 0 })).toBe('Turn interrupted')
    expect(
      interruptedLabel({ kind: 'interrupted', timestamp: 0, reason: 'already-in-conversation' })
    ).toBe('Not run again: Claude Code already had this message')
  })
})

describe('tool cards', () => {
  it('summarizes the call in one line', () => {
    expect(toolSummary(inv({ name: 'Bash', input: { command: 'ls -la' } }))).toEqual({
      title: 'Bash',
      summary: 'ls -la'
    })
    expect(
      toolSummary(inv({ name: 'Read', input: { file_path: '/a/b/c/x.ts', limit: 10 } })).summary
    ).toBe('c/x.ts · L1–10')
    expect(toolSummary(inv({ name: 'mcp__github__get_issue' })).title).toBe('github — get_issue')
  })

  it('shows an edit as removed and added lines, a command with its output', () => {
    expect(toolBody(inv({ name: 'Edit', input: { old_string: 'a', new_string: 'b\nc' } }))).toEqual(
      {
        type: 'diff',
        lines: [
          { sign: '-', text: 'a' },
          { sign: '+', text: 'b' },
          { sign: '+', text: 'c' }
        ]
      }
    )
    const bash = inv({
      name: 'Bash',
      input: { command: 'echo hi' },
      result: { rawContent: [{ type: 'text', text: 'hi' }], structured: null, isError: false }
    })
    expect(resultText(bash)).toBe('hi')
    expect(toolBody(bash)).toEqual({ type: 'text', text: '$ echo hi\nhi' })
  })

  it("formats a job's age like desktop's banner", () => {
    expect(formatAge(42_000)).toBe('42s')
    expect(formatAge(3 * 60_000)).toBe('3m')
    expect(formatAge(2 * 3_600_000)).toBe('2h')
  })
})

describe('agentProblemText (desktop `AgentProblemCard`)', () => {
  const item = (code: string, binary?: string) =>
    ({
      kind: 'agent-problem',
      code,
      message: 'm',
      timestamp: 0,
      ...(binary ? { binary } : {})
    }) as const

  it("names the product that isn't installed and how to fix it", () => {
    expect(agentProblemText(item('cli-not-installed', 'codex'))).toEqual({
      title: "Codex isn't installed",
      hint: "Install Codex on the computer this task runs on (it must be on that computer's PATH), then retry.",
      inUse: false
    })
  })

  it('says the terminal runs the conversation', () => {
    expect(agentProblemText(item('conversation-in-use'))).toEqual({
      title: 'This conversation is running in the terminal',
      hint: 'One conversation runs in one place at a time. Continue it here (the terminal stops first), or stop it there and retry.',
      inUse: true
    })
  })

  it('falls back to a plain failure', () => {
    expect(agentProblemText(item('spawn-failed'))).toEqual({
      title: "The agent couldn't start",
      hint: 'Fix the cause below, then retry.',
      inUse: false
    })
  })
})
