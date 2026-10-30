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

// A hub one release behind (multi-hub federation, a stale sidecar) sends projects
// without placements. That is "no folder known", never a crash in a render path.
test('a project from a hub that sends no placements has no folder, and does not throw', () => {
  const older = { id: 'p', name: 'Old' } as unknown as Project
  expect(placementOn(older, 'c1')).toBeNull()
  expect(defaultProjectRoot(older)).toBeNull()
  expect(taskProjectRoot({ computer_id: 'c1' }, older)).toBeNull()
})
