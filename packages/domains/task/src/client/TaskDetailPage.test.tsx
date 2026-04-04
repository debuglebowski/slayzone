// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React from 'react'
import { render, screen, cleanup } from '@testing-library/react'
import type { TaskDetailData } from './taskDetailCache'

// --- Module mocks (must be before component import) ---

vi.mock('@slayzone/terminal', () => ({
  usePty: () => ({ resetTaskState: vi.fn(), subscribeSessionDetected: () => vi.fn(), subscribeDevServer: () => vi.fn(), getQuickRunPrompt: () => null, clearQuickRunPrompt: vi.fn() }),
  useTerminalModes: () => ({ modes: [] }),
  useLoopMode: () => ({ status: 'idle', iteration: 0, startLoop: vi.fn(), pauseLoop: vi.fn(), resumeLoop: vi.fn(), stopLoop: vi.fn() }),
  markSkipCache: vi.fn(),
  getVisibleModes: () => [],
  getModeLabel: () => '',
  groupTerminalModes: () => ({ builtin: [], custom: [] }),
  stripAnsi: (s: string) => s,
  serializeTerminalHistory: () => '',
  LoopModeBanner: () => null,
  LoopModeDialog: () => null,
  isLoopActive: () => false,
}))

vi.mock('@slayzone/settings/client', () => ({
  useTheme: () => ({ editorThemeId: 'default', contentVariant: 'dark' }),
}))

vi.mock('@slayzone/ui', () => {
  const Stub = (props: any) => props.children ?? null
  const StubTrigger = (props: any) => props.children ?? null
  return {
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
    Input: (props: any) => <input {...props} />,
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
    cn: (...args: any[]) => args.filter(Boolean).join(' '),
    getColumnStatusStyle: () => null,
    projectColorBg: () => undefined,
    useAppearance: () => ({
      colorTintsEnabled: false, notesFontFamily: 'monospace', notesLineSpacing: 1.5,
      notesCheckedHighlight: false, notesShowToolbar: false, notesSpellcheck: false,
    }),
    matchesShortcut: () => false,
    useShortcutStore: () => ({ overrides: {}, isRecording: false }),
    useShortcutDisplay: () => '',
    withModalGuard: (fn: any) => fn,
    getThemeEditorColors: () => ({}),
  }
})

vi.mock('@slayzone/projects', () => ({
  useDetectedRepos: () => [],
}))

vi.mock('@slayzone/projects/shared', () => ({
  getDefaultStatus: () => 'todo',
  getDoneStatus: () => 'done',
  isTerminalStatus: () => false,
  resolveRepoPath: () => ({ path: null, detected: false }),
}))

vi.mock('@slayzone/task/shared', () => ({
  BUILTIN_PANEL_IDS: ['terminal', 'browser', 'diff', 'settings', 'editor', 'processes'],
  getProviderConversationId: () => null,
  getProviderFlags: () => '',
  setProviderConversationId: vi.fn(),
  setProviderFlags: vi.fn(),
  clearAllConversationIds: vi.fn(),
  normalizeDescription: (d: any) => d ?? '',
  stripMarkdown: (s: string) => s,
}))

vi.mock('@slayzone/terminal/shared', () => ({
  DEV_SERVER_URL_PATTERN: /localhost/,
  SESSION_ID_COMMANDS: {},
  SESSION_ID_UNAVAILABLE: 'unavailable',
}))

vi.mock('@slayzone/editor', () => ({ RichTextEditor: () => null }))
vi.mock('@slayzone/task-terminals', () => ({ TerminalContainer: React.forwardRef(() => null) }))
vi.mock('@slayzone/worktrees', () => ({ UnifiedGitPanel: React.forwardRef(() => null) }))
vi.mock('@slayzone/task-browser', () => ({ BrowserPanel: React.forwardRef(() => null) }))
vi.mock('@slayzone/task-browser/shared', () => ({}))
vi.mock('@slayzone/file-editor/client', () => ({ FileEditorView: React.forwardRef(() => null) }))
vi.mock('@slayzone/file-editor/client/QuickOpenDialog', () => ({ QuickOpenDialog: () => null }))
vi.mock('@slayzone/file-editor/shared', () => ({}))
vi.mock('@slayzone/telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./DescriptionDialog', () => ({ DescriptionDialog: () => null }))
vi.mock('./DeleteTaskDialog', () => ({ DeleteTaskDialog: () => null }))
vi.mock('./TaskMetadataSidebar', () => ({ TaskMetadataSidebar: () => null, ExternalSyncCard: () => null }))
vi.mock('./WebPanelView', () => ({ WebPanelView: () => null }))
vi.mock('./ResizeHandle', () => ({ ResizeHandle: () => null }))
vi.mock('./ProcessesPanel', () => ({ ProcessesPanel: () => null }))
vi.mock('./TaskSettingsPanel', () => ({ TaskSettingsPanel: () => null }))

vi.mock('./useSubTasks', () => ({
  useSubTasks: () => ({
    subTasks: [], createSubTask: vi.fn(), updateSubTask: vi.fn(),
    deleteSubTask: vi.fn(), handleDragEnd: vi.fn(),
  }),
}))

vi.mock('./useTaskTagIds', () => ({
  useTaskTagIds: () => ({ tagIds: [], setTagIds: vi.fn() }),
}))

vi.mock('./usePanelSizes', () => ({
  usePanelSizes: () => [{}, vi.fn(), vi.fn(), vi.fn()],
  resolveWidths: () => ({}),
}))

vi.mock('./usePanelConfig', () => ({
  usePanelConfig: () => ({ enabledWebPanels: [], isBuiltinEnabled: () => true }),
}))

// --- Import component after mocks ---
import { TaskDetailPage } from './TaskDetailPage'

// --- Test helpers ---

function makeTaskDetailData(overrides: Partial<TaskDetailData> = {}): TaskDetailData {
  return {
    task: {
      id: 'sub-1', project_id: 'proj-1', parent_id: 'parent-1',
      title: 'My Subtask', description: null, description_format: 'markdown',
      status: 'todo', priority: 3, terminal_mode: 'claude-code',
      panel_visibility: null, browser_tabs: null, web_panel_urls: null,
      editor_open_files: null, provider_config: {}, is_temporary: false,
      worktree_path: null, base_dir: null, loop_config: null,
      dangerously_skip_permissions: false, assignee: null, due_date: null,
      repo_name: null, pr_url: null, linear_url: null, snoozed_until: null,
      merge_context: null, created_at: '2026-01-01', updated_at: '2026-01-01',
      archived_at: null, deleted_at: null,
    } as any,
    project: { id: 'proj-1', name: 'Test Project', path: '/tmp/test' } as any,
    tags: [],
    taskTagIds: [],
    subTasks: [],
    parentTask: null,
    projectPathMissing: false,
    panelVisibility: { terminal: true, browser: false, diff: false, settings: true, editor: false, processes: false },
    browserTabs: { tabs: [{ id: 'default', url: 'about:blank', title: 'New Tab' }], activeTabId: 'default' },
    ...overrides,
  }
}

const requiredProps = {
  taskId: 'sub-1',
  onBack: vi.fn(),
  onTaskUpdated: vi.fn(),
  onCloseTab: vi.fn(),
}

// --- Globals missing in jsdom ---
globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} } as any

// --- Minimal window.api mock ---
beforeEach(() => {
  ;(window as any).api = {
    db: { updateTask: vi.fn().mockResolvedValue(null), getTask: vi.fn().mockResolvedValue(null) },
    settings: { get: vi.fn().mockResolvedValue(null) },
    app: { isLoopModeEnabled: vi.fn().mockResolvedValue(false), onTasksChanged: vi.fn(() => vi.fn()), onSettingsChanged: vi.fn(() => vi.fn()) },
    taskTags: { getTagsForTask: vi.fn().mockResolvedValue([]) },
    taskTemplates: { getByProject: vi.fn().mockResolvedValue([]) },
    ccs: { getProfiles: vi.fn().mockResolvedValue([]) },
    pty: { getBuffer: vi.fn().mockResolvedValue(null) },
  }
})

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
