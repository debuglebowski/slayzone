// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import React, { Suspense } from 'react'
import { render, screen, act, cleanup } from '@testing-library/react'
import { createSuspenseCache } from '@slayzone/suspense'
import type { TaskDetailData } from './taskDetailCache'

afterEach(cleanup)

// Minimal mock data matching TaskDetailData shape
function makeTaskDetailData(overrides: Partial<TaskDetailData> = {}): TaskDetailData {
  return {
    task: {
      id: 'task-1',
      project_id: 'proj-1',
      parent_id: null,
      title: 'Test Task',
      description: 'A description',
      status: 'todo',
      priority: 3,
      terminal_mode: 'claude-code',
      panel_visibility: null,
      browser_tabs: null,
      is_temporary: false
      // Only the columns the loader/stub read are filled in, so each literal is
      // widened through `unknown` instead of padding out the full row.
    } as unknown as TaskDetailData['task'],
    project: {
      id: 'proj-1',
      name: 'Test',
      path: '/tmp',
      color: '#000'
    } as unknown as TaskDetailData['project'],
    tags: [{ id: 'tag-1', name: 'bug', color: '#f00' }] as unknown as TaskDetailData['tags'],
    taskTagIds: ['tag-1'],
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

// Stub TaskDetailPage — the real one has too many dependencies.
// We verify it receives the correct props.
const receivedProps = vi.fn()

/** The props the real TaskDetailPage receives from the loader, plus whatever a
 *  test threads through `TestDataLoader`'s rest params (asserted via
 *  `receivedProps`, so the extras stay untyped). */
type StubProps = { taskId: string; initialData: TaskDetailData | null } & Record<string, unknown>

function StubTaskDetailPage(props: StubProps) {
  receivedProps(props)
  if (!props.initialData?.task) return <div data-testid="not-found">Task not found</div>
  return <div data-testid="task-title">{props.initialData.task.title}</div>
}

// Create a test cache (separate from the real taskDetailCache)
let fetchFn: ReturnType<typeof vi.fn>
let testCache: ReturnType<typeof createSuspenseCache>

beforeEach(() => {
  receivedProps.mockClear()
  fetchFn = vi.fn()
  testCache = createSuspenseCache({
    taskDetail: fetchFn as (...args: unknown[]) => Promise<TaskDetailData | null>
  })
})

// Test DataLoader that uses the test cache + stub component
function TestDataLoader({ taskId, ...rest }: { taskId: string; [k: string]: unknown }) {
  const data = testCache.useData('taskDetail', taskId) as TaskDetailData | null
  return <StubTaskDetailPage taskId={taskId} initialData={data} {...rest} />
}

describe('TaskDetailDataLoader', () => {
  it('suspends then renders with fetched data', async () => {
    const data = makeTaskDetailData()
    fetchFn.mockResolvedValue(data)

    await act(async () => {
      render(
        <Suspense fallback={<div data-testid="skeleton">loading</div>}>
          <TestDataLoader taskId="task-1" />
        </Suspense>
      )
    })

    expect(screen.getByTestId('task-title').textContent).toBe('Test Task')
    expect(receivedProps).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: 'task-1',
        initialData: data
      })
    )
  })

  it('passes null initialData when task not found', async () => {
    fetchFn.mockResolvedValue(null)

    await act(async () => {
      render(
        <Suspense fallback={<div>loading</div>}>
          <TestDataLoader taskId="missing" />
        </Suspense>
      )
    })

    expect(screen.getByTestId('not-found')).toBeDefined()
    expect(receivedProps).toHaveBeenCalledWith(expect.objectContaining({ initialData: null }))
  })

  it('shows skeleton fallback while suspended, then resolves', async () => {
    let resolve!: (v: TaskDetailData | null) => void
    fetchFn.mockReturnValue(
      new Promise<TaskDetailData | null>((r) => {
        resolve = r
      })
    )

    await act(async () => {
      render(
        <Suspense fallback={<div data-testid="skeleton">loading</div>}>
          <TestDataLoader taskId="task-1" />
        </Suspense>
      )
    })

    // Promise still pending — fallback visible
    expect(screen.getByTestId('skeleton')).toBeDefined()

    // Resolve and verify content replaces fallback
    await act(async () => {
      resolve(makeTaskDetailData())
    })

    expect(screen.getByTestId('task-title').textContent).toBe('Test Task')
  })

  it('passes all TaskDetailData fields through to TaskDetailPage', async () => {
    const data = makeTaskDetailData({
      projectPathMissing: true,
      panelVisibility: {
        terminal: false,
        browser: true,
        diff: false,
        settings: false,
        editor: true,
        processes: false
      },
      browserTabs: {
        tabs: [{ id: 'x', url: 'http://localhost:3000', title: 'Dev' }],
        activeTabId: 'x'
      }
    })
    fetchFn.mockResolvedValue(data)

    await act(async () => {
      render(
        <Suspense fallback={<div>loading</div>}>
          <TestDataLoader taskId="task-1" />
        </Suspense>
      )
    })

    const props = receivedProps.mock.calls[0][0]
    expect(props.initialData.projectPathMissing).toBe(true)
    expect(props.initialData.panelVisibility.browser).toBe(true)
    expect(props.initialData.panelVisibility.terminal).toBe(false)
    expect(props.initialData.browserTabs.tabs[0].url).toBe('http://localhost:3000')
  })
})
