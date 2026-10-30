// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Project } from '@slayzone/projects-contracts'

/**
 * The selected project's path check (useProjectPathGuard) feeds two readers:
 *  - the Home "project path missing" UI, through `projectPathMissing`;
 *  - renderer diagnostics, through ActiveTabSync → useDiagnosticsSync, which
 *    stamps the value into the diagnostics context and into the
 *    `project_changed` timeline event.
 * The harness wires both exactly as App.tsx does.
 */

type PathExists = { exists: boolean; reachable: boolean }
type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

// One pending answer per probe, in call order, so a test resolves each when it chooses.
let probes: Array<{ input: { projectId: string; path: string }; answer: Deferred<PathExists> }> = []
const recordClientEvent = vi.fn()
const client = {
  workspace: {
    pathExists: {
      query: (input: { projectId: string; path: string }) => {
        const answer = deferred<PathExists>()
        probes.push({ input, answer })
        return answer.promise
      }
    }
  },
  projects: {
    update: {
      // The hub records the folder on the project's computer and returns the project
      // with that folder.
      mutate: async (input: { id: string; path: string }) =>
        project(input.id, PROJECTS.find((p) => p.id === input.id)!.name, input.path)
    }
  },
  diagnostics: { recordClientEvent: { mutate: recordClientEvent } },
  app: { taskWindows: { setPrimaryActive: { mutate: async () => undefined } } },
  task: { update: { mutate: async () => undefined } }
}

vi.mock('@/trpc', () => ({
  useTRPCClient: () => client,
  getTrpcClient: () => client
}))
vi.mock('@slayzone/tabs-state', () => {
  const state = { activeTabIndex: 0, setSelectedProjectId: () => {} }
  const useTabStore = (select: (s: typeof state) => unknown) => select(state)
  useTabStore.getState = () => state
  return { useTabStore }
})
vi.mock('@/hooks/useTabLifecycle', () => ({ useTabPageViews: () => {} }))

const { useProjectPathGuard } = await import('./useProjectPathGuard')
const { ActiveTabSync } = await import('./ActiveTabSync')
const { getDiagnosticsContext, updateDiagnosticsContext } = await import('@/lib/diagnosticsClient')

/** A project whose folder on its computer (`c1`) is `path`, with that status. */
function project(
  id: string,
  name: string,
  path: string | null,
  status: 'ready' | 'pending' | 'missing' | 'refused' = 'ready'
): Project {
  return {
    id,
    name,
    placements: path ? [{ computer_id: 'c1', path, status }] : [],
    resolved_computer_id: 'c1'
  } as unknown as Project
}

const PROJECTS = [
  project('A', 'Alpha', '/a'),
  project('B', 'Beta', '/b'),
  project('C', 'Gamma', '/c'),
  project('N', 'No path', null),
  project('M', 'Reported missing', '/m', 'missing'),
  project('R', 'Refused', '/r', 'refused'),
  project('P', 'Pending', '/p', 'pending')
]

const MISSING: PathExists = { exists: false, reachable: true }
const PRESENT: PathExists = { exists: true, reachable: true }

let guardApi: ReturnType<typeof useProjectPathGuard>

function Shell({ selectedProjectId }: { selectedProjectId: string }) {
  const guard = useProjectPathGuard(selectedProjectId, PROJECTS, () => {})
  guardApi = guard
  return (
    <>
      <span data-testid="home-path-missing">{String(guard.projectPathMissing)}</span>
      <ActiveTabSync
        tabs={[{ type: 'home' }]}
        tasksMap={new Map()}
        selectedProjectId={selectedProjectId}
        activeView="tabs"
        projects={PROJECTS}
        taskCount={0}
        displayTaskCount={0}
        selectedProjectPathMissing={guard.selectedProjectPathMissing}
      />
    </>
  )
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
  })
}

async function answer(index: number, value: PathExists): Promise<void> {
  probes[index].answer.resolve(value)
  await flush()
}

function homeShowsMissing(): boolean {
  return screen.getByTestId('home-path-missing').textContent === 'true'
}

function projectChangedEvents(): Array<Record<string, unknown>> {
  return recordClientEvent.mock.calls
    .map(([input]) => input as { event: string; payload: Record<string, unknown> })
    .filter((input) => input.event === 'renderer.timeline.project_changed')
    .map((input) => input.payload)
}

beforeEach(() => {
  probes = []
  recordClientEvent.mockReset()
  updateDiagnosticsContext({ selectedProjectId: null, projectPathMissing: undefined })
})

afterEach(() => {
  cleanup()
})

describe('project switch → diagnostics', () => {
  it("never stamps the previous project's answer on the new project", async () => {
    const view = render(<Shell selectedProjectId="A" />)
    await answer(0, MISSING)
    expect(getDiagnosticsContext()).toMatchObject({
      selectedProjectId: 'A',
      projectPathMissing: true
    })

    view.rerender(<Shell selectedProjectId="B" />)

    // B's probe has not answered yet: B's value is unknown (null), not A's `true`.
    expect(probes[1].input).toEqual({ projectId: 'B', path: '/b' })
    const [changed] = projectChangedEvents()
    expect(changed).toMatchObject({ from: 'A', to: 'B' })
    expect(changed.context).toMatchObject({ selectedProjectId: 'B', projectPathMissing: null })
    expect(getDiagnosticsContext()).toMatchObject({
      selectedProjectId: 'B',
      projectPathMissing: null
    })

    // B's own answer lands in the context once its probe resolves.
    await answer(1, PRESENT)
    expect(getDiagnosticsContext()).toMatchObject({
      selectedProjectId: 'B',
      projectPathMissing: false
    })
  })

  it('a project without a path is known not-missing at the switch itself', async () => {
    const view = render(<Shell selectedProjectId="A" />)
    await answer(0, MISSING)

    view.rerender(<Shell selectedProjectId="N" />)

    expect(probes).toHaveLength(1)
    const [changed] = projectChangedEvents()
    expect(changed).toMatchObject({ from: 'A', to: 'N' })
    expect(changed.context).toMatchObject({ selectedProjectId: 'N', projectPathMissing: false })
  })

  it("a late answer for a project no longer selected is not reported as the selected one's", async () => {
    const view = render(<Shell selectedProjectId="A" />)
    view.rerender(<Shell selectedProjectId="B" />)
    await answer(1, PRESENT)
    expect(getDiagnosticsContext()).toMatchObject({
      selectedProjectId: 'B',
      projectPathMissing: false
    })

    await answer(0, MISSING) // A's probe, from before the switch
    expect(getDiagnosticsContext()).toMatchObject({ selectedProjectId: 'B' })
    expect(getDiagnosticsContext().projectPathMissing).not.toBe(true)
  })
})

describe('Home "path missing" UI (unchanged behavior)', () => {
  it('keeps the previous answer while the new project is probed, then shows its own', async () => {
    const view = render(<Shell selectedProjectId="A" />)
    expect(homeShowsMissing()).toBe(false)
    await answer(0, MISSING)
    expect(homeShowsMissing()).toBe(true)

    view.rerender(<Shell selectedProjectId="B" />)
    expect(homeShowsMissing()).toBe(true)
    await answer(1, PRESENT)
    expect(homeShowsMissing()).toBe(false)
  })

  it('a project without a path is never missing, and is not probed', async () => {
    const view = render(<Shell selectedProjectId="A" />)
    await answer(0, MISSING)

    view.rerender(<Shell selectedProjectId="N" />)
    expect(homeShowsMissing()).toBe(false)
    expect(probes).toHaveLength(1)

    // The next project starts from that `false` while its own probe runs.
    view.rerender(<Shell selectedProjectId="B" />)
    expect(homeShowsMissing()).toBe(false)
    await answer(1, MISSING)
    expect(homeShowsMissing()).toBe(true)
  })

  // The computer already said so: shown at once, never re-asked.
  it('a folder the computer reported missing is missing without a probe', async () => {
    render(<Shell selectedProjectId="M" />)
    expect(homeShowsMissing()).toBe(true)
    expect(guardApi.projectPathRefused).toBe(false)
    expect(probes).toHaveLength(0)
  })

  // Was silently inert: a jail refusal read as "could not ask" and showed nothing.
  it('a folder outside its computer’s allowed folders is blocked, and says so', async () => {
    render(<Shell selectedProjectId="R" />)
    expect(homeShowsMissing()).toBe(true)
    expect(guardApi.projectPathRefused).toBe(true)
    expect(probes).toHaveLength(0)
  })

  // Known to the hub, awaiting delivery to its computer: probed like a ready one,
  // never shown as "pick a folder".
  it('a pending folder is probed like a confirmed one', async () => {
    render(<Shell selectedProjectId="P" />)
    expect(probes[0].input).toEqual({ projectId: 'P', path: '/p' })
    await answer(0, PRESENT)
    expect(homeShowsMissing()).toBe(false)
  })

  it('re-probes the selected project on window focus', async () => {
    render(<Shell selectedProjectId="A" />)
    await answer(0, PRESENT)
    expect(homeShowsMissing()).toBe(false)

    fireEvent.focus(window)
    expect(probes[1].input).toEqual({ projectId: 'A', path: '/a' })
    await answer(1, MISSING)
    expect(homeShowsMissing()).toBe(true)
  })

  it('applyFixedPath re-points the project and re-probes the new path', async () => {
    render(<Shell selectedProjectId="A" />)
    await answer(0, MISSING)
    expect(homeShowsMissing()).toBe(true)

    await act(async () => {
      await guardApi.applyFixedPath('/a2')
    })
    expect(probes[1].input).toEqual({ projectId: 'A', path: '/a2' })
    await answer(1, PRESENT)
    expect(homeShowsMissing()).toBe(false)
  })

  it('an unchanged answer does not re-render the shell (focus re-probes)', async () => {
    // App hosts this hook: before the PathCheck refactor an identical answer was a
    // same-value setState (bailed out), so a window focus re-rendered nothing.
    let childRenders = 0
    function RenderCounter(): null {
      childRenders++
      return null
    }
    function CountingShell({ selectedProjectId }: { selectedProjectId: string }) {
      const guard = useProjectPathGuard(selectedProjectId, PROJECTS, () => {})
      return (
        <>
          <span data-testid="home-path-missing">{String(guard.projectPathMissing)}</span>
          <RenderCounter />
        </>
      )
    }
    render(<CountingShell selectedProjectId="A" />)
    await answer(0, MISSING)
    expect(homeShowsMissing()).toBe(true)
    const rendersAfterFirstAnswer = childRenders

    fireEvent.focus(window)
    await answer(1, MISSING)
    fireEvent.focus(window)
    await answer(2, MISSING)

    expect(probes).toHaveLength(3)
    expect(homeShowsMissing()).toBe(true)
    expect(childRenders).toBe(rendersAfterFirstAnswer)
  })

  it('validateProjectPath (called by App after a settings save) updates the flag', async () => {
    render(<Shell selectedProjectId="A" />)
    await answer(0, PRESENT)

    await act(async () => {
      void guardApi.validateProjectPath(PROJECTS[0])
    })
    expect(probes[1].input).toEqual({ projectId: 'A', path: '/a' })
    await answer(1, MISSING)
    expect(homeShowsMissing()).toBe(true)
  })
})
