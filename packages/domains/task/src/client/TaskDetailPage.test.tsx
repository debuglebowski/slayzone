// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import type { ComponentProps, ReactNode } from 'react'
import type { TaskDetailData } from './taskDetailCache'

// --- Module mocks (must be before component import) ---

vi.mock('@slayzone/terminal', () => ({
  usePty: () => ({
    resetTaskState: vi.fn(),
    subscribeSessionDetected: () => vi.fn(),
    subscribeDevServer: () => vi.fn()
  }),
  useTerminalModes: () => ({ modes: [] }),
  useLoopMode: () => ({
    status: 'idle',
    iteration: 0,
    startLoop: vi.fn(),
    pauseLoop: vi.fn(),
    resumeLoop: vi.fn(),
    stopLoop: vi.fn()
  }),
  markSkipCache: vi.fn(),
  getVisibleModes: () => [],
  getModeLabel: () => '',
  groupTerminalModes: () => ({ builtin: [], custom: [] }),
  stripAnsi: (s: string) => s,
  serializeTerminalHistory: () => '',
  LoopModeBanner: () => null,
  LoopModeDialog: () => null,
  isLoopActive: () => false,
  useSlayNudge: () => ({ showBanner: false, dismiss: vi.fn(), recheck: vi.fn() })
}))

vi.mock('@slayzone/settings/client', () => ({
  useTheme: () => ({ editorThemeId: 'default', contentVariant: 'dark' }),
  // Only the header-layout slice the page selects from is provided.
  useTabStore: (
    selector: (s: {
      taskHeaderPanelMode: string
      taskHeaderPanelAlign: string
      taskHeaderTitleAlign: string
    }) => unknown
  ) =>
    selector({
      taskHeaderPanelMode: 'tabs',
      taskHeaderPanelAlign: 'right',
      taskHeaderTitleAlign: 'left'
    })
}))

vi.mock('@slayzone/dialogs', () => ({
  useDialogStore: Object.assign(() => ({}), {
    getState: () => ({ openSearch: vi.fn() })
  })
}))

vi.mock('@slayzone/ui', async (importOriginal) => {
  // Every stub collapses to its children, so children is the only prop that matters.
  const Stub = (props: { children?: ReactNode }) => props.children ?? null
  const StubTrigger = (props: { children?: ReactNode }) => props.children ?? null
  return {
    // Real module underneath, so exports the page gains later (hooks, helpers)
    // don't break this suite; only the UI primitives below are stubbed.
    ...(await importOriginal<typeof import('@slayzone/ui')>()),
    Button: Stub,
    IconButton: Stub,
    PanelToggle: () => null,
    DevServerToast: () => null,
    Collapsible: Stub,
    CollapsibleTrigger: StubTrigger,
    CollapsibleContent: Stub,
    DropdownMenu: Stub,
    DropdownMenuContent: Stub,
    DropdownMenuItem: Stub,
    DropdownMenuSeparator: () => null,
    DropdownMenuTrigger: StubTrigger,
    Select: Stub,
    SelectContent: Stub,
    SelectItem: Stub,
    SelectSeparator: () => null,
    SelectTrigger: StubTrigger,
    SelectValue: Stub,
    Input: (props: ComponentProps<'input'>) => <input {...props} />,
    ContextMenu: Stub,
    ContextMenuContent: Stub,
    ContextMenuItem: Stub,
    ContextMenuSeparator: () => null,
    ContextMenuSub: Stub,
    ContextMenuSubContent: Stub,
    ContextMenuSubTrigger: StubTrigger,
    ContextMenuTrigger: StubTrigger,
    ContextMenuRadioGroup: Stub,
    ContextMenuRadioItem: Stub,
    AlertDialog: Stub,
    AlertDialogAction: Stub,
    AlertDialogCancel: Stub,
    AlertDialogContent: Stub,
    AlertDialogDescription: Stub,
    AlertDialogFooter: Stub,
    AlertDialogHeader: Stub,
    AlertDialogTitle: Stub,
    Dialog: Stub,
    DialogContent: Stub,
    DialogHeader: Stub,
    DialogTitle: Stub,
    Tooltip: Stub,
    TooltipTrigger: StubTrigger,
    TooltipContent: Stub,
    Popover: Stub,
    PopoverContent: Stub,
    PopoverTrigger: StubTrigger,
    buildStatusOptions: () => [],
    cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
    getColumnStatusStyle: () => null,
    projectColorBg: () => undefined,
    useAppearance: () => ({
      colorTintsEnabled: false,
      notesFontFamily: 'monospace',
      notesReadability: 'normal',
      notesWidth: 'narrow',
      notesCheckedHighlight: false,
      notesShowToolbar: false,
      notesSpellcheck: false
    }),
    // matchesShortcut + useShortcutStore stay REAL (from the spread original): the
    // panel-shortcut tests below drive the page's keydown handler end to end.
    useShortcutDisplay: () => null,
    useStableCallback: <T,>(fn: T) => fn,
    withModalGuard: <T,>(fn: T) => fn,
    getThemeEditorColors: () => ({})
  }
})

vi.mock('@slayzone/projects', () => ({
  useDetectedRepos: () => []
}))

vi.mock('@slayzone/projects-contracts', () => ({
  getDefaultStatus: () => 'todo',
  getDoneStatus: () => 'done',
  isTerminalStatus: () => false,
  isCompletedStatus: () => false,
  resolveRepoPath: () => ({ path: null, detected: false })
}))

vi.mock('@slayzone/task-contracts', () => ({
  BUILTIN_PANEL_IDS: ['terminal', 'browser', 'diff', 'settings', 'editor', 'processes'],
  getProviderConversationId: () => null,
  getProviderFlags: () => '',
  setProviderConversationId: vi.fn(),
  setProviderFlags: vi.fn(),
  clearAllConversationIds: vi.fn(),
  normalizeDescription: (d: string | null | undefined) => d ?? '',
  stripMarkdown: (s: string) => s,
  priorityOptions: [{ value: 3, label: 'Medium' }]
}))

vi.mock('@slayzone/terminal-contracts', () => ({
  DEV_SERVER_URL_PATTERN: /localhost/,
  SESSION_ID_COMMANDS: {},
  SESSION_ID_UNAVAILABLE: 'unavailable'
}))

vi.mock('@slayzone/editor', () => ({ RichTextEditor: () => null }))
vi.mock('@slayzone/task-terminals', () => ({ TerminalContainer: React.forwardRef(() => null) }))
vi.mock('@slayzone/task-browser', () => ({ BrowserPanel: React.forwardRef(() => null) }))
vi.mock('@slayzone/task-browser/shared', () => ({}))
vi.mock('@slayzone/file-editor/client', () => ({ FileEditorView: React.forwardRef(() => null) }))
vi.mock('@slayzone/file-editor/shared', () => ({}))
vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./DescriptionDialog', () => ({ DescriptionDialog: () => null }))
vi.mock('./DeleteTaskDialog', () => ({ DeleteTaskDialog: () => null }))
vi.mock('./TaskMetadataSidebar', () => ({
  TaskMetadataSidebar: () => null,
  ExternalSyncCard: () => null
}))
vi.mock('./WebPanelView', () => ({ WebPanelView: () => null }))
vi.mock('./ResizeHandle', () => ({ ResizeHandle: () => null }))
vi.mock('./ProcessesPanel', () => ({ ProcessesPanel: () => null }))
vi.mock('./TaskSettingsPanel', () => ({ TaskSettingsPanel: () => null }))

vi.mock('./useSubTasks', () => ({
  useSubTasks: () => ({
    subTasks: [],
    createSubTask: vi.fn(),
    updateSubTask: vi.fn(),
    deleteSubTask: vi.fn(),
    handleDragEnd: vi.fn()
  })
}))

vi.mock('./useTaskTagIds', () => ({
  useTaskTagIds: () => ({ tagIds: [], setTagIds: vi.fn() })
}))

vi.mock('./usePanelSizes', () => ({
  usePanelSizes: () => [{}, vi.fn(), vi.fn(), vi.fn(), vi.fn()],
  resolvePanels: () => ({ widths: {}, gapPx: 0, overflow: false, leftKeys: [], rightKeys: [] }),
  planPanelStrip: () => ({
    renderOrder: [],
    rightStart: 0,
    order: {},
    spacerOrder: null,
    leftNeighbor: {},
    gapPx: 0
  }),
  effectiveLayout: () => ({ unit: 'fr', value: 1, min: 200, align: 'left' }),
  minWidthFor: () => 200,
  applyBoundaryResize: () => ({})
}))

// Per-test web panels. One array instance, mutated in place, so the page's
// `enabledWebPanels` dep stays referentially stable across renders.
const panelConfigMock = vi.hoisted(() => ({
  enabledWebPanels: [] as { id: string; name: string; baseUrl: string; shortcut?: string }[]
}))

vi.mock('./usePanelConfig', () => ({
  usePanelConfig: () => ({
    config: { order: [], webPanels: [] },
    updateConfig: vi.fn().mockResolvedValue(undefined),
    enabledWebPanels: panelConfigMock.enabledWebPanels,
    isBuiltinEnabled: () => true,
    getOrderedTaskIds: () => []
  })
}))

// useDevServerDetection reads the pty buffer as a string (`buf.match(...)`). The
// transport proxy resolves every call to [] (universal-safe for list consumers),
// which is truthy and trips its `.match` — irrelevant to this render test, so stub
// it. Stable singleton return so its refs don't churn dep arrays.
vi.mock('./task-detail/useDevServerDetection', () => {
  const value = {
    detectedDevUrl: null,
    setDetectedDevUrl: vi.fn(),
    browserOpenRef: { current: false },
    devServerAutoOpenCallbackRef: { current: null },
    devUrlToastDismissedRef: { current: false }
  }
  return { useDevServerDetection: () => value }
})

// tRPC transport — the page (+ nested usePanelOwnership) reads useTRPC /
// useTRPCClient / useSubscription. The test only asserts which header renders, so
// a deep proxy is enough: any `.x.y.query()/.mutate()` resolves to [] (safe for
// .map/.find/.includes + property reads), and `.queryOptions()/.mutationOptions()/
// .subscriptionOptions()` return harmlessly (consumed only by mocked react-query /
// useSubscription).
vi.mock('@slayzone/transport/client', () => {
  // Single self-referential proxy: every property access returns the SAME proxy
  // and every call resolves to []. Stability is load-bearing — returning a fresh
  // proxy per hook call makes `trpcClient` unstable, re-firing every effect that
  // deps on it (`[trpcClient]`) → setState → re-render → infinite loop.
  // Self-referential shape: every property access yields the same proxy, and
  // calling at any depth resolves to [].
  type DeepProxy = (() => Promise<unknown[]>) & { [key: string]: DeepProxy }
  const handler: ProxyHandler<DeepProxy> = {
    get: (_t, prop) => (prop === 'then' ? undefined : proxy),
    apply: () => Promise.resolve([])
  }
  const proxy = new Proxy((() => Promise.resolve([])) as unknown as DeepProxy, handler)
  return {
    useTRPC: () => proxy,
    useTRPCClient: () => proxy,
    useSubscription: () => undefined
  }
})

vi.mock('@tanstack/react-query', () => {
  // Stable singletons — fresh objects per render would churn dep arrays and loop.
  const mutation = {
    mutate: vi.fn(),
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    isPending: false,
    reset: vi.fn()
  }
  const query = {
    data: undefined,
    isLoading: false,
    isPending: false,
    error: null,
    refetch: vi.fn()
  }
  const queryClient = {
    invalidateQueries: vi.fn(),
    fetchQuery: vi.fn(),
    setQueryData: vi.fn(),
    getQueryData: vi.fn()
  }
  return {
    useMutation: () => mutation,
    useQuery: () => query,
    useQueryClient: () => queryClient
  }
})

// --- Import component after mocks ---
import { TaskDetailPage } from './TaskDetailPage'
import { registerTaskPanels } from './task-detail/TaskPanels'
import { detectPlatform } from '@slayzone/ui'

// The app injects the artifacts + git panels and their data hooks; stub them.
// Stable singleton returns so their values don't churn dep arrays.
const NO_ARTIFACTS = { artifacts: [] }
const NO_REPOS = { repos: [] }
registerTaskPanels({
  ArtifactsPanel: React.forwardRef(() => null),
  UnifiedGitPanel: React.forwardRef(() => null),
  useArtifacts: () => NO_ARTIFACTS,
  useProjectRepos: () => NO_REPOS
})

// --- Test helpers ---

function makeTaskDetailData(overrides: Partial<TaskDetailData> = {}): TaskDetailData {
  return {
    task: {
      id: 'sub-1',
      project_id: 'proj-1',
      parent_id: 'parent-1',
      title: 'My Subtask',
      description: null,
      description_format: 'markdown',
      status: 'todo',
      priority: 3,
      terminal_mode: 'claude-code',
      panel_visibility: null,
      browser_tabs: null,
      web_panel_urls: null,
      editor_open_files: null,
      provider_config: {},
      is_temporary: false,
      worktree_path: null,
      base_dir: null,
      loop_config: null,
      dangerously_skip_permissions: false,
      assignee: null,
      due_date: null,
      repo_name: null,
      pr_url: null,
      linear_url: null,
      snoozed_until: null,
      merge_context: null,
      created_at: '2026-01-01',
      updated_at: '2026-01-01',
      archived_at: null,
      deleted_at: null
      // Both literals carry only the columns the header render path reads, so
      // they go through `unknown` rather than claiming to be complete rows.
    } as unknown as TaskDetailData['task'],
    project: {
      id: 'proj-1',
      name: 'Test Project',
      path: '/tmp/test'
    } as unknown as TaskDetailData['project'],
    tags: [],
    taskTagIds: [],
    subTasks: [],
    parentTask: null,
    projectPathMissing: false,
    panelVisibility: {
      terminal: true,
      browser: false,
      diff: false,
      settings: true,
      editor: false,
      artifacts: false,
      processes: false
    },
    panelSizes: {},
    browserTabs: {
      tabs: [{ id: 'default', url: 'about:blank', title: 'New Tab' }],
      activeTabId: 'default'
    },
    ...overrides
  }
}

const requiredProps = {
  taskId: 'sub-1',
  onBack: vi.fn(),
  onTaskUpdated: vi.fn(),
  onCloseTab: vi.fn()
}

// --- Globals missing in jsdom ---
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

afterEach(cleanup)

// --- Tests ---

describe('TaskDetailPage — subtask race condition', () => {
  it('shows "Task not found" when both task and initialData are null', () => {
    render(<TaskDetailPage {...requiredProps} task={null} project={null} initialData={null} />)
    expect(screen.getByText('Task not found')).toBeDefined()
  })

  it('renders task from initialData when props.task is null (subtask race)', () => {
    // This reproduces the race condition: global state (task prop) hasn't loaded
    // the subtask yet, but the suspense cache (initialData) has it.
    const data = makeTaskDetailData()

    render(<TaskDetailPage {...requiredProps} task={null} project={null} initialData={data} />)

    // BUG: current code checks only props.task, ignoring initialData.task
    expect(screen.queryByText('Task not found')).toBeNull()
    expect(screen.getByText('My Subtask')).toBeDefined()
  })
})

describe('TaskDetailPage — web panel shortcut', () => {
  // A web panel stores only its letter; the tab label shows it as mod+letter
  // (⌘L on macOS, CtrlL elsewhere). Real matchesShortcut, so `mod` resolves for
  // the platform running the suite: Cmd on macOS, Ctrl elsewhere.
  const isMac = detectPlatform() === 'mac'
  const primary = isMac ? { metaKey: true } : { ctrlKey: true }
  const otherMod = isMac ? { ctrlKey: true } : { metaKey: true }
  const panelSelector = '[data-panel-id="web:test"]'

  afterEach(() => {
    panelConfigMock.enabledWebPanels.length = 0
  })

  function renderWithWebPanel(): HTMLInputElement {
    panelConfigMock.enabledWebPanels.push({
      id: 'web:test',
      name: 'TestPanel',
      baseUrl: 'https://example.com',
      shortcut: 'l'
    })
    render(
      <TaskDetailPage
        {...requiredProps}
        isActive
        task={null}
        project={null}
        initialData={makeTaskDetailData()}
      />
    )
    expect(document.querySelector(panelSelector)).toBeNull()
    return screen.getByDisplayValue('My Subtask') as HTMLInputElement
  }

  it('primary modifier + letter toggles the panel on and off', () => {
    const title = renderWithWebPanel()
    fireEvent.keyDown(title, { key: 'l', code: 'KeyL', ...primary })
    expect(document.querySelector(panelSelector)).not.toBeNull()
    fireEvent.keyDown(title, { key: 'l', code: 'KeyL', ...primary })
    expect(document.querySelector(panelSelector)).toBeNull()
  })

  it('typing the bare letter in an input does not toggle the panel', () => {
    const title = renderWithWebPanel()
    fireEvent.keyDown(title, { key: 'l', code: 'KeyL' })
    expect(document.querySelector(panelSelector)).toBeNull()
  })

  it('the bare letter with nothing focused does not toggle the panel', () => {
    renderWithWebPanel()
    fireEvent.keyDown(document.body, { key: 'l', code: 'KeyL' })
    expect(document.querySelector(panelSelector)).toBeNull()
  })

  // One combo per case: a toggle is its own inverse, so two misfires in one test
  // would cancel out and pass.
  it.each([
    ['the other modifier (Ctrl on macOS, Win/Super elsewhere)', { key: 'l', ...otherMod }],
    // e.key stays 'l' with Alt off macOS (on macOS it composes, e.g. '¬').
    ['Alt', { key: 'l', altKey: true }],
    ['Shift', { key: 'L', shiftKey: true }],
    // macOS Chromium reports the unshifted letter while Cmd is held.
    ['primary + Shift', { key: isMac ? 'l' : 'L', shiftKey: true, ...primary }]
  ])('the letter with %s does not toggle the panel', (_label, init) => {
    const title = renderWithWebPanel()
    fireEvent.keyDown(title, { code: 'KeyL', ...init })
    expect(document.querySelector(panelSelector)).toBeNull()
  })
})
