// @vitest-environment jsdom
import React from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

/**
 * Pins how the settings tabs mirror their react-query data into local, user-editable
 * state: what the controls show once a query resolves, that local edits survive
 * unrelated re-renders, and that a NEW query result re-seeds the controls.
 */

/** Query results by procedure path; a function gets the query input. */
let results: Record<string, unknown> = {}
let mutations: Array<{ path: string; input: unknown }> = []

function trpcProxy(): unknown {
  const build = (path: string[]): unknown =>
    new Proxy(() => undefined, {
      get: (_target, key) => {
        const name = path.join('.')
        if (key === 'queryOptions')
          return (input?: unknown, opts?: Record<string, unknown>) => ({
            queryKey: [name, input ?? null],
            queryFn: async () => {
              const r = results[name]
              if (r instanceof Error) throw r
              const v = typeof r === 'function' ? (r as (i: unknown) => unknown)(input) : r
              return v === undefined ? null : v
            },
            ...opts
          })
        if (key === 'mutationOptions')
          return (opts?: Record<string, unknown>) => ({
            mutationFn: async (input: unknown) => {
              mutations.push({ path: name, input })
              const r = results[`${name}#mutation`]
              return typeof r === 'function' ? (r as (i: unknown) => unknown)(input) : (r ?? null)
            },
            ...opts
          })
        if (key === 'queryFilter') return () => ({ queryKey: [name] })
        if (key === 'subscriptionOptions') return () => ({})
        return build([...path, String(key)])
      }
    })
  return build([])
}
const trpc = trpcProxy()

// The domain's typed view (`../trpc`) re-exports the runtime; point it at this mock.
vi.mock('../trpc', async () => await import('@slayzone/transport/client'))
vi.mock('@slayzone/transport/client', () => ({
  useTRPC: () => trpc,
  useTRPCClient: () => ({}),
  useSubscription: () => undefined,
  hubAllows: async () => true
}))

type Kids = { children?: React.ReactNode }
vi.mock('@slayzone/ui', () => {
  const Pass = ({ children }: Kids) => <>{children}</>
  const Div = ({ children }: Kids) => <div>{children}</div>
  return {
    cn: (...xs: unknown[]) => xs.filter(Boolean).join(' '),
    Button: ({ children, variant: _v, size: _s, ...props }: Record<string, unknown> & Kids) => (
      <button {...(props as React.ComponentProps<'button'>)}>{children}</button>
    ),
    Input: (props: React.ComponentProps<'input'>) => <input {...props} />,
    Label: ({ children, htmlFor }: Kids & { htmlFor?: string }) => (
      <label htmlFor={htmlFor}>{children}</label>
    ),
    Switch: ({
      checked,
      onCheckedChange,
      id
    }: {
      checked?: boolean
      onCheckedChange?: (v: boolean) => void
      id?: string
    }) => (
      <button
        role="switch"
        id={id}
        aria-checked={!!checked}
        onClick={() => onCheckedChange?.(!checked)}
      />
    ),
    Select: ({ value, children }: { value?: string } & Kids) => (
      <div data-select-value={value}>{children}</div>
    ),
    SelectTrigger: Pass,
    SelectValue: () => null,
    SelectContent: () => null,
    SelectItem: () => null,
    Card: Div,
    CardHeader: Div,
    CardTitle: Div,
    CardDescription: Div,
    CardContent: Div,
    Tooltip: Pass,
    TooltipTrigger: Pass,
    TooltipContent: () => null,
    AlertDialog: () => null,
    AlertDialogAction: Pass,
    AlertDialogCancel: Pass,
    AlertDialogContent: Pass,
    AlertDialogDescription: Pass,
    AlertDialogFooter: Pass,
    AlertDialogHeader: Pass,
    AlertDialogTitle: Pass,
    Dialog: ({ open, children }: { open: boolean } & Kids) => (open ? <div>{children}</div> : null),
    DialogContent: Div,
    SettingsLayout: Div,
    unifiedThemes: [],
    getThemeVariant: () => ({
      terminal: { background: '', red: '', green: '', yellow: '', blue: '', magenta: '', cyan: '' }
    }),
    safeRandomUUID: () => 'uuid',
    parseTerminalOptionAsMeta: () => 'auto',
    toast: { success: vi.fn(), error: vi.fn() }
  }
})

vi.mock('@slayzone/telemetry/client', () => ({
  track: vi.fn(),
  useTelemetry: () => ({}),
  TelemetrySettings: () => null
}))
vi.mock('@slayzone/tags/client', () => ({ CreateTagDialog: () => null }))
vi.mock('../ThemeContext', () => ({
  useTheme: () => ({
    preference: 'dark',
    setPreference: vi.fn(),
    themeId: 't',
    setThemeId: vi.fn(),
    splitThemes: false,
    setSplitThemes: vi.fn(),
    themeIdDark: 't',
    setThemeIdDark: vi.fn(),
    themeIdLight: 't',
    setThemeIdLight: vi.fn(),
    terminalOverrideThemeId: '',
    setTerminalOverrideThemeId: vi.fn(),
    editorOverrideThemeId: '',
    setEditorOverrideThemeId: vi.fn()
  })
}))
vi.mock('@slayzone/tabs-state', () => ({
  useTabStore: (sel: (s: { projectScopedTabs: boolean }) => unknown) =>
    sel({ projectScopedTabs: false })
}))

const { LabsSettingsTab } = await import('./LabsSettingsTab')
const { McpSettingsTab } = await import('./McpSettingsTab')
const { WorktreesSettingsTab } = await import('./WorktreesSettingsTab')
const { AboutSettingsTab } = await import('./AboutSettingsTab')
const { TagsSettingsTab } = await import('./TagsSettingsTab')
const { DiagnosticsSettingsTab } = await import('./DiagnosticsSettingsTab')
const { BackupSettingsTab } = await import('./BackupSettingsTab')
const { AppearanceSettingsTab } = await import('./AppearanceSettingsTab')
const { usePanelSettings } = await import('./panels-settings/usePanelSettings')

let queryClient: QueryClient
function wrapper({ children }: Kids) {
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
}
function renderTab(ui: React.ReactElement) {
  return render(ui, { wrapper })
}
async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  })
}
async function refetchAll(): Promise<void> {
  await act(async () => {
    await queryClient.refetchQueries()
  })
  await flush()
}
const switchState = (id: string) =>
  (document.getElementById(id) as HTMLElement).getAttribute('aria-checked')
const selectValues = () =>
  [...document.querySelectorAll('[data-select-value]')].map((e) =>
    e.getAttribute('data-select-value')
  )

beforeEach(() => {
  results = {}
  mutations = []
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } }
  })
})
afterEach(() => {
  cleanup()
  queryClient.clear()
})

describe('LabsSettingsTab', () => {
  it('mirrors the flags, keeps local toggles, re-seeds on new data', async () => {
    results['app.meta.isTestsPanelEnabled'] = true
    results['app.meta.isLoopModeEnabled'] = false
    renderTab(<LabsSettingsTab />)
    expect(switchState('labs_tests_panel')).toBe('false')
    await flush()
    expect(switchState('labs_tests_panel')).toBe('true')
    expect(switchState('labs_loop_mode')).toBe('false')

    fireEvent.click(document.getElementById('labs_loop_mode') as HTMLElement)
    await flush()
    expect(switchState('labs_loop_mode')).toBe('true')
    expect(mutations).toEqual([
      { path: 'app.meta.setLabFlag', input: { key: 'labs_loop_mode', on: true } }
    ])

    results['app.meta.isTestsPanelEnabled'] = false
    await refetchAll()
    expect(switchState('labs_tests_panel')).toBe('false')
    // loop-mode data unchanged (false → false, same value) → local toggle kept.
    expect(switchState('labs_loop_mode')).toBe('true')
  })

  it('seeds straight from cached data on remount', async () => {
    results['app.meta.isTestsPanelEnabled'] = true
    results['app.meta.isLoopModeEnabled'] = true
    renderTab(<LabsSettingsTab />)
    await flush()
    cleanup()
    renderTab(<LabsSettingsTab />)
    await flush()
    expect(switchState('labs_tests_panel')).toBe('true')
    expect(switchState('labs_loop_mode')).toBe('true')
  })
})

describe('McpSettingsTab', () => {
  it('shows the stored + active port; typed edits survive until new data', async () => {
    results['settings.get'] = (input: unknown) =>
      (input as { key: string }).key === 'mcp_preferred_port' ? '4000' : '4100'
    renderTab(<McpSettingsTab />)
    const input = () => screen.getByPlaceholderText('auto') as HTMLInputElement
    expect(input().value).toBe('')
    expect(screen.getByText('not running')).toBeTruthy()
    await flush()
    expect(input().value).toBe('4000')
    expect(screen.getByText('4100')).toBeTruthy()

    fireEvent.change(input(), { target: { value: '4001' } })
    await refetchAll() // same data → no re-seed
    expect(input().value).toBe('4001')

    results['settings.get'] = (i: unknown) =>
      (i as { key: string }).key === 'mcp_preferred_port' ? null : null
    await refetchAll()
    expect(input().value).toBe('')
    expect(screen.getByText('not running')).toBeTruthy()
  })
})

describe('WorktreesSettingsTab', () => {
  it('seeds every control from its setting', async () => {
    const values: Record<string, string | null> = {
      worktree_base_path: '../wt',
      auto_create_worktree_on_task_create: '1',
      worktree_copy_behavior: 'none',
      worktree_submodule_init: 'skip',
      worktree_copy_presets: JSON.stringify([{ id: 'p', name: 'Mine', pathGlobs: ['a'] }])
    }
    results['settings.get'] = (i: unknown) => values[(i as { key: string }).key] ?? null
    renderTab(<WorktreesSettingsTab />)
    await flush()
    const base = screen.getByPlaceholderText(
      '../{project-folder-name}-workspaces'
    ) as HTMLInputElement
    expect(base.value).toBe('../wt')
    expect((screen.getAllByRole('checkbox')[0] as HTMLInputElement).checked).toBe(true)
    expect(selectValues()).toEqual(['none', 'skip'])
    expect(screen.getByDisplayValue('Mine')).toBeTruthy()

    fireEvent.change(base, { target: { value: '../typed' } })
    await refetchAll()
    expect(base.value).toBe('../typed')
  })

  it('falls back to the built-in presets for empty, invalid or failed preset data', async () => {
    results['settings.get'] = (i: unknown) =>
      (i as { key: string }).key === 'worktree_copy_presets' ? 'not json' : null
    renderTab(<WorktreesSettingsTab />)
    await flush()
    expect(screen.getByDisplayValue('All ignored files')).toBeTruthy()
    expect(selectValues()).toEqual(['ask', 'auto'])
    cleanup()
    queryClient.clear()

    results['settings.get'] = (i: unknown) => {
      if ((i as { key: string }).key === 'worktree_copy_presets') throw new Error('nope')
      return null
    }
    renderTab(<WorktreesSettingsTab />)
    await flush()
    expect(screen.getByDisplayValue('Env files only')).toBeTruthy()
  })
})

describe('AboutSettingsTab', () => {
  it('shows the database path and CLI status once loaded', async () => {
    results['settings.get'] = null
    results['app.meta.checkCliInstalled'] = { installed: true, path: '/usr/local/bin/slay' }
    renderTab(<AboutSettingsTab />)
    expect(screen.getByText('Not installed')).toBeTruthy()
    await flush()
    expect(screen.getByText('Location: Default location (userData)')).toBeTruthy()
    expect(screen.getByText('Installed at /usr/local/bin/slay')).toBeTruthy()
  })

  it('shows an explicit database path', async () => {
    results['settings.get'] = '/data/slay.db'
    results['app.meta.checkCliInstalled'] = { installed: false }
    renderTab(<AboutSettingsTab />)
    await flush()
    expect(screen.getByText('Location: /data/slay.db')).toBeTruthy()
    expect(screen.getByText('Not installed')).toBeTruthy()
  })
})

describe('TagsSettingsTab', () => {
  it('lists the project tags from the query', async () => {
    results['tags.list'] = [
      { id: 't1', name: 'Bug', project_id: 'p1', color: '#000', sort_order: 0 },
      { id: 't2', name: 'Other', project_id: 'p2', color: '#000', sort_order: 0 }
    ]
    renderTab(<TagsSettingsTab projectId="p1" />)
    await flush()
    expect(screen.getByText('Bug')).toBeTruthy()
    expect(screen.queryByText('Other')).toBeNull()
  })
})

describe('DiagnosticsSettingsTab', () => {
  it('seeds the toggles and retention from the config', async () => {
    results['diagnostics.getConfig'] = {
      enabled: false,
      verbose: true,
      includePtyOutput: false,
      retentionDays: 30
    }
    results['app.meta.getSidecarStatus'] = null
    renderTab(<DiagnosticsSettingsTab />)
    expect(screen.getByDisplayValue('14')).toBeTruthy()
    await flush()
    expect(screen.getByDisplayValue('30')).toBeTruthy()
    const boxes = (screen.getAllByRole('checkbox') as HTMLInputElement[]).map((b) => b.checked)
    expect(boxes.slice(0, 3)).toEqual([false, true, false])
  })
})

describe('BackupSettingsTab', () => {
  it('seeds the backup settings from the query', async () => {
    results['app.backup.list'] = []
    results['app.backup.getSettings'] = {
      autoEnabled: true,
      intervalMinutes: 30,
      maxAutoBackups: 5,
      nextBackupNumber: 1
    }
    renderTab(<BackupSettingsTab />)
    expect(screen.getAllByRole('switch')[0].getAttribute('aria-checked')).toBe('false')
    await flush()
    expect(screen.getAllByRole('switch')[0].getAttribute('aria-checked')).toBe('true')
    expect(selectValues().slice(0, 2)).toEqual(['30', '5'])
  })
})

describe('AppearanceSettingsTab', () => {
  it('seeds the controls from getAll and re-seeds on new data', async () => {
    let all: Record<string, string> = {
      terminal_font_size: '15',
      editor_font_size: '12',
      notes_line_spacing: 'compact',
      chat_width: 'wide',
      reduce_motion: '1'
    }
    results['settings.getAll'] = () => all
    renderTab(<AppearanceSettingsTab />)
    await flush()
    const vals = selectValues()
    expect(vals).toContain('15')
    expect(vals).toContain('12')
    expect(vals).toContain('compact')
    expect(vals).toContain('wide')

    all = { ...all, terminal_font_size: '18' }
    await refetchAll()
    expect(selectValues()).toContain('18')
  })
})

describe('usePanelSettings', () => {
  const panelConfig = (name: string) =>
    JSON.stringify({
      viewEnabled: {},
      order: [],
      webPanels: [{ id: 'web:x', name, baseUrl: 'https://x.dev', shortcut: 'y' }]
    })

  it('seeds from getAll and seeds the web-panel edit form for the active tab', async () => {
    let all: Record<string, string> = {
      panel_config: panelConfig('First'),
      terminal_font_family: 'Fira',
      diff_wrap: '1'
    }
    results['settings.getAll'] = () => all
    const navigateTo = vi.fn()
    const { result, rerender } = renderHook(
      ({ tab }: { tab: string }) => usePanelSettings(tab, navigateTo),
      { wrapper, initialProps: { tab: 'panels/terminal' } }
    )
    expect(result.current.terminalFontFamily).toBe('Menlo, Monaco, "Courier New", monospace')
    await flush()
    expect(result.current.terminalFontFamily).toBe('Fira')
    expect(result.current.diffWrap).toBe(true)
    expect(result.current.editPanelName).toBe('')

    rerender({ tab: 'panels/web:x' })
    expect(result.current.editPanelName).toBe('First')
    expect(result.current.editPanelShortcut).toBe('y')

    act(() => result.current.setEditPanelName('typed'))
    rerender({ tab: 'panels/web:x' })
    expect(result.current.editPanelName).toBe('typed')

    all = { ...all, panel_config: panelConfig('Second') }
    await refetchAll()
    expect(result.current.editPanelName).toBe('Second')
  })
})
