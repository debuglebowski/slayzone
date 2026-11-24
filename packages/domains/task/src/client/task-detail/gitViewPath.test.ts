/**
 * Which repo the task's git panel views. A worktree task's worktree is never in the
 * project's repo list (the panel views the project's repo and reads the worktree as
 * the task's checkout), so guessing the worktree while that list loads made the panel
 * start on it, then jump to the project repo: every read thrown away and redone.
 */
import { describe, expect, it } from 'vitest'
import { gitViewPath } from './gitViewPath'

const repos = [
  { name: 'root', path: '/p' },
  { name: 'child', path: '/p/child' }
]

describe('gitViewPath', () => {
  it("the user's pick, while it is listed", () => {
    expect(
      gitViewPath({
        picked: '/p/child',
        repos,
        reposSettled: true,
        taskBound: '/p',
        hasWorktree: false
      })
    ).toBe('/p/child')
  })

  it('the task-bound repo when listed, else the first listed', () => {
    expect(
      gitViewPath({
        picked: null,
        repos,
        reposSettled: true,
        taskBound: '/p/child',
        hasWorktree: false
      })
    ).toBe('/p/child')
    expect(
      gitViewPath({ picked: null, repos, reposSettled: true, taskBound: '/wt', hasWorktree: true })
    ).toBe('/p')
  })

  it('no worktree: the task-bound folder at once, while the list loads', () => {
    expect(
      gitViewPath({
        picked: null,
        repos: [],
        reposSettled: false,
        taskBound: '/p',
        hasWorktree: false
      })
    ).toBe('/p')
  })

  it('a worktree task waits for the list instead of starting on the worktree', () => {
    expect(
      gitViewPath({
        picked: null,
        repos: [],
        reposSettled: false,
        taskBound: '/wt',
        hasWorktree: true
      })
    ).toBeNull()
  })

  it('a worktree task with no list to be had (failed / empty): its worktree', () => {
    expect(
      gitViewPath({
        picked: null,
        repos: [],
        reposSettled: true,
        taskBound: '/wt',
        hasWorktree: true
      })
    ).toBe('/wt')
  })
})
