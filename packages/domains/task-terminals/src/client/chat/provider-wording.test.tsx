// @vitest-environment jsdom
/**
 * Chat names the provider it talks to, never "Claude" on a Codex tab: the empty
 * state, the prompt dock, rows about the conversation, hook labels, the
 * agent-problem card and the app's slash commands (`/memory`, `/bug`, …).
 */
import type React from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { chatProviderForMode } from '@slayzone/terminal-contracts'
import type { ChatPrompt, TimelineItem } from '@slayzone/terminal/client'

vi.mock('@slayzone/markdown/client', () => ({
  GhMarkdown: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))
vi.mock('../trpc', () => ({
  useTRPC: () => ({}),
  useTRPCClient: () => ({
    app: { shell: { openPath: { mutate: vi.fn() }, openExternal: { mutate: vi.fn() } } }
  })
}))

const { ChatViewContext, defaultChatView } = await import('./ChatViewContext')
const { renderTimelineItem } = await import('./renderers')
const { PromptDock } = await import('./prompts/PromptDock')
const { EmptyState } = await import('./ChatTimeline')
const { hookLabel } = await import('./hook-labels')
const { builtinCommands } = await import('./autocomplete/builtins-registry')
const { AgentProblemCard } = await import('./AgentProblemCard')

const CODEX = chatProviderForMode('codex-chat')

function inCodex(node: React.ReactNode, over: Record<string, unknown> = {}) {
  return render(
    <ChatViewContext.Provider value={{ ...defaultChatView, provider: CODEX, ...over }}>
      {node}
    </ChatViewContext.Provider>
  )
}
const text = () => document.body.textContent ?? ''

afterEach(() => cleanup())

describe('Codex tab wording', () => {
  it('the empty state', () => {
    inCodex(<EmptyState onPick={() => {}} />)
    expect(text()).toContain('Chat with Codex')
    expect(text()).not.toContain('Claude')
  })

  it('the prompt dock header', () => {
    const request = {
      kind: 'permission-request' as const,
      requestId: '0',
      toolName: 'item/permissions/requestApproval',
      toolUseId: '',
      input: { permissions: {}, reason: 'needs network' }
    }
    const prompt: ChatPrompt = {
      ...request,
      request,
      status: 'pending',
      decision: null,
      optionId: null
    }
    inCodex(<PromptDock />, { promptCards: true, prompts: [prompt] })
    expect(screen.getByLabelText('Codex is waiting for your answer')).toBeTruthy()
    expect(text()).not.toContain('Claude')
  })

  it('a message the agent already had, a rewind divider', () => {
    inCodex(
      <>
        {renderTimelineItem(
          { kind: 'interrupted', reason: 'already-in-conversation', timestamp: 1 } as TimelineItem,
          'a'
        )}
        {renderTimelineItem(
          {
            kind: 'conversation-branch',
            id: 'b',
            reason: 'rewound',
            hiddenFrom: 0,
            hiddenCount: 0,
            timestamp: 1
          } as unknown as TimelineItem,
          'b'
        )}
      </>
    )
    expect(text()).toContain('Not run again: Codex already had this message')
    expect(text()).toContain('Rewound: Codex forgot what came after this point')
  })

  it('hook labels', () => {
    const base = { hookName: 'Guard', exitCode: undefined, text: 'x' }
    expect(hookLabel({ ...base, hookEvent: 'Stop', effect: 'stopped' }, 'Codex')).toBe(
      'Guard hook stopped Codex'
    )
    expect(hookLabel({ ...base, hookEvent: 'Stop', effect: 'blocked' }, 'Codex')).toBe(
      'Guard hook kept Codex working'
    )
    expect(hookLabel({ ...base, hookEvent: 'Stop', effect: 'context' }, 'Codex')).toBe(
      'Guard hook added context for Codex · 1 line'
    )
  })

  it('the agent-problem card names Codex', () => {
    inCodex(
      <AgentProblemCard
        item={
          {
            kind: 'agent-problem',
            code: 'cli-not-installed',
            binary: 'codex',
            timestamp: 1
          } as unknown as Extract<TimelineItem, { kind: 'agent-problem' }>
        }
      />
    )
    expect(text()).toContain("Codex isn't installed")
  })
})

describe('the app slash commands follow the provider', () => {
  const ctx = (mode: string) => {
    const openFile = vi.fn()
    const openExternal = vi.fn()
    const submit = vi.fn(async (_text: string) => {})
    return {
      openFile,
      openExternal,
      submit,
      ctx: {
        session: { mode, cwd: '/repo' },
        navigate: { openFile, openExternal, openSettings: vi.fn() },
        submit,
        toast: vi.fn(),
        setDraft: vi.fn()
      } as never
    }
  }
  const command = (name: string) => builtinCommands.find((b) => b.name === name)!

  it('/memory opens AGENTS.md for Codex, CLAUDE.md for Claude', async () => {
    const codex = ctx('codex-chat')
    await command('memory').run(codex.ctx)
    expect(codex.openFile).toHaveBeenCalledWith('/repo/AGENTS.md')
    const claude = ctx('claude-chat')
    await command('memory').run(claude.ctx)
    expect(claude.openFile).toHaveBeenCalledWith('/repo/CLAUDE.md')
  })

  it("/bug and /release-notes open the provider's pages", async () => {
    const codex = ctx('codex-chat')
    await command('bug').run(codex.ctx)
    await command('release-notes').run(codex.ctx)
    expect(codex.openExternal.mock.calls).toEqual([
      ['https://github.com/openai/codex/issues/new'],
      ['https://github.com/openai/codex/releases']
    ])
  })

  it('/init asks for the provider’s instructions file; no description names Claude', async () => {
    const codex = ctx('codex-chat')
    await command('init').run(codex.ctx)
    expect(codex.submit.mock.calls[0][0]).toContain('AGENTS.md')
    expect(codex.submit.mock.calls[0][0]).not.toContain('CLAUDE.md')
    for (const b of builtinCommands) expect(b.description).not.toMatch(/Claude/)
  })
})
