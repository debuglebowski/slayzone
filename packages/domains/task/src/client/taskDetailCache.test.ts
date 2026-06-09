import { describe, it, expect, vi, beforeEach } from 'vitest'

// Minimal Task factory — only fields fetchTaskDetail uses
function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 'task-1',
    project_id: 'proj-1',
    parent_id: null,
    title: 'Test task',
    description: null,
    status: 'todo',
    priority: 3,
    terminal_mode: 'claude-code',
    panel_visibility: null,
    browser_tabs: null,
    is_temporary: false,
    ...overrides
  }
}

function makeProject(overrides: Record<string, unknown> = {}) {
  return { id: 'proj-1', name: 'Test', path: '/tmp/test', color: '#000', ...overrides }
}

function makeTag(overrides: Record<string, unknown> = {}) {
  return { id: 'tag-1', name: 'bug', color: '#f00', ...overrides }
}

// tRPC client mock — taskDetailCache now reads the module-scope vanilla client
// via getTrpcClient() instead of window.api.*. The mock mirrors the tanstack
// client shape: nested router → procedure → { query }.
const trpcClientMock = {
  task: {
    get: { query: vi.fn() },
    getSubTasks: { query: vi.fn() },
    getAll: { query: vi.fn() }
  },
  tags: {
    list: { query: vi.fn() },
    getForTask: { query: vi.fn() }
  },
  projects: {
    list: { query: vi.fn() }
  },
  app: {
    files: { pathExists: { query: vi.fn() } }
  }
}

vi.mock('@slayzone/transport/client', () => ({
  getTrpcClient: () => trpcClientMock
}))

const { fetchTaskDetail } = await import('./taskDetailCache')

beforeEach(() => {
  vi.clearAllMocks()
  trpcClientMock.task.get.query.mockResolvedValue(makeTask())
  trpcClientMock.task.getSubTasks.query.mockResolvedValue([])
  trpcClientMock.task.getAll.query.mockResolvedValue([])
  trpcClientMock.tags.list.query.mockResolvedValue([makeTag()])
  trpcClientMock.tags.getForTask.query.mockResolvedValue([makeTag()])
  trpcClientMock.projects.list.query.mockResolvedValue([makeProject()])
  trpcClientMock.app.files.pathExists.query.mockResolvedValue(true)
})

describe('fetchTaskDetail', () => {
  it('returns null when task not found', async () => {
    trpcClientMock.task.get.query.mockResolvedValue(null)
    const result = await fetchTaskDetail('missing')
    expect(result).toBeNull()
  })

  it('resolves project by task.project_id', async () => {
    const proj = makeProject({ id: 'proj-2', name: 'Other' })
    trpcClientMock.task.get.query.mockResolvedValue(makeTask({ project_id: 'proj-2' }))
    trpcClientMock.projects.list.query.mockResolvedValue([makeProject(), proj])

    const result = await fetchTaskDetail('task-1')
    expect(result!.project!.id).toBe('proj-2')
  })

  it('sets project to null when no matching project', async () => {
    trpcClientMock.task.get.query.mockResolvedValue(makeTask({ project_id: 'nonexistent' }))
    trpcClientMock.projects.list.query.mockResolvedValue([makeProject()])

    const result = await fetchTaskDetail('task-1')
    expect(result!.project).toBeNull()
  })

  it('sets projectPathMissing when project path does not exist', async () => {
    trpcClientMock.app.files.pathExists.query.mockResolvedValue(false)

    const result = await fetchTaskDetail('task-1')
    expect(result!.projectPathMissing).toBe(true)
  })

  it('uses task browser_tabs when present', async () => {
    const tabs = {
      tabs: [{ id: 't1', url: 'http://localhost:3000', title: 'Dev' }],
      activeTabId: 't1'
    }
    trpcClientMock.task.get.query.mockResolvedValue(makeTask({ browser_tabs: tabs }))
    trpcClientMock.task.getAll.query.mockClear()

    const result = await fetchTaskDetail('task-1')
    expect(result!.browserTabs).toEqual(tabs)
    // Should NOT call getAll (no fallback needed)
    expect(trpcClientMock.task.getAll.query).not.toHaveBeenCalled()
  })

  it('falls back to first URL from other tasks when browser_tabs is null', async () => {
    trpcClientMock.task.get.query.mockResolvedValue(makeTask({ id: 'task-1', browser_tabs: null }))
    trpcClientMock.task.getAll.query.mockResolvedValue([
      makeTask({ id: 'task-1', browser_tabs: null }),
      makeTask({
        id: 'task-2',
        browser_tabs: {
          tabs: [{ id: 't', url: 'http://example.com', title: 'Ex' }],
          activeTabId: 't'
        }
      })
    ])

    const result = await fetchTaskDetail('task-1')
    expect(result!.browserTabs.tabs[0].url).toBe('http://example.com')
  })

  it('falls back to about:blank when no other tasks have URLs', async () => {
    trpcClientMock.task.get.query.mockResolvedValue(makeTask({ browser_tabs: null }))
    trpcClientMock.task.getAll.query.mockResolvedValue([makeTask({ id: 'task-1', browser_tabs: null })])

    const result = await fetchTaskDetail('task-1')
    expect(result!.browserTabs.tabs[0].url).toBe('about:blank')
  })

  it('merges panel_visibility with defaults', async () => {
    trpcClientMock.task.get.query.mockResolvedValue(
      makeTask({ panel_visibility: { browser: true, editor: true } })
    )

    const result = await fetchTaskDetail('task-1')
    expect(result!.panelVisibility).toEqual({
      terminal: true,
      browser: true,
      diff: false,
      settings: true,
      editor: true,
      artifacts: false,
      processes: false
    })
  })

  it('disables settings panel for temporary tasks', async () => {
    trpcClientMock.task.get.query.mockResolvedValue(makeTask({ is_temporary: true }))

    const result = await fetchTaskDetail('task-1')
    expect(result!.panelVisibility.settings).toBe(false)
  })

  it('maps taskTagIds from tag objects', async () => {
    trpcClientMock.tags.getForTask.query.mockResolvedValue([
      makeTag({ id: 'tag-a' }),
      makeTag({ id: 'tag-b' })
    ])

    const result = await fetchTaskDetail('task-1')
    expect(result!.taskTagIds).toEqual(['tag-a', 'tag-b'])
  })
})
