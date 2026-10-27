import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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
    getAll: { query: vi.fn() },
    getByProject: { query: vi.fn() }
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
  },
  // The project-path probe routes to the machine that owns the workspace, not to
  // whichever hub answered the rest of the load. `reachable` is what separates
  // "the computer says it is gone" from "we could not ask" — only the first may
  // set `projectPathMissing`.
  workspace: { pathExists: { query: vi.fn() } }
}

// Second hub's client — a distinct mock so a hub-routed fetch is observable.
const remoteHubClientMock = {
  task: {
    get: { query: vi.fn() },
    getSubTasks: { query: vi.fn() },
    getAll: { query: vi.fn() },
    getByProject: { query: vi.fn() }
  },
  tags: { list: { query: vi.fn() }, getForTask: { query: vi.fn() } },
  projects: { list: { query: vi.fn() } },
  app: { files: { pathExists: { query: vi.fn() } } },
  workspace: { pathExists: { query: vi.fn() } }
}

vi.mock('@slayzone/transport/client', () => ({
  getTrpcClient: () => trpcClientMock,
  getHubClient: (id: string) =>
    id === 'remote-b' ? { id, url: '', client: remoteHubClientMock, wsClient: {} } : null
}))

const { fetchTaskDetail, buildTaskDetailSnapshot, TASK_DETAIL_FETCH_TIMEOUT_MS } = await import(
  './taskDetailCache'
)

beforeEach(() => {
  vi.clearAllMocks()
  trpcClientMock.task.get.query.mockResolvedValue(makeTask())
  trpcClientMock.task.getSubTasks.query.mockResolvedValue([])
  trpcClientMock.task.getAll.query.mockResolvedValue([])
  trpcClientMock.task.getByProject.query.mockResolvedValue([])
  trpcClientMock.tags.list.query.mockResolvedValue([makeTag()])
  trpcClientMock.tags.getForTask.query.mockResolvedValue([makeTag()])
  trpcClientMock.projects.list.query.mockResolvedValue([makeProject()])
  trpcClientMock.app.files.pathExists.query.mockResolvedValue(true)
  trpcClientMock.workspace.pathExists.query.mockResolvedValue({ exists: true, reachable: true })
  remoteHubClientMock.workspace.pathExists.query.mockResolvedValue({
    exists: true,
    reachable: true
  })
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
    trpcClientMock.workspace.pathExists.query.mockResolvedValue({
      exists: false,
      reachable: true
    })

    const result = await fetchTaskDetail('task-1')
    expect(result!.projectPathMissing).toBe(true)
  })

  // An offline computer means the question went unanswered. Reporting "missing"
  // would send the user to fix a path that is very likely fine — the exact false
  // alarm this routing exists to remove.
  it('does not call the path missing when its computer could not be reached', async () => {
    trpcClientMock.workspace.pathExists.query.mockResolvedValue({
      exists: false,
      reachable: false
    })

    const result = await fetchTaskDetail('task-1')
    expect(result!.projectPathMissing).toBe(false)
  })

  // This runs inside the Suspense load — a throwing probe used to be able to
  // reject the whole Task Detail page.
  it('survives a probe that throws outright', async () => {
    trpcClientMock.workspace.pathExists.query.mockRejectedValue(new Error('hub gone'))

    const result = await fetchTaskDetail('task-1')
    expect(result!.projectPathMissing).toBe(false)
  })

  it('uses task browser_tabs when present', async () => {
    const tabs = {
      tabs: [{ id: 't1', url: 'http://localhost:3000', title: 'Dev' }],
      activeTabId: 't1'
    }
    trpcClientMock.task.get.query.mockResolvedValue(makeTask({ browser_tabs: tabs }))

    const result = await fetchTaskDetail('task-1')
    expect(result!.browserTabs).toEqual(tabs)
    // Should NOT hit any fallback query
    expect(trpcClientMock.task.getAll.query).not.toHaveBeenCalled()
    expect(trpcClientMock.task.getByProject.query).not.toHaveBeenCalled()
  })

  it('falls back to first URL from same-project tasks when browser_tabs is null', async () => {
    trpcClientMock.task.get.query.mockResolvedValue(makeTask({ id: 'task-1', browser_tabs: null }))
    trpcClientMock.task.getByProject.query.mockResolvedValue([
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
    expect(trpcClientMock.task.getByProject.query).toHaveBeenCalledWith({ projectId: 'proj-1' })
    // Must never consult tasks outside the project — cross-project URL leak
    expect(trpcClientMock.task.getAll.query).not.toHaveBeenCalled()
  })

  it('falls back to about:blank when no same-project tasks have URLs', async () => {
    trpcClientMock.task.get.query.mockResolvedValue(makeTask({ browser_tabs: null }))
    trpcClientMock.task.getByProject.query.mockResolvedValue([
      makeTask({ id: 'task-1', browser_tabs: null })
    ])

    const result = await fetchTaskDetail('task-1')
    expect(result!.browserTabs.tabs[0].url).toBe('about:blank')
    expect(trpcClientMock.task.getAll.query).not.toHaveBeenCalled()
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

  it('routes to the DEFAULT hub client when no hubId is passed (byte-identical)', async () => {
    await fetchTaskDetail('task-1')
    expect(trpcClientMock.task.get.query).toHaveBeenCalledWith({ id: 'task-1' })
    expect(remoteHubClientMock.task.get.query).not.toHaveBeenCalled()
  })

  it('routes to the OWNING hub client when a hubId is passed (multi-hub)', async () => {
    remoteHubClientMock.task.get.query.mockResolvedValue(makeTask({ id: 'task-1' }))
    remoteHubClientMock.task.getSubTasks.query.mockResolvedValue([])
    remoteHubClientMock.task.getByProject.query.mockResolvedValue([])
    remoteHubClientMock.tags.list.query.mockResolvedValue([])
    remoteHubClientMock.tags.getForTask.query.mockResolvedValue([])
    remoteHubClientMock.projects.list.query.mockResolvedValue([])

    await fetchTaskDetail('task-1', 'remote-b')
    // The remote hub's client served the fetch; the default client was untouched.
    expect(remoteHubClientMock.task.get.query).toHaveBeenCalledWith({ id: 'task-1' })
    expect(trpcClientMock.task.get.query).not.toHaveBeenCalled()
  })

  it('falls back to the default hub when the hubId is unknown', async () => {
    await fetchTaskDetail('task-1', 'ghost-hub')
    expect(trpcClientMock.task.get.query).toHaveBeenCalledWith({ id: 'task-1' })
  })
})

// A hung trpc call (server-side stall — DB lock, unresponsive routed computer,
// etc.) used to leave fetchTaskDetail's promise unsettled forever: the Suspense
// cache entry never became `settled`, so the task tab's `use()` call suspended
// forever and the TaskShell skeleton was shown permanently — with no error, no
// retry, nothing. This is what "task stuck in loading state" actually was.
describe('fetchTaskDetail — hang timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('rejects instead of hanging forever when task.get never settles', async () => {
    trpcClientMock.task.get.query.mockReturnValue(new Promise(() => {}))

    const result = fetchTaskDetail('task-1')
    const assertion = expect(result).rejects.toThrow()

    await vi.advanceTimersByTimeAsync(TASK_DETAIL_FETCH_TIMEOUT_MS)
    await assertion
  })

  it('does not wait the full timeout when the fetch settles quickly', async () => {
    const result = await fetchTaskDetail('task-1')
    expect(result!.task.id).toBe('task-1')
  })
})

// The snapshot primes the same cache slot fetchTaskDetail fills, so for the same
// data the two must agree field for field — anything else renders a different
// page depending on how the tab was opened.
describe('buildTaskDetailSnapshot', () => {
  const browser = (url: string) => ({ tabs: [{ id: 't', url, title: url }], activeTabId: 't' })
  const parent = makeTask({ id: 'parent', title: 'Parent' })
  const task = makeTask({
    parent_id: 'parent',
    panel_visibility: { browser: true },
    panel_sizes: { terminal: 400 }
  })
  const sub = makeTask({ id: 'sub', parent_id: 'task-1' })
  const archivedSub = makeTask({ id: 'sub-arch', parent_id: 'task-1', archived_at: '2026-01-01' })
  const sibling = makeTask({ id: 'sibling', browser_tabs: browser('http://same.project') })
  const foreign = makeTask({
    id: 'foreign',
    project_id: 'proj-2',
    browser_tabs: browser('http://other.project')
  })
  const tags = [makeTag({ project_id: 'proj-1' }), makeTag({ id: 'tag-2', project_id: 'proj-2' })]

  it('matches fetchTaskDetail for the same data', async () => {
    trpcClientMock.task.get.query.mockImplementation(({ id }: { id: string }) =>
      Promise.resolve(id === 'parent' ? parent : task)
    )
    trpcClientMock.task.getSubTasks.query.mockResolvedValue([sub])
    trpcClientMock.task.getByProject.query.mockResolvedValue([parent, task, sub, sibling])
    trpcClientMock.tags.list.query.mockResolvedValue(tags)
    trpcClientMock.tags.getForTask.query.mockResolvedValue([tags[0]])

    const fetched = await fetchTaskDetail('task-1')
    const snapshot = buildTaskDetailSnapshot('task-1', {
      // Foreign-project task first: its URL must not leak into the fallback.
      tasks: [foreign, parent, task, sub, archivedSub, sibling] as never[],
      projects: [makeProject(), makeProject({ id: 'proj-2' })] as never[],
      tags: tags as never[],
      taskTagIds: ['tag-1'],
      projectPathMissing: false
    })

    const { taskTags: _fetchedOnly, ...comparable } = fetched!
    expect(snapshot).toEqual(comparable)
    expect(snapshot!.browserTabs.tabs[0].url).toBe('http://same.project')
  })

  it('returns null for a task the caller does not hold', () => {
    expect(
      buildTaskDetailSnapshot('missing', {
        tasks: [],
        projects: [],
        tags: [],
        taskTagIds: [],
        projectPathMissing: false
      })
    ).toBeNull()
  })
})
