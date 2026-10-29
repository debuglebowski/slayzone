// @vitest-environment jsdom
// Shift+Tab cycles the permission modes of the panel's CURRENT terminal mode. A
// chat tab keeps its panel mounted across a provider switch (keyed by tab id),
// so a `mode` change alone must reach the listener.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, renderHook } from '@testing-library/react'
import { nextAgentMode, type AgentMode } from '@slayzone/ui'
import { chatModesForMode } from '@slayzone/terminal-contracts'
import { useChatPanelKeyboard, type UseChatPanelKeyboardOpts } from './useChatPanelKeyboard'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('useChatPanelKeyboard Shift+Tab', () => {
  it('cycles the modes of the current terminal mode', () => {
    const root = document.createElement('div')
    const input = document.createElement('input')
    root.appendChild(input)
    document.body.appendChild(root)
    input.focus()

    const handleModeChange = vi.fn(() => Promise.resolve())
    const chatMode = 'plan' as AgentMode
    const base: Omit<UseChatPanelKeyboardOpts, 'mode'> = {
      panelRef: { current: root },
      scrollRef: Object.assign(() => {}, { current: null }) as never,
      search: { requestOpen: () => {} },
      inFlight: false,
      chatMode,
      handleModeChange,
      autoCapability: { optedIn: false } as never,
      autocomplete: { show: false },
      handleStop: () => {}
    }
    const { rerender } = renderHook((o: UseChatPanelKeyboardOpts) => useChatPanelKeyboard(o), {
      initialProps: { ...base, mode: 'claude-chat' }
    })
    rerender({ ...base, mode: 'codex-chat' })

    const expected = nextAgentMode(chatMode, false, chatModesForMode('codex-chat') as AgentMode[])
    expect(expected).not.toBe(
      nextAgentMode(chatMode, false, chatModesForMode('claude-chat') as AgentMode[])
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true }))
    expect(handleModeChange).toHaveBeenCalledWith(expected)
  })
})
