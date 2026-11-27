// @vitest-environment jsdom
import type React from 'react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import type { Project } from '@slayzone/projects-contracts'

// Per-project provider whose status sync locks the project (the registered lookup's answer).
let locks: Record<string, string> = {}
let isPlaywright = false
// How many computers the project's hub has (the Computers tab shows only with two+).
let manyComputers = false
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

vi.mock('./sharing/useSharing', () => ({
  useSharingStatus: () => ({ enabled: false, userId: null })
}))
vi.mock('./sharing/MembersTab', () => ({ MembersTab: () => null }))
vi.mock('@slayzone/transport/client', () => ({
  electronBootstrap: { isPlaywright: () => isPlaywright }
}))

vi.mock('@slayzone/ui', () => ({
  cn: (...xs: unknown[]) => xs.filter(Boolean).join(' ')
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
vi.mock('./ComputersTab', () => ({
  ComputersTab: () => {
    useMountLog('computers')
    return null
  },
  useHubHasManyComputers: () => manyComputers
}))
vi.mock('./WorktreesTab', () => ({ WorktreesTab: () => null }))
vi.mock('./ReposTab', () => ({ ReposTab: () => null }))
vi.mock('./TasksGeneralTab', () => ({ TasksGeneralTab: () => null }))
vi.mock('@slayzone/test-panel/client', () => ({ TestsTab: () => null }))

import { ProjectSettingsPanel } from './ProjectSettingsPanel'
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
const ui = (p: Project) => (
  <ProjectSettingsPanel
    project={p}
    tab="tasks/statuses"
    onTabChange={vi.fn()}
    onClose={vi.fn()}
    onUpdated={vi.fn()}
  />
)
const lockText = () => screen.getByTestId('columns-lock').textContent

beforeEach(() => {
  mountedTabs = []
  locks = {}
  isPlaywright = false
  manyComputers = false
  lookup.mockClear()
})

afterEach(cleanup)

describe('ProjectSettingsPanel status lock', () => {
  // Which provider wins and how a failed lookup reads live with the lookup itself
  // (@slayzone/integrations useStatusSyncLockLookup.test.ts).
  it('reports the provider the lookup returns', async () => {
    locks = { p1: 'GitHub' }
    render(ui(project('p1')))
    await waitFor(() => expect(lockText()).toBe('GitHub'))
    expect(lookup).toHaveBeenCalledWith('p1')
  })

  it('re-checks when the project changes', async () => {
    locks = { p1: 'Linear' }
    const { rerender } = render(ui(project('p1')))
    await waitFor(() => expect(lockText()).toBe('Linear'))

    rerender(ui(project('p2')))
    await waitFor(() => expect(lockText()).toBe('unlocked'))
    expect(lookup).toHaveBeenCalledWith('p2')
  })

  it('skips the lookup under Playwright', async () => {
    isPlaywright = true
    locks = { p1: 'Linear' }
    render(ui(project('p1')))
    await waitFor(() => expect(lockText()).toBe('unlocked'))
    expect(lookup).not.toHaveBeenCalled()
  })
})

describe('ProjectSettingsPanel active tab', () => {
  const panel = (tab: string, integrationOnboardingProvider: 'linear' | null = null) => (
    <ProjectSettingsPanel
      project={project('p1')}
      tab={tab}
      onTabChange={vi.fn()}
      onClose={vi.fn()}
      integrationOnboardingProvider={integrationOnboardingProvider}
      onUpdated={vi.fn()}
    />
  )

  it('mounts only the routed tab', () => {
    render(panel('environment'))
    expect(mountedTabs).toEqual(['environment'])
  })

  it('a route change mounts only the new tab', () => {
    const { rerender } = render(panel('tasks/statuses'))
    mountedTabs = []
    rerender(panel('environment'))
    expect(mountedTabs).toEqual(['environment'])
  })

  it('the old "tasks" group key opens its first page', () => {
    render(panel('tasks'))
    expect(mountedTabs).toEqual([])
    expect(
      screen.getByTestId('project-settings-tab-tasks/general').getAttribute('aria-selected')
    ).toBe('true')
  })

  it('an onboarding provider opens straight on Integrations', () => {
    render(panel('environment', 'linear'))
    expect(mountedTabs).toEqual(['integrations'])
  })

  it('Computers: offered only when the hub has more than one computer', () => {
    const { unmount } = render(panel('computers'))
    expect(screen.queryByTestId('project-settings-tab-computers')).toBeNull()
    // Not routable either: an old link falls back to nothing, never a tab that is hidden.
    expect(mountedTabs).toEqual([])
    unmount()
    manyComputers = true
    render(panel('computers'))
    expect(screen.getByTestId('project-settings-tab-computers').getAttribute('aria-selected')).toBe(
      'true'
    )
    expect(mountedTabs).toEqual(['computers'])
  })
})
