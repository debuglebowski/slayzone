// @vitest-environment jsdom
/**
 * The terminal's start error. When the start was refused because a chat of the
 * task runs the conversation, it offers "Continue here" (chat E): the chat stops
 * first (A's hand-off), then the terminal starts on that conversation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { TerminalStartError } from './TerminalStartError'

afterEach(cleanup)

const IN_USE =
  'This conversation is running in the chat. Continue it here (the chat stops first), or stop it there.'

describe('TerminalStartError', () => {
  it('a plain start failure: its message, no action', () => {
    render(<TerminalStartError message="spawn failed" code={null} onContinueHere={vi.fn()} />)
    expect(screen.getByTestId('terminal-start-error').textContent).toContain('spawn failed')
    expect(screen.queryByTestId('terminal-continue-here')).toBeNull()
  })

  it('refused because the chat runs it: "Continue here" hands it over', async () => {
    let finish!: () => void
    const onContinueHere = vi.fn(() => new Promise<void>((r) => (finish = r)))
    render(
      <TerminalStartError
        message={IN_USE}
        code="conversation-in-use"
        onContinueHere={onContinueHere}
      />
    )
    const button = screen.getByTestId('terminal-continue-here')
    fireEvent.click(button)
    expect(onContinueHere).toHaveBeenCalledTimes(1)
    expect(button.textContent).toContain('Continuing')
    expect((button as HTMLButtonElement).disabled).toBe(true)
    await act(async () => finish())
  })

  it('no hand-off possible here (no restart for this tab): no button', () => {
    render(<TerminalStartError message={IN_USE} code="conversation-in-use" />)
    expect(screen.queryByTestId('terminal-continue-here')).toBeNull()
  })

  it('a failed hand-off says why and can be tried again', async () => {
    const onContinueHere = vi.fn(() => Promise.reject(new Error('no conversation yet')))
    render(
      <TerminalStartError
        message={IN_USE}
        code="conversation-in-use"
        onContinueHere={onContinueHere}
      />
    )
    await act(async () => fireEvent.click(screen.getByTestId('terminal-continue-here')))
    expect(screen.getByTestId('terminal-start-error').textContent).toContain('no conversation yet')
    expect((screen.getByTestId('terminal-continue-here') as HTMLButtonElement).disabled).toBe(false)
  })
})
