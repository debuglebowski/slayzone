// @vitest-environment jsdom
import type React from 'react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Project } from '@slayzone/projects-contracts'

// Per-project provider whose status sync locks the project (the registered lookup's answer).
let locks: Record<string, string> = {}
let isPlaywright = false
// Tabs that committed (ran their mount effects), in order.
let mountedTabs: string[] = []
function useMountLog(name: string): void {
  useEffect(() => {
    mountedTabs.push(name)
  }, [name])
}

// The registered lookup (integrations' in the app). Stable, like the real hook's
// result while its query client and hub client stay the same.
const lookup = vi.fn((projectId: string) => Promise.resolve(locks[projectId] ?? null))

vi.mock('@slayzone/transport/client', () => ({
  electronBootstrap: { isPlaywright: () => isPlaywright }
}))

type Kids = { children?: React.ReactNode }
vi.mock('@slayzone/ui', async () => ({
  ...(await vi.importActual<object>('../../../../shared/ui/src/use-deps-changed')),
  Dialog: ({ open, children }: Kids & { open: boolean }) => (open ? <>{children}</> : null),
  DialogContent: ({ children }: Kids) => <>{children}</>,
  DialogHeader: ({ children }: Kids) => <>{children}</>,
  DialogTitle: ({ children }: Kids) => <>{children}</>,
  SettingsLayout: ({ children }: Kids) => <>{children}</>
}))

vi.mock('@slayzone/telemetry/client', () => {
  const tracker = {
    track: vi.fn(),
    trackTask: vi.fn(),
    trackProject: vi.fn(),
    trackShortcut: vi.fn()
  }
  return { useTrack: () => tracker }
})
vi.mock('./ColumnsTab', () => ({
  ColumnsTab: ({ lockedByProvider }: { lockedByProvider: string | null }) => {
    useMountLog('tasks/statuses')
    return <div data-testid="columns-lock">{lockedByProvider ?? 'unlocked'}</div>
  }
}))
vi.mock('./GeneralTab', () => ({
  GeneralTab: () => {
    useMountLog('general')
    return null
  }
}))
vi.mock('./EnvironmentTab', () => ({
  EnvironmentTab: () => {
    useMountLog('environment')
    return null
  }
}))
vi.mock('./WorktreesTab', () => ({ WorktreesTab: () => null }))
vi.mock('./ReposTab', () => ({ ReposTab: () => null }))
vi.mock('./TasksGeneralTab', () => ({ TasksGeneralTab: () => null }))
vi.mock('@slayzone/test-panel/client', () => ({ TestsTab: () => null }))

import { ProjectSettingsDialog } from './ProjectSettingsDialog'
import { registerProjectSettingsTabs } from './ProjectSettingsTabs'

// The app registers settings' tag editor, integrations' tab + lock lookup and worktrees'
// repo detection; stub the slots.
const NO_DETECTED_REPOS: never[] = []
registerProjectSettingsTabs({
  TagsSettingsTab: () => null,
  IntegrationsTab: () => {
    useMountLog('integrations')
    return null
  },
  useStatusSyncLockLookup: () => lookup,
  useDetectedRepos: () => NO_DETECTED_REPOS
})

const project = (id: string) => ({ id, path: `/tmp/${id}` }) as unknown as Project
const ui = (p: Project | null, open = true) => (
  <ProjectSettingsDialog
    project={p}
    open={open}
    onOpenChange={vi.fn()}
    initialTab="tasks/statuses"
    onUpdated={vi.fn()}
  />
)
const lockText = () => screen.getByTestId('columns-lock').textContent

beforeEach(() => {
  mountedTabs = []
  locks = {}
  isPlaywright = false
  lookup.mockClear()
})

afterEach(cleanup)

describe('ProjectSettingsDialog status lock', () => {
  // Which provider wins and how a failed lookup reads live with the lookup itself
  // (@slayzone/integrations useStatusSyncLockLookup.test.ts).
  it('reports the provider the lookup returns', async () => {
    locks = { p1: 'GitHub' }
    render(ui(project('p1')))
    await waitFor(() => expect(lockText()).toBe('GitHub'))
    expect(lookup).toHaveBeenCalledWith('p1')
  })

  it('re-checks when the project changes while open', async () => {
    locks = { p1: 'Linear' }
    const { rerender } = render(ui(project('p1')))
    await waitFor(() => expect(lockText()).toBe('Linear'))

    rerender(ui(project('p2')))
    await waitFor(() => expect(lockText()).toBe('unlocked'))
    expect(lookup).toHaveBeenCalledWith('p2')
  })

  it('does not look anything up while closed', () => {
    render(ui(project('p1'), false))
    expect(lookup).not.toHaveBeenCalled()
  })

  it('skips the lookup under Playwright', async () => {
    isPlaywright = true
    locks = { p1: 'Linear' }
    render(ui(project('p1')))
    await waitFor(() => expect(lockText()).toBe('unlocked'))
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('ProjectSettingsDialog active tab', () => {
  type Tab = React.ComponentProps<typeof ProjectSettingsDialog>['initialTab']
  const dialog = (
    open: boolean,
    initialTab: Tab,
    integrationOnboardingProvider: 'linear' | null = null
  ) => (
    <ProjectSettingsDialog
      project={project('p1')}
      open={open}
      onOpenChange={vi.fn()}
      initialTab={initialTab}
      integrationOnboardingProvider={integrationOnboardingProvider}
      onUpdated={vi.fn()}
    />
  )

  it('first open mounts only the initial tab', () => {
    render(dialog(true, 'environment'))
    expect(mountedTabs).toEqual(['environment'])
  })

  it('reopening mounts only the new initial tab, not the previously active one', () => {
    const { rerender } = render(dialog(true, 'tasks/statuses'))
    rerender(dialog(false, 'tasks/statuses'))
    mountedTabs = []

    rerender(dialog(true, 'environment'))
    expect(mountedTabs).toEqual(['environment'])
  })

  it('an onboarding provider opens straight on Integrations', () => {
    render(dialog(true, 'environment', 'linear'))
    expect(mountedTabs).toEqual(['integrations'])
  })

  it('initialTab changing while open switches to it, even with an onboarding provider set', () => {
    const { rerender } = render(dialog(true, 'environment', 'linear'))
    mountedTabs = []

    rerender(dialog(true, 'tasks/statuses', 'linear'))
    expect(mountedTabs).toEqual(['tasks/statuses'])
  })
})
