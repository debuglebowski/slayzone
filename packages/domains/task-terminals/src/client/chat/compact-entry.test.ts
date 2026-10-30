/**
 * Compact is offered wherever the provider compacts on request (the `compact`
 * capability), not only where the CLI runs slash commands itself: the Cmd+K
 * Chat page's "Compact conversation" and `/compact` in the `/` menu. Codex
 * compacts on the text `/compact` (its driver), like Claude Code does.
 */
import { describe, expect, test, vi } from 'vitest'
import { chatCapabilitiesForMode } from '@slayzone/terminal-contracts'
import { availableBuiltins, builtinCommands } from './autocomplete/builtins-registry'
import { compactAction } from './palette/chat-palette-commands'

const codex = (compact: boolean) => ({ ...chatCapabilitiesForMode('codex-chat'), compact })

describe('Compact entry points', () => {
  test('Claude: the palette action sends /compact', () => {
    const send = vi.fn()
    compactAction(chatCapabilitiesForMode('claude-chat'), send)?.()
    expect(send).toHaveBeenCalledWith('/compact')
  })

  test('Codex with compaction: the palette action sends /compact', () => {
    const send = vi.fn()
    const action = compactAction(codex(true), send)
    expect(action).toBeDefined()
    action?.()
    expect(send).toHaveBeenCalledWith('/compact')
  })

  test('a provider without compaction gets no Compact action', () => {
    expect(compactAction(codex(false), vi.fn())).toBeUndefined()
  })

  test('the / menu offers /compact to Codex (no CLI command list); the CLI’s own wins for Claude', () => {
    const names = (caps: ReturnType<typeof codex>, cli: string[] = []) =>
      availableBuiltins({ capabilities: caps, cliCommandNames: new Set(cli) }).map((b) => b.name)
    expect(names(codex(true))).toContain('compact')
    expect(names(codex(false))).not.toContain('compact')
    expect(
      names({ ...chatCapabilitiesForMode('claude-chat') }, ['compact', 'context'])
    ).not.toContain('compact')
  })

  test('/compact submits the command like the user typed it', async () => {
    const submit = vi.fn(async (_text: string) => {})
    await builtinCommands.find((b) => b.name === 'compact')!.run({ submit } as never)
    expect(submit).toHaveBeenCalledWith('/compact')
  })
})
