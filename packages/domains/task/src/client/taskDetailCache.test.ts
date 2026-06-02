import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchTaskDetail } from './taskDetailCache'

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

// Mock window.api
const mockApi = {
  db: {
    getTask: vi.fn(),
    getTags: vi.fn().mockResolvedValue([]),
    getProjects: vi.fn().mockResolvedValue([]),
    getSubTasks: vi.fn().mockResolvedValue([]),
    getTasks: vi.fn().mockResolvedValue([])
  },
  tags: { getTags: vi.fn().mockResolvedValue([]) },
  taskTags: { getTagsForTask: vi.fn().mockResolvedValue([]) },
  files: { pathExists: vi.fn().mockResolvedValue(true) }
}

beforeEach(() => {
  vi.restoreAllMocks()
  ;(globalThis as any).window = { api: mockApi }
  mockApi.db.getTask.mockResolvedValue(makeTask())
  mockApi.db.getProjects.mockResolvedValue([makeProject()])
  mockApi.tags.getTags.mockResolvedValue([makeTag()])
  mockApi.taskTags.getTagsForTask.mockResolvedValue([makeTag()])
  mockApi.db.getSubTasks.mockResolvedValue([])
  mockApi.db.getTasks.mockResolvedValue([])
  mockApi.files.pathExists.mockResolvedValue(true)
})

describe('fetchTaskDetail', () => {
  it('returns null when task not found', async () => {
    mockApi.db.getTask.mockResolvedValue(null)
    const result = await fetchTaskDetail('missing')
    expect(result).toBeNull()
  })

  it('resolves project by task.project_id', async () => {
    const proj = makeProject({ id: 'proj-2', name: 'Other' })
    mockApi.db.getTask.mockResolvedValue(makeTask({ project_id: 'proj-2' }))
    mockApi.db.getProjects.mockResolvedValue([makeProject(), proj])

    const result = await fetchTaskDetail('task-1')
    expect(result!.project!.id).toBe('proj-2')
  })

  it('sets project to null when no matching project', async () => {
    mockApi.db.getTask.mockResolvedValue(makeTask({ project_id: 'nonexistent' }))
    mockApi.db.getProjects.mockResolvedValue([makeProject()])

    const result = await fetchTaskDetail('task-1')
    expect(result!.project).toBeNull()
  })

  it('sets projectPathMissing when project path does not exist', async () => {
    mockApi.files.pathExists.mockResolvedValue(false)

    const result = await fetchTaskDetail('task-1')
    expect(result!.projectPathMissing).toBe(true)
  })

  it('uses task browser_tabs when present', async () => {
    const tabs = {
      tabs: [{ id: 't1', url: 'http://localhost:3000', title: 'Dev' }],
      activeTabId: 't1'
    }
    mockApi.db.getTask.mockResolvedValue(makeTask({ browser_tabs: tabs }))
    mockApi.db.getTasks.mockClear()

    const result = await fetchTaskDetail('task-1')
    expect(result!.browserTabs).toEqual(tabs)
    // Should NOT call getTasks (no fallback needed)
    expect(mockApi.db.getTasks).not.toHaveBeenCalled()
  })

  it('falls back to first URL from other tasks when browser_tabs is null', async () => {
    mockApi.db.getTask.mockResolvedValue(makeTask({ id: 'task-1', browser_tabs: null }))
    mockApi.db.getTasks.mockResolvedValue([
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
    mockApi.db.getTask.mockResolvedValue(makeTask({ browser_tabs: null }))
    mockApi.db.getTasks.mockResolvedValue([makeTask({ id: 'task-1', browser_tabs: null })])

    const result = await fetchTaskDetail('task-1')
    expect(result!.browserTabs.tabs[0].url).toBe('about:blank')
  })

  it('merges panel_visibility with defaults', async () => {
    mockApi.db.getTask.mockResolvedValue(
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
    mockApi.db.getTask.mockResolvedValue(makeTask({ is_temporary: true }))

    const result = await fetchTaskDetail('task-1')
    expect(result!.panelVisibility.settings).toBe(false)
  })

  it('maps taskTagIds from tag objects', async () => {
    mockApi.taskTags.getTagsForTask.mockResolvedValue([
      makeTag({ id: 'tag-a' }),
      makeTag({ id: 'tag-b' })
    ])

    const result = await fetchTaskDetail('task-1')
    expect(result!.taskTagIds).toEqual(['tag-a', 'tag-b'])
  })
})
