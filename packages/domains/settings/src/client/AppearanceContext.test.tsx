// @vitest-environment jsdom
// Pins AppearanceProvider: it turns the settings snapshot into the appearance values
// every screen reads, refetches on a settings-revision bump and on the
// 'sz:settings-changed' event, migrates the legacy notes line spacing once, and hands
// consumers the loaded values without an extra render on the defaults.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

let snapshot: Record<string, string> = {}
let fetches = 0
let mutations: Array<{ key: string; value: string }> = []

// One stable proxy: queryOptions/mutationOptions objects as react-query's tRPC adapter
// returns them.
const trpc = {
  settings: {
    getAll: {
      queryOptions: () => ({
        queryKey: ['settings.getAll'],
        queryFn: async () => {
          fetches += 1
          return { ...snapshot }
        }
      })
    },
    set: {
      mutationOptions: () => ({
        mutationFn: async (input: { key: string; value: string }) => {
          mutations.push(input)
        }
      })
    }
  }
}
vi.mock('@slayzone/transport/client', () => ({ useTRPC: () => trpc }))
vi.mock(
  '@slayzone/ui',
  async () => await vi.importActual('../../../../shared/ui/src/AppearanceContext')
)

const { AppearanceProvider } = await import('./AppearanceContext')
const { useAppearance, appearanceDefaults } = await import(
  '../../../../shared/ui/src/AppearanceContext'
)

type Seen = { terminalFontSize: number; notesReadability: string; diffWrap: boolean }
let seen: Seen[] = []
function Consumer() {
  const a = useAppearance()
  seen.push({
    terminalFontSize: a.terminalFontSize,
    notesReadability: a.notesReadability,
    diffWrap: a.diffWrap
  })
  return null
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}

function renderProvider(revision = 0) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (rev: number) => (
    <QueryClientProvider client={queryClient}>
      <AppearanceProvider settingsRevision={rev}>
        <Consumer />
      </AppearanceProvider>
    </QueryClientProvider>
  )
  const r = render(ui(revision))
  return { ...r, rerenderRevision: (rev: number) => r.rerender(ui(rev)) }
}

beforeEach(() => {
  snapshot = {}
  fetches = 0
  mutations = []
  seen = []
})
afterEach(() => cleanup())

describe('AppearanceProvider', () => {
  it('starts on the defaults, then hands consumers the parsed settings', async () => {
    snapshot = { terminal_font_size: '17', diff_wrap: '1' }
    renderProvider()
    expect(seen[0].terminalFontSize).toBe(appearanceDefaults.terminalFontSize)
    await flush()
    expect(seen.at(-1)).toEqual({
      terminalFontSize: 17,
      notesReadability: 'normal',
      diffWrap: true
    })
  })

  it('once loaded, consumers never render the defaults again', async () => {
    snapshot = { terminal_font_size: '17' }
    renderProvider()
    await flush()
    const firstLoaded = seen.findIndex((s) => s.terminalFontSize === 17)
    expect(firstLoaded).toBeGreaterThan(-1)
    expect(seen.slice(firstLoaded).map((s) => s.terminalFontSize)).toEqual(
      seen.slice(firstLoaded).map(() => 17)
    )
  })

  it('refetches on a revision bump and on sz:settings-changed', async () => {
    snapshot = { terminal_font_size: '15' }
    const { rerenderRevision } = renderProvider(0)
    await flush()
    const base = fetches
    snapshot = { terminal_font_size: '19' }
    rerenderRevision(1)
    await flush()
    expect(fetches).toBeGreaterThan(base)
    expect(seen.at(-1)?.terminalFontSize).toBe(19)

    snapshot = { terminal_font_size: '21' }
    const before = fetches
    await act(async () => {
      window.dispatchEvent(new CustomEvent('sz:settings-changed'))
    })
    await flush()
    expect(fetches).toBeGreaterThan(before)
    expect(seen.at(-1)?.terminalFontSize).toBe(21)
  })

  it('passes children updates through and keeps listening across re-renders', async () => {
    snapshot = { terminal_font_size: '15' }
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const ui = (label: string) => (
      <QueryClientProvider client={queryClient}>
        <AppearanceProvider settingsRevision={0}>
          <Consumer />
          <span data-testid="label">{label}</span>
        </AppearanceProvider>
      </QueryClientProvider>
    )
    const r = render(ui('a'))
    await flush()
    r.rerender(ui('b'))
    expect(r.getByTestId('label').textContent).toBe('b')

    snapshot = { terminal_font_size: '23' }
    await act(async () => {
      window.dispatchEvent(new CustomEvent('sz:settings-changed'))
    })
    await flush()
    expect(seen.at(-1)?.terminalFontSize).toBe(23)
  })

  it('migrates notes_line_spacing to notes_readability once', async () => {
    snapshot = { notes_line_spacing: 'compact' }
    renderProvider()
    await flush()
    expect(seen.at(-1)?.notesReadability).toBe('compact')
    expect(mutations).toEqual([
      { key: 'notes_readability', value: 'compact' },
      { key: 'notes_line_spacing', value: '' }
    ])
  })
})
