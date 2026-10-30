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

describe('useChatPanelKeyboard with a pending prompt', () => {
  function setup(promptHandler: (e: KeyboardEvent) => boolean) {
    const root = document.createElement('div')
    const composer = document.createElement('textarea')
    root.appendChild(composer)
    document.body.appendChild(root)
    composer.focus()
    const handleStop = vi.fn()
    const handleModeChange = vi.fn(() => Promise.resolve())
    renderHook(() =>
      useChatPanelKeyboard({
        panelRef: { current: root },
        scrollRef: Object.assign(() => {}, { current: null }) as never,
        search: { requestOpen: () => {} },
        inFlight: true,
        chatMode: 'auto-accept',
        handleModeChange,
        autoCapability: { optedIn: false } as never,
        autocomplete: { show: false },
        handleStop,
        mode: 'claude-chat',
        promptKeysRef: { current: promptHandler }
      })
    )
    return { handleStop, handleModeChange }
  }

  it('the prompt gets the key first: Esc answers the prompt instead of stopping the turn', () => {
    const seen: string[] = []
    const { handleStop } = setup((e) => {
      seen.push(e.key)
      return e.key === 'Escape'
    })
    const esc = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(esc)
    expect(seen).toEqual(['Escape'])
    expect(esc.defaultPrevented).toBe(true)
    expect(handleStop).not.toHaveBeenCalled()
  })

  it('keys the prompt leaves alone keep their panel meaning', () => {
    const { handleStop } = setup(() => false)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }))
    expect(handleStop).toHaveBeenCalled()
  })
})

describe('useChatPanelKeyboard Esc Esc (the TUI double-Esc: rewind)', () => {
  function setup(
    over: Partial<UseChatPanelKeyboardOpts> & { focus?: 'composer' | 'other-input' } = {}
  ) {
    const root = document.createElement('div')
    const composer = document.createElement('textarea')
    const other = document.createElement('input')
    root.append(composer, other)
    document.body.appendChild(root)
    ;(over.focus === 'other-input' ? other : composer).focus()
    const onDoubleEscape = vi.fn()
    const handleStop = vi.fn()
    renderHook(() =>
      useChatPanelKeyboard({
        panelRef: { current: root },
        scrollRef: Object.assign(() => {}, { current: null }) as never,
        search: { requestOpen: () => {} },
        inFlight: false,
        chatMode: 'auto-accept',
        handleModeChange: () => Promise.resolve(),
        autoCapability: { optedIn: false } as never,
        autocomplete: { show: false },
        handleStop,
        mode: 'claude-chat',
        composerRef: { current: composer },
        draftEmpty: true,
        onDoubleEscape,
        ...over
      })
    )
    return { onDoubleEscape, handleStop }
  }
  const esc = () => {
    const e = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    window.dispatchEvent(e)
    return e
  }

  afterEach(() => {
    vi.useRealTimers()
  })

  it('two Escs within 800 ms, idle, empty composer: opens rewind once', () => {
    vi.useFakeTimers()
    const { onDoubleEscape, handleStop } = setup()
    esc()
    expect(onDoubleEscape).not.toHaveBeenCalled()
    vi.advanceTimersByTime(300)
    expect(esc().defaultPrevented).toBe(true)
    expect(onDoubleEscape).toHaveBeenCalledTimes(1)
    // A third Esc starts a new pair.
    esc()
    expect(onDoubleEscape).toHaveBeenCalledTimes(1)
    expect(handleStop).not.toHaveBeenCalled()
  })

  it('too slow, or another key in between: no rewind', () => {
    vi.useFakeTimers()
    const { onDoubleEscape } = setup()
    esc()
    vi.advanceTimersByTime(900)
    esc()
    expect(onDoubleEscape).not.toHaveBeenCalled()
    vi.advanceTimersByTime(900)
    esc()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    esc()
    expect(onDoubleEscape).not.toHaveBeenCalled()
  })

  it('text in the composer: Esc Esc does nothing (typed text is never lost)', () => {
    const { onDoubleEscape, handleStop } = setup({ draftEmpty: false })
    esc()
    esc()
    expect(onDoubleEscape).not.toHaveBeenCalled()
    expect(handleStop).not.toHaveBeenCalled()
  })

  it('a turn running: Esc stops it, never rewinds', () => {
    const { onDoubleEscape, handleStop } = setup({ inFlight: true })
    esc()
    esc()
    expect(handleStop).toHaveBeenCalledTimes(2)
    expect(onDoubleEscape).not.toHaveBeenCalled()
  })

  it('from another field (search, a queue edit): no rewind', () => {
    const { onDoubleEscape } = setup({ focus: 'other-input' })
    esc()
    esc()
    expect(onDoubleEscape).not.toHaveBeenCalled()
  })

  it('a pending prompt takes Esc: no rewind', () => {
    const { onDoubleEscape } = setup({ promptKeysRef: { current: (e) => e.key === 'Escape' } })
    esc()
    esc()
    expect(onDoubleEscape).not.toHaveBeenCalled()
  })

  it('autocomplete open: its Esc, no rewind', () => {
    const { onDoubleEscape } = setup({ autocomplete: { show: true } })
    esc()
    esc()
    expect(onDoubleEscape).not.toHaveBeenCalled()
  })
})

describe('useChatPanelKeyboard: jump between turns', () => {
  function setup() {
    const root = document.createElement('div')
    const composer = document.createElement('textarea')
    root.appendChild(composer)
    document.body.appendChild(root)
    composer.focus()
    const jumpTurn = vi.fn()
    const scrollTo = vi.fn()
    const unstick = vi.fn()
    renderHook(() =>
      useChatPanelKeyboard({
        panelRef: { current: root },
        scrollRef: Object.assign(() => {}, { current: { scrollTo } }) as never,
        search: { requestOpen: () => {} },
        inFlight: false,
        chatMode: 'auto-accept',
        handleModeChange: () => Promise.resolve(),
        autoCapability: { optedIn: false } as never,
        autocomplete: { show: false },
        handleStop: () => {},
        mode: 'claude-chat',
        jumpTurn,
        unstick
      })
    )
    return { jumpTurn, scrollTo, unstick, composer }
  }
  const press = (init: KeyboardEventInit) => {
    const e = new KeyboardEvent('keydown', { cancelable: true, ...init })
    window.dispatchEvent(e)
    return e
  }

  it('Cmd+Alt+↑ / ↓ (mac) or Alt+PgUp / PgDn: previous / next turn, not top / bottom', () => {
    const { jumpTurn, scrollTo } = setup()
    expect(press({ key: 'ArrowUp', metaKey: true, altKey: true }).defaultPrevented).toBe(true)
    expect(jumpTurn).toHaveBeenLastCalledWith(-1)
    press({ key: 'ArrowDown', metaKey: true, altKey: true })
    expect(jumpTurn).toHaveBeenLastCalledWith(1)
    press({ key: 'PageUp', altKey: true })
    expect(jumpTurn).toHaveBeenLastCalledWith(-1)
    press({ key: 'PageDown', altKey: true })
    expect(jumpTurn).toHaveBeenLastCalledWith(1)
    expect(scrollTo).not.toHaveBeenCalled()
    // Cmd+↑ alone is still the top of the timeline.
    press({ key: 'ArrowUp', metaKey: true })
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 })
    expect(jumpTurn).toHaveBeenCalledTimes(4)
  })

  it('Cmd+↑ lets go of the end first (rows loading above must not pull the view back down)', () => {
    const { scrollTo, unstick } = setup()
    press({ key: 'ArrowUp', metaKey: true })
    expect(unstick).toHaveBeenCalledTimes(1)
    expect(unstick.mock.invocationCallOrder[0]).toBeLessThan(scrollTo.mock.invocationCallOrder[0])
  })

  it('Alt+↑ alone (queue reorder, caret moves) is not a turn jump', () => {
    const { jumpTurn } = setup()
    press({ key: 'ArrowUp', altKey: true })
    press({ key: 'PageUp' })
    expect(jumpTurn).not.toHaveBeenCalled()
  })
})

describe('useChatPanelKeyboard: Cmd+↓', () => {
  it('goes to the end through the follow lock (it follows again)', () => {
    const root = document.createElement('div')
    const composer = document.createElement('textarea')
    root.appendChild(composer)
    document.body.appendChild(root)
    composer.focus()
    const scrollToBottom = vi.fn()
    const scrollTo = vi.fn()
    renderHook(() =>
      useChatPanelKeyboard({
        panelRef: { current: root },
        scrollRef: Object.assign(() => {}, { current: { scrollTo } }) as never,
        search: { requestOpen: () => {} },
        inFlight: false,
        chatMode: 'auto-accept',
        handleModeChange: () => Promise.resolve(),
        autoCapability: { optedIn: false } as never,
        autocomplete: { show: false },
        handleStop: () => {},
        mode: 'claude-chat',
        scrollToBottom
      })
    )
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', metaKey: true }))
    expect(scrollToBottom).toHaveBeenCalledTimes(1)
    expect(scrollTo).not.toHaveBeenCalled()
  })
})
