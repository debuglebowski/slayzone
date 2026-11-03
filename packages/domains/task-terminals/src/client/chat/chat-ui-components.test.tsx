// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import type { ReactElement } from 'react'
import { TooltipProvider } from '@slayzone/ui'
import { isSyntheticChatPrompt } from '@slayzone/terminal-contracts'
import { ContextMeter, ContextMeterCard } from './ContextMeter'
import { CompactionRow } from './CompactionRow'
import { CommandOutputBlock, looksLikeMarkdown } from './CommandOutputBlock'
import { HookOutputRow } from './HookOutputRow'
import { NoticeRow } from './NoticeRow'
import { TurnTriggerRow } from './TurnTriggerRow'
import type { TimelineItem } from '@slayzone/terminal/client'
import { PromptHistorySearch } from './PromptHistorySearch'
import { formatCost, formatTokens } from './usage-format'
import { PLAN_APPROVED_MARKER, PLAN_CANCELLED_MARKER } from './renderers'

beforeAll(() => {
  // Radix tooltip content measures itself; jsdom has no layout.
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})
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

const renderMeter = (ui: ReactElement) => render(ui, { wrapper: TooltipProvider })

describe('ContextMeter', () => {
  it('shows context % only; tokens of window and session cost in its label', () => {
    renderMeter(
      <ContextMeter
        summary={{ contextTokens: 49939, contextWindow: 1_000_000, sessionCostUsd: 0.4213 }}
      />
    )
    const meter = screen.getByTestId('chat-context-meter')
    expect(meter.textContent).toBe('5%')
    expect(meter.getAttribute('aria-label')).toContain('49,939 of 1,000,000 tokens')
    expect(meter.getAttribute('aria-label')).toContain('Session cost: $0.4213')
  })

  it('renders only what is known', () => {
    const { rerender } = renderMeter(
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
    const { container } = renderMeter(<ContextMeter summary={null} />)
    expect(container.innerHTML).toBe('')
  })

  it('nearly full context is flagged', () => {
    renderMeter(
      <ContextMeter
        summary={{ contextTokens: 190_000, contextWindow: 200_000, sessionCostUsd: null }}
      />
    )
    expect(screen.getByTestId('chat-context-meter').className).toContain('text-destructive')
  })
})

describe('ContextMeterCard', () => {
  it('explains context window and cost in plain terms', () => {
    render(
      <ContextMeterCard
        summary={{ contextTokens: 382_192, contextWindow: 1_000_000, sessionCostUsd: 21.3178 }}
      />
    )
    const card = screen.getByTestId('chat-context-meter-card')
    expect(card.textContent).toContain('38% context used')
    expect(card.textContent).toContain('382k / 1M')
    expect(card.textContent).toContain('Session cost')
    expect(card.textContent).toContain('$21.32')
    expect(screen.getByTestId('chat-context-meter-bar').style.width).toBe('38.2192%')
    expect(screen.getByTestId('chat-context-meter-bar').className).toContain('bg-success')
    expect(card.textContent).not.toContain('summarized')
  })

  it('nearly full → warns about compaction', () => {
    render(
      <ContextMeterCard
        summary={{ contextTokens: 190_000, contextWindow: 200_000, sessionCostUsd: null }}
      />
    )
    const card = screen.getByTestId('chat-context-meter-card')
    expect(card.textContent).toContain('Almost full')
    expect(screen.getByTestId('chat-context-meter-bar').className).toContain('bg-destructive')
    expect(card.textContent).not.toContain('Session cost')
  })

  it('no window → token count without bar', () => {
    render(
      <ContextMeterCard
        summary={{ contextTokens: 1200, contextWindow: null, sessionCostUsd: null }}
      />
    )
    expect(screen.getByTestId('chat-context-meter-card').textContent).toContain('1.2k tokens')
    expect(screen.queryByTestId('chat-context-meter-bar')).toBeNull()
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

describe('TurnTriggerRow', () => {
  const trigger = (
    notifications: Extract<TimelineItem, { kind: 'turn-trigger' }>['notifications'],
    subAgents: Extract<TimelineItem, { kind: 'turn-trigger' }>['subAgents'] = []
  ) =>
    render(
      <TurnTriggerRow item={{ kind: 'turn-trigger', subAgents, notifications, timestamp: 1 }} />,
      { wrapper: TooltipProvider }
    )

  it('a line a watch printed: a card labelling the watch and the line', () => {
    trigger([
      {
        uuid: 'n1',
        taskId: 'bzdf0phch',
        summary: 'Monitor event: "demo-mode subtask"',
        event: 'status=in_progress | changed_files=6'
      }
    ])
    const card = screen.getByTestId('turn-trigger-notification')
    expect(card.textContent).toBe(
      'Watchdemo-mode subtaskPrintedstatus=in_progress | changed_files=6'
    )
    expect(screen.getByText('status=in_progress | changed_files=6').className).toContain(
      'font-mono'
    )
    expect(screen.queryByText('finished')).toBeNull()
  })

  it("a watch's expiry: a short 'stopped' pill; which watch on hover; never the CLI's text", async () => {
    trigger([
      {
        uuid: 'n1',
        taskId: 'b1',
        summary: 'Monitor event: "agent needs attention"',
        event:
          '[Monitor expired after 30m with 1 event delivered. Re-arm it if you still need the watch.]'
      }
    ])
    const pill = screen.getByTestId('turn-trigger-notification')
    expect(pill.textContent).toBe('Watch stopped · 30m limit')
    fireEvent.focus(pill)
    const tip = await screen.findByTestId('turn-trigger-notification-tooltip')
    expect(tip.textContent).toContain('Watch "agent needs attention"')
    expect(tip.textContent).toContain('Reached its 30m time limit and stopped after 1 update.')
    expect(tip.textContent).not.toContain('Re-arm')
  })

  it('sub-agents: one-line card each (✓ / ✕); a notification: its card', () => {
    trigger(
      [
        {
          uuid: 'n2',
          taskId: 'b2',
          toolUseId: 'tu_B',
          status: 'completed',
          summary: 'Background command "build" completed (exit code 0)'
        }
      ],
      [
        { toolUseId: 'tu_A', description: 'review' },
        { toolUseId: 'tu_C', description: 'trace', failed: true }
      ]
    )
    const cards = screen.getAllByTestId('turn-trigger-sub-agent')
    expect(cards.map((c) => c.textContent)).toEqual(['review', 'trace'])
    expect(within(cards[0]).getByRole('img', { name: 'Finished' })).toBeTruthy()
    expect(within(cards[1]).getByRole('img', { name: 'Failed' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'review' })).toBeTruthy()
    expect(screen.getByTestId('turn-trigger-notification').textContent).toBe(
      'TaskBackground command "build" completed (exit code 0)'
    )
  })
})
