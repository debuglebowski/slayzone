/**
 * Prompt capture on the computer (robustness plan §9, P0; hub migration v207): a
 * terminal agent's UserPromptSubmit hook lands in the task's prompt history, read back
 * per mode, without deleted sessions' prompts, bounded to the recall limit.
 *
 * Ported from agent-turns' prompt-capture / chat-prompt-recorder suites (removed in
 * 7d25d823c; review 2, Area 6) to the computer store that replaced them.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  agentHookPrompt,
  isPromptCaptureMode,
  type ResolvedAgentHook
} from '@slayzone/terminal-contracts'
import { createLocalPrompts, storePrompt } from './prompts'
import { openChatStorage } from './storage'

const roots: string[] = []
const stores: Array<ReturnType<typeof openChatStorage>> = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function open() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'slz-prompts-')))
  roots.push(dir)
  const s = openChatStorage({ stateDir: dir, hubScope: 'hub' })
  stores.push(s)
  return s
}

const T = 't'
const hook = (over: Partial<ResolvedAgentHook> & { raw?: unknown }): ResolvedAgentHook => ({
  agentId: 'claude-code',
  mode: 'claude-code',
  hookEvent: 'UserPromptSubmit',
  taskId: T,
  ...over
})
const texts = (rows: Array<{ text: string }>) => rows.map((r) => r.text)

describe('agentHookPrompt: which hook carries a prompt, and where its text is', () => {
  test('reads raw.prompt, then the common fallbacks in order', () => {
    expect(agentHookPrompt(hook({ raw: { prompt: 'fix the auth bug' } }))).toBe('fix the auth bug')
    for (const key of ['user_prompt', 'userPrompt', 'message', 'input', 'text'])
      expect([key, agentHookPrompt(hook({ raw: { [key]: `via ${key}` } }))]).toEqual([
        key,
        `via ${key}`
      ])
    // A blank earlier field falls through to the next one.
    expect(agentHookPrompt(hook({ raw: { prompt: '  ', message: 'hi there' } }))).toBe('hi there')
    expect(agentHookPrompt(hook({ raw: { prompt: 'first', message: 'second' } }))).toBe('first')
  })

  test('null when there is no usable text', () => {
    expect(agentHookPrompt(hook({ raw: { foo: 1 } }))).toBeNull()
    expect(agentHookPrompt(hook({ raw: null }))).toBeNull()
    expect(agentHookPrompt(hook({ raw: ['prompt'] }))).toBeNull()
    expect(agentHookPrompt(hook({ raw: { prompt: '   ' } }))).toBeNull()
    expect(agentHookPrompt(hook({ raw: { prompt: 42 } }))).toBeNull()
  })

  test('only UserPromptSubmit (any spelling) carries one', () => {
    for (const hookEvent of ['UserPromptSubmit', 'user_prompt_submit', 'user-prompt-submit'])
      expect(agentHookPrompt(hook({ hookEvent, raw: { prompt: 'p' } }))).toBe('p')
    for (const hookEvent of ['PreToolUse', 'Stop', 'SessionStart'])
      expect(agentHookPrompt(hook({ hookEvent, raw: { prompt: 'tool input' } }))).toBeNull()
  })

  test('capture modes: only agents whose hook carries the prompt', () => {
    for (const mode of ['claude-code', 'codex', 'gemini', 'opencode'])
      expect([mode, isPromptCaptureMode(mode)]).toEqual([mode, true])
    for (const mode of ['antigravity', 'cursor-agent', 'claude-chat', 'codex-chat', 'terminal'])
      expect([mode, isPromptCaptureMode(mode)]).toEqual([mode, false])
  })
})

describe('capture', () => {
  test('stores a UserPromptSubmit prompt under the hook mode and its session', () => {
    const prompts = createLocalPrompts(open())
    prompts.capture(hook({ sessionId: 'cli-1', raw: { prompt: 'hello world' } }))
    expect(prompts.list(T, 'claude-code')).toEqual([
      expect.objectContaining({
        task_id: T,
        agent_id: 'claude-code',
        cli_session_id: 'cli-1',
        text: 'hello world'
      })
    ])
  })

  test('nothing for other events, non-capture agents, no task or no text', () => {
    const prompts = createLocalPrompts(open())
    prompts.capture(hook({ hookEvent: 'PreToolUse', raw: { prompt: 'tool input' } }))
    prompts.capture(hook({ agentId: 'antigravity', mode: 'antigravity', raw: { prompt: 'nope' } }))
    prompts.capture(hook({ taskId: undefined, raw: { prompt: 'no task' } }))
    prompts.capture(hook({ raw: {} }))
    expect(prompts.list(T)).toEqual([])
  })

  test('a user-defined mode wrapping a capture agent is captured under that mode', () => {
    const prompts = createLocalPrompts(open())
    prompts.capture(hook({ mode: 'my-claude', raw: { prompt: 'custom' } }))
    expect(texts(prompts.list(T, 'my-claude'))).toEqual(['custom'])
    expect(prompts.list(T, 'claude-code')).toEqual([])
  })
})

describe('list', () => {
  const at = (
    store: ReturnType<typeof open>,
    id: string,
    agentId: string,
    text: string,
    n: number,
    cliSessionId: string | null = null
  ) => storePrompt(store, { id, taskId: T, agentId, cliSessionId, text, createdAt: n })

  test('per mode (the main agent filter), oldest first; without a mode every agent', () => {
    const store = open()
    at(store, 'b', 'codex', 'second', 2000)
    at(store, 'a', 'codex', 'first', 1000)
    at(store, 'c', 'claude-code', 'for claude', 1500)
    const prompts = createLocalPrompts(store)
    expect(texts(prompts.list(T, 'codex'))).toEqual(['first', 'second'])
    expect(texts(prompts.list(T, 'claude-code'))).toEqual(['for claude'])
    expect(texts(prompts.list(T))).toEqual(['first', 'for claude', 'second'])
    expect(prompts.list('other-task')).toEqual([])
  })

  test("a deleted session's prompts are hidden in its mode only; unattributed ones stay", () => {
    const store = open()
    at(store, '1', 'claude-code', 'from the deleted session', 1, 'conv-old')
    at(store, '2', 'claude-code', 'from the live session', 2, 'conv-live')
    at(store, '3', 'claude-code', 'no session id', 3, null)
    at(store, '4', 'codex', 'same id, other mode', 4, 'conv-old')
    const prompts = createLocalPrompts(store)
    const excluded = [{ mode: 'claude-code', conversationId: 'conv-old' }]
    expect(texts(prompts.list(T, 'claude-code', excluded))).toEqual([
      'from the live session',
      'no session id'
    ])
    expect(texts(prompts.list(T, 'codex', excluded))).toEqual(['same id, other mode'])
    expect(texts(prompts.list(T, undefined, excluded))).toEqual([
      'from the live session',
      'no session id',
      'same id, other mode'
    ])
  })

  test('the recall list keeps the newest 500 prompts per mode; other modes untouched', () => {
    const store = open()
    for (let i = 0; i < 501; i++) at(store, `c${i}`, 'claude-code', `p${i}`, i + 1)
    at(store, 'x', 'codex', 'codex prompt', 0)
    const prompts = createLocalPrompts(store)
    const kept = prompts.list(T, 'claude-code')
    expect(kept).toHaveLength(500)
    expect(kept[0].text).toBe('p1')
    expect(kept.at(-1)!.text).toBe('p500')
    expect(texts(prompts.list(T, 'codex'))).toEqual(['codex prompt'])
  })
})
