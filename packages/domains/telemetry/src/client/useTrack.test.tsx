// @vitest-environment jsdom
/**
 * `useTrack` attributes every event to a hub, so a hub with
 * `SLAYZONE_HUB_ENABLE_TELEMETRY=0` can withhold exactly its own events:
 *
 *   - `trackTask` / `trackProject`: the hub that OWNS the task / project (the ownership
 *     map every write consults), else the ambient hub — boards, palettes and menus act on
 *     other hubs' tasks from outside their scope;
 *   - `track` / `trackShortcut`: the hub whose UI the event happened in (nearest HubScope).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { renderHook } from '@testing-library/react'

const telemetry = vi.hoisted(() => ({ trackForHub: vi.fn() }))
vi.mock('./telemetry', () => telemetry)

// The nearest HubScope's hub id (null = outside any scope).
const scope = vi.hoisted(() => ({ hubId: null as string | null }))
vi.mock('@slayzone/transport/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@slayzone/transport/client')>()
  return { ...actual, useHubId: () => scope.hubId }
})

import { useHubOwnershipStore } from '@slayzone/transport/client'
import { useTrack } from './useTrack'

const calls = () => telemetry.trackForHub.mock.calls

beforeEach(() => {
  telemetry.trackForHub.mockClear()
  scope.hubId = 'local'
  useHubOwnershipStore
    .getState()
    .setOwnership(new Map([['p-remote', 'hub:remote']]), new Map([['t-remote', 'hub:remote']]))
})

describe('useTrack', () => {
  it('track: the hub whose UI it happened in', () => {
    scope.hubId = 'hub:remote'
    const { result } = renderHook(() => useTrack())
    result.current.track('zen_mode_toggled')
    expect(calls()).toEqual([['hub:remote', 'zen_mode_toggled']])
  })

  it('track outside any HubScope: the home hub (null)', () => {
    scope.hubId = null
    const { result } = renderHook(() => useTrack())
    result.current.track('theme_changed', { mode: 'dark' })
    expect(calls()).toEqual([[null, 'theme_changed', { mode: 'dark' }]])
  })

  it('trackShortcut: an ambient keyboard_shortcut_used', () => {
    const { result } = renderHook(() => useTrack())
    result.current.trackShortcut('mod+k')
    expect(calls()).toEqual([['local', 'keyboard_shortcut_used', { key: 'mod+k' }]])
  })

  it('trackTask: the hub that owns the task, wherever the event happened', () => {
    const { result } = renderHook(() => useTrack())
    result.current.trackTask('t-remote', 'task_status_changed', { from: 'todo', to: 'done' })
    expect(calls()).toEqual([['hub:remote', 'task_status_changed', { from: 'todo', to: 'done' }]])
  })

  it('trackTask for a task the ownership map does not know: the ambient hub', () => {
    const { result } = renderHook(() => useTrack())
    result.current.trackTask('t-unknown', 'task_snoozed')
    expect(calls()).toEqual([['local', 'task_snoozed']])
  })

  it('trackProject: the hub that owns the project; none selected → the ambient hub', () => {
    const { result } = renderHook(() => useTrack())
    result.current.trackProject('p-remote', 'filter_applied', { type: 'tag' })
    result.current.trackProject(null, 'filter_applied', { type: 'tag' })
    expect(calls()).toEqual([
      ['hub:remote', 'filter_applied', { type: 'tag' }],
      ['local', 'filter_applied', { type: 'tag' }]
    ])
  })

  it('an event about a task or project cannot be sent without naming it (types)', () => {
    const { result } = renderHook(() => useTrack())
    // @ts-expect-error — a task event names its task (trackTask)
    result.current.track('task_snoozed')
    // @ts-expect-error — a project event names its project (trackProject)
    result.current.track('project_switched')
    expect(calls()).toHaveLength(2)
  })
})
