// @vitest-environment jsdom
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { watchTerminalFocusLoss } from './terminal-focus-watch'

type FocusWatchOptions = Parameters<typeof watchTerminalFocusLoss>[0]

let stopWatching: (() => void) | undefined

beforeEach(() => {
  vi.useFakeTimers()
  vi.advanceTimersByTime(4_000)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  stopWatching?.()
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function terminalInput() {
  const terminal = document.createElement('div')
  const textarea = document.createElement('textarea')
  textarea.className = 'xterm-helper-textarea'
  terminal.append(textarea)
  document.body.append(terminal)
  const submitted: string[] = []
  let prompt = ''
  textarea.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      submitted.push(prompt)
      prompt = ''
    } else {
      prompt += event.key
    }
  })
  const record = vi.fn().mockResolvedValue(undefined)
  stopWatching = watchTerminalFocusLoss({
    container: terminal,
    terminalRef: {
      current: { element: terminal, focus: () => textarea.focus() }
    } as unknown as FocusWatchOptions['terminalRef'],
    ptyStateRef: { current: 'idle' },
    sessionId: 'task:tab',
    mode: 'codex',
    trpcClient: {
      diagnostics: { recordClientEvent: { mutate: record } }
    } as unknown as FocusWatchOptions['trpcClient']
  })
  // Dispatch as the browser would, to whichever element has keyboard focus.
  const key = (key: string) =>
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  textarea.focus()
  expect(document.activeElement).toBe(textarea)
  for (const letter of 'review this change') key(letter)
  return { textarea, key, submitted, record }
}

test('submits a prompt when Enter lands before stray focus loss is repaired', async () => {
  const { textarea, key, submitted } = terminalInput()
  textarea.blur()
  // Native keydown comes in a later event, after pending microtasks.
  await Promise.resolve()
  key('Enter')
  vi.advanceTimersByTime(0)
  expect(document.activeElement).toBe(textarea)

  expect(submitted).toEqual(['review this change'])
})

test('diagnoses a blocked refocus while the prompt remains pending', () => {
  const { textarea, key, submitted, record } = terminalInput()
  textarea.blur()
  textarea.disabled = true
  vi.advanceTimersByTime(300)
  expect(document.activeElement).toBe(document.body)
  key('Enter')
  expect(submitted).toEqual([])
  expect(record).toHaveBeenCalledWith(
    expect.objectContaining({
      event: 'terminal.focus_lost_no_refocus',
      payload: expect.objectContaining({ cause: 'element-unfocusable' })
    })
  )

  textarea.disabled = false
  textarea.focus()
  key('Enter')
  expect(submitted).toEqual(['review this change'])
})

test('leaves focus on another control when the user moves there', async () => {
  const { key, submitted, record } = terminalInput()
  const button = document.createElement('button')
  document.body.append(button)
  button.focus()
  await Promise.resolve()
  vi.advanceTimersByTime(300)

  expect(document.activeElement).toBe(button)
  key('Enter')
  expect(submitted).toEqual([])
  expect(record).not.toHaveBeenCalled()
})
