// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { isSyntheticChatPrompt } from '@slayzone/terminal-contracts'
import { ContextMeter } from './ContextMeter'
import { CompactionRow } from './CompactionRow'
import { CommandOutputBlock, looksLikeMarkdown } from './CommandOutputBlock'
import { HookOutputRow } from './HookOutputRow'
import { NoticeRow } from './NoticeRow'
import type { TimelineItem } from '@slayzone/terminal/client'
import { PromptHistorySearch } from './PromptHistorySearch'
import { formatCost, formatTokens } from './usage-format'
import { PLAN_APPROVED_MARKER, PLAN_CANCELLED_MARKER } from './renderers'

afterEach(cleanup)

describe('usage formatting', () => {
  it('tokens: plain, k, M', () => {
    expect(formatTokens(950)).toBe('950')
    expect(formatTokens(6408)).toBe('6.4k')
    expect(formatTokens(49939)).toBe('50k')
    expect(formatTokens(1_000_000)).toBe('1M')
    expect(formatTokens(1_250_000)).toBe('1.3M')
  })
  it('cost: cents, sub-cent precision', () => {
    expect(formatCost(0.4213)).toBe('$0.42')
    expect(formatCost(0.0036)).toBe('$0.0036')
    expect(formatCost(0)).toBe('$0.00')
  })
})

describe('ContextMeter', () => {
  it('shows context %, tokens of window and session cost', () => {
    render(
      <ContextMeter
        summary={{ contextTokens: 49939, contextWindow: 1_000_000, sessionCostUsd: 0.4213 }}
      />
    )
    const meter = screen.getByTestId('chat-context-meter')
    expect(meter.textContent).toContain('5%')
    expect(meter.textContent).toContain('50k/1M')
    expect(meter.textContent).toContain('$0.42')
    expect(meter.getAttribute('title')).toContain('49,939 of 1,000,000 tokens')
  })

  it('renders only what is known', () => {
    const { rerender } = render(
      <ContextMeter summary={{ contextTokens: 1200, contextWindow: null, sessionCostUsd: null }} />
    )
    const meter = screen.getByTestId('chat-context-meter')
    expect(meter.textContent).toContain('1.2k tokens')
    expect(meter.textContent).not.toContain('$')
    rerender(
      <ContextMeter
        summary={{ contextTokens: null, contextWindow: 200_000, sessionCostUsd: 1.5 }}
      />
    )
    expect(screen.getByTestId('chat-context-meter').textContent).toBe('$1.50')
  })

  it('nothing reported (e.g. Codex) → nothing rendered', () => {
    const { container } = render(<ContextMeter summary={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('nearly full context is flagged', () => {
    render(
      <ContextMeter
        summary={{ contextTokens: 190_000, contextWindow: 200_000, sessionCostUsd: null }}
      />
    )
    expect(screen.getByTestId('chat-context-meter').className).toContain('text-destructive')
  })
})

describe('CompactionRow', () => {
  it('compacted → divider with trigger + previous size', () => {
    render(
      <CompactionRow
        item={{
          kind: 'compaction',
          outcome: 'compacted',
          trigger: 'auto',
          preTokens: 152_000,
          timestamp: 0
        }}
      />
    )
    const row = screen.getByRole('separator')
    expect(row.textContent).toContain('Conversation compacted automatically')
    expect(row.textContent).toContain('152k tokens')
  })

  it('failed → error with the CLI reason', () => {
    render(
      <CompactionRow
        item={{
          kind: 'compaction',
          outcome: 'failed',
          error: 'Not enough messages to compact.',
          timestamp: 0
        }}
      />
    )
    expect(screen.getByRole('alert').textContent).toContain(
      'Compaction failed: Not enough messages to compact.'
    )
  })
})

describe('CommandOutputBlock', () => {
  it('markdown output (/context) renders as markdown, with its table', () => {
    const text = '## Context Usage\n\n| Category | Tokens |\n|---|---|\n| Messages | 141 |\n'
    expect(looksLikeMarkdown(text)).toBe(true)
    const { container } = render(
      <CommandOutputBlock
        item={{ kind: 'command-output', id: 'c', command: 'context', text, timestamp: 0 }}
      />
    )
    expect(container.querySelector('table')).not.toBeNull()
    expect(screen.getByText('/context')).toBeTruthy()
  })

  it('plain output (/usage) keeps its line breaks and alignment', () => {
    const text = 'Current session: 17% used\n  96%  Start fresh when you switch tasks'
    expect(looksLikeMarkdown(text)).toBe(false)
    const { container } = render(
      <CommandOutputBlock
        item={{ kind: 'command-output', id: 'c', command: 'usage', text, timestamp: 0 }}
      />
    )
    const pre = container.querySelector('pre')
    expect(pre?.textContent).toBe(text)
  })

  it('a failed command (refused `!shell` line) renders as an alert with the reason', () => {
    const text = 'Shell command permission check failed: This command requires approval'
    render(
      <CommandOutputBlock
        item={{ kind: 'command-output', id: 'c', command: 'y', text, timestamp: 0, isError: true }}
      />
    )
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('/y failed')
    expect(alert.textContent).toContain(text)
  })
})

describe('HookOutputRow', () => {
  const hook = (
    over: Partial<Extract<TimelineItem, { kind: 'hook' }>>
  ): Extract<TimelineItem, { kind: 'hook' }> => ({
    kind: 'hook',
    hookId: 'h1',
    hookName: 'PreToolUse:Bash',
    hookEvent: 'PreToolUse',
    effect: 'blocked',
    audience: 'agent',
    text: 'Blocked by policy: never echo the word forbidden',
    exitCode: 2,
    timestamp: 0,
    ...over
  })

  it('a blocking hook says what it blocked, who was told, and shows its message', () => {
    render(<HookOutputRow item={hook({})} />)
    const row = screen.getByTestId('chat-hook-output')
    expect(row.getAttribute('data-effect')).toBe('blocked')
    expect(row.textContent).toContain('PreToolUse:Bash hook blocked the tool call')
    expect(row.textContent).toContain('Sent to Claude')
    expect(row.textContent).toContain('Blocked by policy: never echo the word forbidden')
  })

  it('a blocked prompt is only shown to the user', () => {
    render(
      <HookOutputRow
        item={hook({
          hookName: 'UserPromptSubmit',
          hookEvent: 'UserPromptSubmit',
          audience: 'user'
        })}
      />
    )
    const row = screen.getByTestId('chat-hook-output')
    expect(row.textContent).toContain('UserPromptSubmit hook blocked your message')
    expect(row.textContent).toContain('Shown only to you')
  })

  it('a failing hook shows its exit code and stderr', () => {
    render(
      <HookOutputRow
        item={hook({
          hookName: 'PostToolUse:Bash',
          hookEvent: 'PostToolUse',
          effect: 'failed',
          audience: 'user',
          text: 'post hook crashed: lint server unreachable',
          exitCode: 1
        })}
      />
    )
    const row = screen.getByTestId('chat-hook-output')
    expect(row.textContent).toContain('PostToolUse:Bash hook failed (exit 1)')
    expect(row.textContent).toContain('post hook crashed: lint server unreachable')
  })

  it('a timed-out hook says so', () => {
    render(
      <HookOutputRow
        item={hook({
          hookName: 'Stop',
          hookEvent: 'Stop',
          effect: 'cancelled',
          audience: 'user',
          text: ''
        })}
      />
    )
    expect(screen.getByTestId('chat-hook-output').textContent).toContain(
      'Stop hook timed out or was cancelled'
    )
  })

  it('context a hook added for Claude starts collapsed and opens on click', () => {
    render(
      <HookOutputRow
        item={hook({
          hookName: 'SessionStart:startup',
          hookEvent: 'SessionStart',
          effect: 'context',
          text: 'Project rule: prefer printf over echo.\nSecond line'
        })}
      />
    )
    const row = screen.getByTestId('chat-hook-output')
    expect(row.textContent).toContain(
      'SessionStart:startup hook added context for Claude · 2 lines'
    )
    expect(row.textContent).not.toContain('Project rule')
    fireEvent.click(screen.getByRole('button'))
    expect(row.textContent).toContain('Project rule: prefer printf over echo.')
  })
})

describe('NoticeRow', () => {
  it('shows the CLI notice with its level', () => {
    render(
      <NoticeRow
        item={{
          kind: 'notice',
          id: 'n1',
          level: 'notice',
          text: 'PostToolUse:Bash says: Formatter ran on 0 files',
          timestamp: 0
        }}
      />
    )
    const row = screen.getByTestId('chat-notice')
    expect(row.getAttribute('data-level')).toBe('notice')
    expect(row.textContent).toContain('PostToolUse:Bash says: Formatter ran on 0 files')
  })
})

describe('PromptHistorySearch', () => {
  const entries = ['Fix the AUTH bug', 'add tests', 'auth: refresh tokens']

  it('filters as you type; Enter picks the highlighted match', () => {
    const onPick = vi.fn()
    render(<PromptHistorySearch entries={entries} onPick={onPick} onClose={() => {}} />)
    const input = screen.getByRole('searchbox')
    fireEvent.change(input, { target: { value: 'auth' } })
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Fix the AUTH bug',
      'auth: refresh tokens'
    ])
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('Fix the AUTH bug')
  })

  it('Ctrl+R / ↓ move to an older match', () => {
    const onPick = vi.fn()
    render(<PromptHistorySearch entries={entries} onPick={onPick} onClose={() => {}} />)
    const input = screen.getByRole('searchbox')
    fireEvent.keyDown(input, { key: 'r', ctrlKey: true })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(onPick).toHaveBeenCalledWith('auth: refresh tokens')
  })

  it('Esc closes without picking and does not reach window listeners', () => {
    const onClose = vi.fn()
    const onWindowKey = vi.fn()
    window.addEventListener('keydown', onWindowKey)
    try {
      render(<PromptHistorySearch entries={entries} onPick={() => {}} onClose={onClose} />)
      fireEvent.keyDown(screen.getByRole('searchbox'), { key: 'Escape' })
    } finally {
      window.removeEventListener('keydown', onWindowKey)
    }
    expect(onClose).toHaveBeenCalled()
    expect(onWindowKey).not.toHaveBeenCalled()
  })

  it('no history → says so', () => {
    render(<PromptHistorySearch entries={[]} onPick={() => {}} onClose={() => {}} />)
    expect(screen.getByText('No matching prompts')).toBeTruthy()
  })
})

describe('plan markers', () => {
  it('are synthetic prompts (kept out of prompt history)', () => {
    expect(isSyntheticChatPrompt(PLAN_APPROVED_MARKER)).toBe(true)
    expect(isSyntheticChatPrompt(PLAN_CANCELLED_MARKER)).toBe(true)
  })
})
