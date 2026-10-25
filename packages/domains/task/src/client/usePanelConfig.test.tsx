// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'

// One settings row + a controllable settings-changed stream on the default hub.
let stored: string | null = JSON.stringify({ webPanels: [], order: ['terminal'] })
const settingsGet = vi.fn(async () => stored)
let onSettingsData: ((event?: { keys: string[] | null }) => void) | null = null
vi.mock('@slayzone/transport/client', () => ({
  getTrpcClient: () => ({
    settings: { get: { query: settingsGet } },
    notify: {
      onSettingsChanged: {
        subscribe: (_: unknown, opts: { onData: (event?: { keys: string[] | null }) => void }) => {
          onSettingsData = opts.onData
          return { unsubscribe: () => (onSettingsData = null) }
        }
      }
    }
  }),
  useTRPC: () => ({ settings: { set: { mutationOptions: () => ({}) } } })
}))
vi.mock('@tanstack/react-query', () => ({
  useMutation: () => ({ mutateAsync: vi.fn(async () => undefined) })
}))

const { usePanelConfig } = await import('./usePanelConfig')

const renders: Record<string, number> = {}
const countRender = (name: string): void => {
  renders[name] = (renders[name] ?? 0) + 1
}
function Consumer({ name }: { name: string }) {
  const { config } = usePanelConfig()
  countRender(name)
  return <span data-testid={name}>{(config.order ?? []).join(',')}</span>
}

const settle = () => act(() => new Promise((r) => setTimeout(r, 0)))

describe('usePanelConfig (shared store)', () => {
  afterEach(() => {
    cleanup()
    settingsGet.mockClear()
  })

  it('every consumer shares ONE fetch, and a no-op settings ping re-renders nobody', async () => {
    const ui = render(
      <>
        {Array.from({ length: 20 }, (_, i) => (
          <Consumer key={i} name={`c${i}`} />
        ))}
      </>
    )
    await settle()
    expect(settingsGet).toHaveBeenCalledTimes(1)
    expect(ui.getByTestId('c7').textContent).toContain('terminal')

    const before = { ...renders }
    await act(async () => onSettingsData?.())
    await settle()
    expect(settingsGet).toHaveBeenCalledTimes(2) // one refetch for all 20
    expect(renders).toEqual(before) // value unchanged → no re-render

    stored = JSON.stringify({ webPanels: [], order: ['browser', 'terminal'] })
    await act(async () => onSettingsData?.())
    await settle()
    expect(ui.getByTestId('c0').textContent).toContain('browser')
    expect(ui.getByTestId('c19').textContent).toContain('browser')
  })

  it("another window's panel_config write reaches this window; other keys cost nothing", async () => {
    render(<Consumer name="win2" />)
    await settle()
    const calls = settingsGet.mock.calls.length
    // e.g. the main window saving its tab layout: not our key → no fetch.
    await act(async () => onSettingsData?.({ keys: ['viewState'] }))
    await settle()
    expect(settingsGet.mock.calls.length).toBe(calls)
    // The main window reorders panels → this (secondary) window follows.
    const before = document.querySelector('[data-testid="win2"]')?.textContent
    stored = JSON.stringify({ webPanels: [], order: ['artifacts', 'terminal'] })
    await act(async () => onSettingsData?.({ keys: ['viewState', 'panel_config'] }))
    await settle()
    expect(settingsGet.mock.calls.length).toBe(calls + 1)
    const after = document.querySelector('[data-testid="win2"]')?.textContent ?? ''
    expect(after).not.toBe(before)
    expect(after.startsWith('artifacts')).toBe(true)
  })

  it('in-window change events still reload (Settings dialog, e2e)', async () => {
    render(<Consumer name="solo" />)
    await settle()
    const calls = settingsGet.mock.calls.length
    stored = JSON.stringify({ webPanels: [], order: ['editor'] })
    await act(async () => void window.dispatchEvent(new CustomEvent('panel-config-changed')))
    await settle()
    expect(settingsGet.mock.calls.length).toBe(calls + 1)
  })
})
