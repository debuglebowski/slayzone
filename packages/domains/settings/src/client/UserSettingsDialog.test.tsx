// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Pins which tab the settings dialog shows when (re)opened. (The default agent the
 * Providers / Panels tabs share is hub-scoped now: `tabs/use-default-agent.test.tsx`.)
 */

vi.mock('@slayzone/transport/client', () => ({
  useFederationOrNull: () => null,
  HubScope: ({ children }: { children?: React.ReactNode }) => <>{children}</>
}))

type Kids = { children?: React.ReactNode }
vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../shared/ui/src/use-deps-changed')),
  Dialog: ({ open, children }: { open: boolean } & Kids) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: Kids) => <div>{children}</div>,
  SettingsLayout: ({ children, onSelect }: Kids & { onSelect: (key: string) => void }) => (
    <div>
      <button onClick={() => onSelect('about')}>nav-about</button>
      <button onClick={() => onSelect('ai-providers')}>nav-providers</button>
      {children}
    </div>
  )
}))
vi.mock('@slayzone/telemetry/client', () => ({
  useTelemetry: () => ({ tier: 'off', setTier: vi.fn() }),
  TelemetrySettings: () => null
}))

/** Tab mounts, in order — a tab that mounts runs its own effects (fetches, listeners). */
let mounted: string[] = []
function useMountLog(name: string): void {
  React.useEffect(() => {
    mounted.push(name)
  }, [name])
}
const tab = (name: string) =>
  function MockTab() {
    useMountLog(name)
    return <div data-testid={`tab-${name}`} />
  }
vi.mock('./tabs/McpSettingsTab', () => ({ McpSettingsTab: tab('mcp') }))
vi.mock('./tabs/AppearanceSettingsTab', () => ({ AppearanceSettingsTab: tab('appearance') }))
vi.mock('./tabs/LayoutSettingsTab', () => ({ LayoutSettingsTab: tab('layout') }))
vi.mock('./tabs/DataSettingsTab', () => ({ DataSettingsTab: tab('data') }))
vi.mock('./tabs/DiagnosticsSettingsTab', () => ({ DiagnosticsSettingsTab: tab('diagnostics') }))
vi.mock('./tabs/AboutSettingsTab', () => ({ AboutSettingsTab: tab('about') }))
vi.mock('./tabs/WorktreesSettingsTab', () => ({ WorktreesSettingsTab: tab('worktrees') }))
vi.mock('./tabs/BackupSettingsTab', () => ({ BackupSettingsTab: tab('backup') }))
vi.mock('./tabs/LabsSettingsTab', () => ({ LabsSettingsTab: tab('labs') }))
vi.mock('./tabs/ConnectionsSettingsTab', () => ({ ConnectionsSettingsTab: tab('connections') }))
vi.mock('./tabs/SettingsTabIntro', () => ({ SettingsTabIntro: () => null }))
vi.mock('./tabs/PanelsSettingsTab', () => ({ PanelsSettingsTab: tab('panels') }))
vi.mock('./tabs/AiProvidersSettingsTab', () => ({ AiProvidersSettingsTab: tab('ai-providers') }))

const { UserSettingsDialog } = await import('./UserSettingsDialog')

let queryClient: QueryClient
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}
function renderDialog(props: { open: boolean; initialTab?: string }) {
  const ui = (p: typeof props) => (
    <QueryClientProvider client={queryClient}>
      <UserSettingsDialog onOpenChange={vi.fn()} {...p} />
    </QueryClientProvider>
  )
  const r = render(ui(props))
  return { ...r, rerender: (p: typeof props) => r.rerender(ui(p)) }
}

beforeEach(() => {
  mounted = []
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})
afterEach(() => {
  cleanup()
  queryClient.clear()
})

describe('UserSettingsDialog active tab', () => {
  it('opens on initialTab and re-applies it on every open', async () => {
    const { rerender } = renderDialog({ open: true, initialTab: 'about' })
    await flush()
    expect(screen.getByTestId('tab-about')).toBeTruthy()
    fireEvent.click(screen.getByText('nav-providers'))
    expect(screen.getByTestId('tab-ai-providers')).toBeTruthy()
    rerender({ open: false, initialTab: 'about' })
    rerender({ open: true, initialTab: 'about' })
    await flush()
    expect(screen.getByTestId('tab-about')).toBeTruthy()
  })

  it('reopening on another initialTab mounts only that tab, never the last-viewed one', async () => {
    const { rerender } = renderDialog({ open: true, initialTab: 'about' })
    await flush()
    fireEvent.click(screen.getByText('nav-providers'))
    expect(screen.getByTestId('tab-ai-providers')).toBeTruthy()
    rerender({ open: false, initialTab: 'about' })
    mounted = []
    rerender({ open: true, initialTab: 'diagnostics' })
    await flush()
    expect(screen.getByTestId('tab-diagnostics')).toBeTruthy()
    expect(mounted).toEqual(['diagnostics'])
  })
})
