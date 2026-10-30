/**
 * Reading a project's folder on a computer from the Project the hub returned.
 *
 * Run with: vitest, packages/shared/test-utils/vitest.harness.config.ts (see run-all.sh).
 */
import { expect, test } from 'vitest'
import type { Project } from './types'
import { defaultProjectRoot, placementOn, projectRootOn, taskProjectRoot } from './placements'

const project = {
  placements: [
    { computer_id: 'c1', path: '/ready', status: 'ready' },
    { computer_id: 'c2', path: '/pending', status: 'pending' },
    { computer_id: 'c3', path: '/missing', status: 'missing' }
  ],
  resolved_computer_id: 'c1'
} as unknown as Project

test('a usable folder (ready or pending) is the folder; a missing one is not', () => {
  expect(projectRootOn(project, 'c1')).toBe('/ready')
  expect(projectRootOn(project, 'c2')).toBe('/pending')
  expect(projectRootOn(project, 'c3')).toBeNull()
  expect(placementOn(project, 'c3')?.status).toBe('missing')
})

test('project-wide views use the resolved computer; a task its own computer first', () => {
  expect(defaultProjectRoot(project)).toBe('/ready')
  expect(taskProjectRoot({ computer_id: 'c2' }, project)).toBe('/pending')
  expect(taskProjectRoot({ computer_id: null }, project)).toBe('/ready')
})

// A hub from before folders moved to computers (an older remote hub, a hub process
// not yet restarted after an update) sends no placements, only its one `path`: the
// folder it starts every agent in, whichever computer runs it. Showing "no folder"
// there would be a false claim.
test('a project from an older hub (no placements) uses its path, on any computer', () => {
  const older = { id: 'p', name: 'Old', path: '/old/app' } as unknown as Project
  expect(placementOn(older, 'c1')).toMatchObject({ path: '/old/app', status: 'ready' })
  expect(defaultProjectRoot(older)).toBe('/old/app')
  expect(taskProjectRoot({ computer_id: 'c1' }, older)).toBe('/old/app')
  expect(taskProjectRoot({ computer_id: null }, older)).toBe('/old/app')
})

test('a project from an older hub with no path has no folder, and does not throw', () => {
  for (const path of [undefined, null, '']) {
    const older = { id: 'p', name: 'Old', path } as unknown as Project
    expect(placementOn(older, 'c1')).toBeNull()
    expect(defaultProjectRoot(older)).toBeNull()
  }
})

// A current hub's empty list is "no folder anywhere", even if a stray `path` came along.
test('placements, when present, win over any path', () => {
  const current = { placements: [], resolved_computer_id: 'c1', path: '/x' } as unknown as Project
  expect(defaultProjectRoot(current)).toBeNull()
})
