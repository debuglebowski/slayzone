// @vitest-environment jsdom
// Pins the tab bar's chat font size control: steps change only this chat, landing
// on the default follows it again, Reset drops the chat's own size, and "Save as
// default" writes the setting before the chat follows it.
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TooltipProvider } from '@slayzone/ui'

let saved: Array<{ key: string; value: string }> = []
vi.mock('../trpc', () => ({
  useTRPC: () => ({
    settings: {
      set: {
        mutationOptions: () => ({
          mutationFn: async (input: { key: string; value: string }) => {
            saved.push(input)
          }
        })
      }
    }
  })
}))

const { ChatFontSizeControl } = await import('./ChatFontSizeControl')

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})
beforeEach(() => {
  saved = []
})
afterEach(cleanup)

function open(override: number | null, defaultSize = 13) {
  const onChange = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <TooltipProvider>
        <ChatFontSizeControl override={override} defaultSize={defaultSize} onChange={onChange} />
      </TooltipProvider>
    </QueryClientProvider>
  )
  fireEvent.click(screen.getByRole('button', { name: 'Chat font size' }))
  return onChange
}

it('shows the default and steps this chat away from it', () => {
  const onChange = open(null)
  expect(screen.getByTestId('chat-font-size-value').textContent).toBe('13px')
  fireEvent.click(screen.getByRole('button', { name: 'Larger' }))
  expect(onChange).toHaveBeenLastCalledWith(14)
  fireEvent.click(screen.getByRole('button', { name: 'Smaller' }))
  expect(onChange).toHaveBeenLastCalledWith(12)
})

it('a step back onto the default follows it again', () => {
  const onChange = open(14)
  fireEvent.click(screen.getByRole('button', { name: 'Smaller' }))
  expect(onChange).toHaveBeenLastCalledWith(null)
})

it('Reset and Save as default are off while the chat follows the default', () => {
  open(null)
  expect(screen.getByRole('button', { name: 'Reset' })).toHaveProperty('disabled', true)
  expect(screen.getByRole('button', { name: 'Save as default' })).toHaveProperty('disabled', true)
})

it('Reset drops the chat’s own size', () => {
  const onChange = open(16)
  fireEvent.click(screen.getByRole('button', { name: 'Reset' }))
  expect(onChange).toHaveBeenLastCalledWith(null)
})

it('Save as default writes the setting, then the chat follows it', async () => {
  const onChange = open(16)
  fireEvent.click(screen.getByRole('button', { name: 'Save as default' }))
  await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(null))
  expect(saved).toEqual([{ key: 'chat_font_size', value: '16' }])
})
