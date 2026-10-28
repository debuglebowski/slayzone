/**
 * mapPrsToTasks — project PR list → task attribution (manual link, else branch).
 *
 * Run with: pnpm exec vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/domains/worktrees/src/client/pr-task-map.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { Task } from '@slayzone/task-contracts'
import type { GhPullRequest } from '../shared/types'
import { mapPrsToTasks } from './pr-task-map'

const pr = (n: number, head: string, extra: Partial<GhPullRequest> = {}) =>
  ({
    number: n,
    url: `https://x/pull/${n}`,
    headRefName: head,
    isCrossRepository: false,
    ...extra
  }) as GhPullRequest
const task = (id: string, extra: Partial<Task> = {}) =>
  ({ id, pr_url: null, worktree_path: null, ...extra }) as Task
const wt = (path: string, branch: string | null) => ({
  path,
  branch,
  isMain: false
})

describe('mapPrsToTasks', () => {
  it('matches by manual link, else by the task worktree branch', () => {
    const linked = task('a', { pr_url: 'https://x/pull/1' })
    const byBranch = task('b', { worktree_path: '/wt/b' })
    const map = mapPrsToTasks(
      [pr(1, 'other'), pr(2, 'feat-b')],
      [linked, byBranch],
      [wt('/wt/b', 'feat-b')]
    )
    expect(map.get('https://x/pull/1')).toBe(linked)
    expect(map.get('https://x/pull/2')).toBe(byBranch)
  })

  it('a manual link elsewhere takes the task out of branch matching', () => {
    const t = task('a', { pr_url: 'https://x/pull/9', worktree_path: '/wt/a' })
    const map = mapPrsToTasks([pr(2, 'feat-a')], [t], [wt('/wt/a', 'feat-a')])
    expect(map.has('https://x/pull/2')).toBe(false)
  })

  it('never matches fork PRs', () => {
    const t = task('a', { worktree_path: '/wt/a' })
    const map = mapPrsToTasks(
      [pr(3, 'feat', { isCrossRepository: true })],
      [t],
      [wt('/wt/a', 'feat')]
    )
    expect(map.size).toBe(0)
  })

  it('leaves a branch claimed by two tasks (shared worktree) unmatched', () => {
    const t1 = task('a', { worktree_path: '/wt/s' })
    const t2 = task('b', { worktree_path: '/wt/s' })
    expect(mapPrsToTasks([pr(4, 'shared')], [t1, t2], [wt('/wt/s', 'shared')]).size).toBe(0)
  })
})
