/**
 * A long Claude Code chat session, generated: the events a session's
 * `chat_events` rows hold (what a chat tab hydrates from), deterministic for a
 * seed. Used by the chat perf budget (`task-terminals/.../chat/__perf__`) and
 * the long-session e2e specs — a 10,000-event conversation without a
 * multi-megabyte committed fixture.
 *
 * Shapes follow the recorded CLI fixtures (`terminal/test/fixtures/claude-stream`):
 * a `turn-init` per turn, thinking, markdown replies with code, Read / Edit /
 * Bash / Grep / TodoWrite calls with the structured results the tool cards
 * parse, the odd failed command, sub-agents (a `Task` call, its `sub-agent`
 * frames and nested output) and a `result` per turn. Typed by `AgentEvent`, so a
 * contract change breaks the build here, not silently in a budget.
 *
 * `provider: 'codex'` builds a Codex chat session instead: the events its driver
 * saves (`codex-chat-session.ts`) — one handshake `turn-init`, delivery states,
 * plans, `codex/commandExecution` and `codex/fileChange` calls whose results
 * carry the thread item, and Codex's `result`.
 */
import type { AgentEvent } from '@slayzone/terminal-contracts'

export const LONG_SESSION_EVENTS = 10_000

export interface LongSessionOpts {
  /** Exactly this many events (default 10,000). */
  events?: number
  seed?: number
  /** Whose session (default Claude Code, unchanged by the Codex mode). */
  provider?: 'claude' | 'codex'
  /**
   * A permission mode that asks for every tool call: each call is followed by
   * its `permission-request` and (for 9 in 10) the `permission-resolved` — the
   * rest are resolved by their `tool-result` alone, as older logs are.
   */
  askEveryTool?: boolean
}

/** `events` with a prompt after every tool call (see `askEveryTool`); `asked` counts the session's. */
function withAsks(events: AgentEvent[], asked: { n: number }): AgentEvent[] {
  return events.flatMap((e): AgentEvent[] => {
    if (e.kind !== 'tool-call') return [e]
    const requestId = `req-${e.id}`
    const out: AgentEvent[] = [
      e,
      { kind: 'permission-request', requestId, toolName: e.name, toolUseId: e.id, input: e.input }
    ]
    if (asked.n++ % 10 !== 9) {
      out.push({
        kind: 'permission-resolved',
        requestId,
        decision: { behavior: 'allow' },
        optionId: 'yes'
      })
    }
    return out
  })
}

/** mulberry32: small, fast, good enough for test data. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const WORDS = (
  'the chat timeline renders every event a session saved and keeps long ' +
  'conversations smooth while the agent reads files runs commands edits code ' +
  'and explains what changed in the reducer the transport the outbox and the ' +
  'virtual list measures each row so scrolling stays fast even with thousands ' +
  'of turns search finds matches in rows that are not mounted yet'
).split(' ')

const USAGE = {
  inputTokens: 1200,
  outputTokens: 300,
  cacheReadInputTokens: 900,
  cacheCreationInputTokens: 0
}

export function buildLongSession(opts: LongSessionOpts = {}): AgentEvent[] {
  const target = opts.events ?? LONG_SESSION_EVENTS
  const rand = prng(opts.seed ?? 1)
  const int = (min: number, max: number) => min + Math.floor(rand() * (max - min + 1))
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]
  const sentence = (n: number) => {
    const words = Array.from({ length: n }, () => pick(WORDS))
    const s = words.join(' ')
    return s.charAt(0).toUpperCase() + s.slice(1) + '.'
  }
  const paragraph = () => Array.from({ length: int(1, 4) }, () => sentence(int(6, 18))).join(' ')
  const code = (lines: number) =>
    Array.from({ length: lines }, (_, i) => `  const v${i} = compute(${i}, '${pick(WORDS)}')`).join(
      '\n'
    )
  const markdown = () => {
    const parts = [paragraph()]
    if (rand() < 0.5)
      parts.push(Array.from({ length: int(2, 5) }, () => `- ${sentence(int(4, 10))}`).join('\n'))
    if (rand() < 0.35) parts.push('```ts\nfunction step() {\n' + code(int(3, 24)) + '\n}\n```')
    if (rand() < 0.3) parts.push(`### ${sentence(3)}\n\n${paragraph()}`)
    return parts.join('\n\n')
  }

  const events: AgentEvent[] = []
  const result = (text: string): AgentEvent => ({
    kind: 'result',
    subtype: 'success',
    isError: false,
    durationMs: int(800, 60_000),
    durationApiMs: int(500, 50_000),
    numTurns: int(1, 12),
    totalCostUsd: 0,
    stopReason: 'end_turn',
    terminalReason: null,
    text,
    modelUsage: {},
    usage: USAGE,
    permissionDenials: []
  })
  const init = (): AgentEvent => ({
    kind: 'turn-init',
    sessionId: 'long-session',
    model: 'claude-sonnet-4-5',
    cwd: '/repo',
    tools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob', 'TodoWrite', 'Task']
  })

  const tool = (turn: number, k: number, parent?: string): AgentEvent[] => {
    const id = `toolu_${turn}_${k}`
    const p = parent ? { parentToolUseId: parent } : {}
    const file = `/repo/src/module-${int(1, 80)}.ts`
    switch (pick(['Read', 'Edit', 'Bash', 'Bash', 'Grep', 'TodoWrite'] as const)) {
      case 'Read': {
        const content = code(int(5, 40))
        return [
          { kind: 'tool-call', id, name: 'Read', input: { file_path: file }, ...p },
          {
            kind: 'tool-result',
            toolUseId: id,
            isError: false,
            rawContent: content,
            structured: {
              type: 'text',
              file: {
                filePath: file,
                content,
                numLines: content.split('\n').length,
                startLine: 1,
                totalLines: 400
              }
            },
            ...p
          }
        ]
      }
      case 'Edit': {
        const oldString = `compute(${k}, 'a')`
        const newString = `compute(${k}, 'b')`
        return [
          {
            kind: 'tool-call',
            id,
            name: 'Edit',
            input: { file_path: file, old_string: oldString, new_string: newString },
            ...p
          },
          {
            kind: 'tool-result',
            toolUseId: id,
            isError: false,
            rawContent: `The file ${file} has been updated.`,
            structured: {
              filePath: file,
              oldString,
              newString,
              originalFile: `const v = ${oldString}\n`,
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: [`-const v = ${oldString}`, `+const v = ${newString}`]
                }
              ],
              userModified: false,
              replaceAll: false
            },
            ...p
          }
        ]
      }
      case 'Bash': {
        const failed = rand() < 0.08
        const stdout = Array.from({ length: int(1, 30) }, (_, i) => `ok ${i} ${pick(WORDS)}`).join(
          '\n'
        )
        return [
          {
            kind: 'tool-call',
            id,
            name: 'Bash',
            input: { command: `pnpm test -- ${pick(WORDS)}`, description: sentence(4) },
            ...p
          },
          {
            kind: 'tool-result',
            toolUseId: id,
            isError: failed,
            rawContent: failed ? `Exit code 1\n${stdout}` : stdout,
            structured: {
              stdout,
              stderr: failed ? 'Error: failed' : '',
              interrupted: false,
              isImage: false,
              noOutputExpected: false
            },
            ...p
          }
        ]
      }
      case 'Grep': {
        const filenames = Array.from({ length: int(1, 6) }, () => `src/module-${int(1, 80)}.ts`)
        return [
          {
            kind: 'tool-call',
            id,
            name: 'Grep',
            input: { pattern: pick(WORDS), output_mode: 'files_with_matches' },
            ...p
          },
          {
            kind: 'tool-result',
            toolUseId: id,
            isError: false,
            rawContent: filenames.join('\n'),
            structured: { mode: 'files_with_matches', filenames, numFiles: filenames.length },
            ...p
          }
        ]
      }
      default: {
        const todos = Array.from({ length: int(2, 5) }, (_, i) => ({
          content: sentence(3),
          activeForm: sentence(2),
          status: i === 0 ? 'in_progress' : 'pending'
        }))
        return [
          { kind: 'tool-call', id, name: 'TodoWrite', input: { todos }, ...p },
          {
            kind: 'tool-result',
            toolUseId: id,
            isError: false,
            rawContent: 'Todos have been modified successfully.',
            structured: { oldTodos: [], newTodos: todos, verificationNudgeNeeded: false },
            ...p
          }
        ]
      }
    }
  }

  const subAgent = (turn: number): AgentEvent[] => {
    const id = `toolu_${turn}_task`
    const description = sentence(4)
    const out: AgentEvent[] = [
      {
        kind: 'tool-call',
        id,
        name: 'Task',
        input: { description, prompt: paragraph(), subagent_type: 'general-purpose' }
      },
      { kind: 'sub-agent', phase: 'in-flight', toolUseId: id, description, raw: null }
    ]
    for (let k = 0; k < int(1, 3); k++) out.push(...tool(turn, 100 + k, id))
    out.push(
      { kind: 'assistant-text', messageId: `m${turn}_sub`, text: paragraph(), parentToolUseId: id },
      {
        kind: 'sub-agent',
        phase: 'in-flight',
        toolUseId: id,
        description,
        status: 'completed',
        summary: sentence(6),
        usage: {
          totalTokens: int(2_000, 40_000),
          toolUses: int(1, 9),
          durationMs: int(2_000, 90_000)
        },
        raw: null
      },
      {
        kind: 'tool-result',
        toolUseId: id,
        isError: false,
        rawContent: paragraph(),
        structured: null
      }
    )
    return out
  }

  const turnEvents = (turn: number): AgentEvent[] => {
    const out: AgentEvent[] = [
      {
        kind: 'user-message',
        id: `u${turn}`,
        text: rand() < 0.2 ? `${sentence(int(4, 9))}\n\n${paragraph()}` : sentence(int(4, 14))
      },
      init()
    ]
    let block = 0
    if (rand() < 0.6) {
      out.push({
        kind: 'assistant-thinking',
        messageId: `m${turn}_${block++}`,
        text: paragraph(),
        hasSignature: true,
        usage: USAGE
      })
    }
    const steps = int(0, 6)
    for (let k = 0; k < steps; k++) {
      if (rand() < 0.4)
        out.push({
          kind: 'assistant-text',
          messageId: `m${turn}_${block++}`,
          text: paragraph(),
          usage: USAGE
        })
      out.push(...tool(turn, k))
    }
    if (rand() < 0.08) out.push(...subAgent(turn))
    const reply = markdown()
    out.push({
      kind: 'assistant-text',
      messageId: `m${turn}_${block++}`,
      text: reply,
      usage: USAGE
    })
    out.push(result(reply))
    return out
  }

  const codexTurn = (turn: number): AgentEvent[] => {
    const id = `u${turn}`
    const out: AgentEvent[] = [
      { kind: 'user-message', id, text: sentence(int(4, 14)) },
      { kind: 'user-message-delivery', id, state: 'delivered' }
    ]
    if (rand() < 0.3) {
      out.push({
        kind: 'agent-plan',
        ...(rand() < 0.5 ? { explanation: sentence(6) } : {}),
        steps: Array.from({ length: int(2, 5) }, (_, i) => ({
          step: sentence(int(3, 7)),
          status: i === 0 ? ('completed' as const) : ('pending' as const)
        }))
      })
    }
    let block = 0
    const steps = int(0, 6)
    for (let k = 0; k < steps; k++) {
      if (rand() < 0.4)
        out.push({ kind: 'assistant-text', messageId: `msg_${turn}_${block++}`, text: paragraph() })
      const callId = `call_${turn}_${k}`
      if (rand() < 0.7) {
        const failed = rand() < 0.08
        const output = Array.from({ length: int(1, 30) }, (_, i) => `ok ${i} ${pick(WORDS)}`).join(
          '\n'
        )
        const command = `pnpm test -- ${pick(WORDS)}`
        out.push(
          {
            kind: 'tool-call',
            id: callId,
            name: 'codex/commandExecution',
            input: { command, cwd: '/repo' }
          },
          {
            kind: 'tool-result',
            toolUseId: callId,
            isError: failed,
            rawContent: output,
            structured: {
              type: 'commandExecution',
              id: callId,
              command,
              cwd: '/repo',
              status: failed ? 'failed' : 'completed',
              aggregatedOutput: output,
              exitCode: failed ? 1 : 0
            }
          }
        )
      } else {
        const changes = [
          {
            path: `/repo/src/module-${int(1, 80)}.ts`,
            kind: { type: 'update' },
            diff: `@@ -1 +1 @@\n-compute(${k}, 'a')\n+compute(${k}, 'b')\n`
          }
        ]
        out.push(
          { kind: 'tool-call', id: callId, name: 'codex/fileChange', input: { changes } },
          {
            kind: 'tool-result',
            toolUseId: callId,
            isError: false,
            rawContent: '',
            structured: { type: 'fileChange', id: callId, changes, status: 'completed' }
          }
        )
      }
    }
    out.push(
      { kind: 'assistant-text', messageId: `msg_${turn}_${block++}`, text: markdown() },
      { kind: 'user-message-delivery', id, state: 'answered' },
      {
        kind: 'result',
        subtype: 'completed',
        isError: false,
        durationMs: int(800, 60_000),
        durationApiMs: int(800, 60_000),
        numTurns: 1,
        totalCostUsd: 0,
        stopReason: null,
        terminalReason: null,
        text: null,
        modelUsage: {},
        usage: USAGE,
        permissionDenials: []
      }
    )
    return out
  }

  const asked = { n: 0 }
  if (opts.provider === 'codex') {
    // Codex's handshake: one synthetic turn-init per process, not one per turn.
    events.push({
      kind: 'turn-init',
      sessionId: 'codex-thread',
      model: 'gpt-5.5',
      cwd: '/repo',
      tools: []
    })
    for (let turn = 0; events.length < target; turn++) {
      const turnOut = codexTurn(turn)
      events.push(...(opts.askEveryTool ? withAsks(turnOut, asked) : turnOut))
    }
  } else {
    for (let turn = 0; events.length < target; turn++) {
      const turnOut = turnEvents(turn)
      events.push(...(opts.askEveryTool ? withAsks(turnOut, asked) : turnOut))
    }
  }

  // Exactly `target` events, ending on a whole turn: cut back to the last
  // result that fits, then one last turn (prompt, replies, result) fills the rest.
  // (The last turn needs 3 events: never 1–2 left, which would be output no
  // turn opened.)
  let end = target
  const fits = (at: number) =>
    events[at - 1].kind === 'result' && (target - at === 0 || target - at >= 3)
  while (end > 0 && !fits(end)) end--
  const out = events.slice(0, end)
  const remaining = target - out.length
  if (remaining > 0) {
    out.push({ kind: 'user-message', id: 'u-last', text: 'And the last question?' })
    for (let k = 0; k < remaining - 2; k++) {
      out.push({
        kind: 'assistant-text',
        messageId: `m-last_${k}`,
        text: paragraph(),
        usage: USAGE
      })
    }
    out.push(result('The last answer.'))
  }
  return out
}
