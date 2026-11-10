import { describe, expect, it } from 'vitest'
import type { Task } from '@slayzone/task-contracts'
import {
  mainTerminalCwd,
  mainTerminalCwdFrom,
  mainTerminalCwdNeedsRepos,
  ownFolderMissing,
  mainTerminalProps,
  plainMainTerminalCwd,
  taskRepoName,
  taskRepoPath
} from './main-terminal'

const task = (extra: Partial<Task> = {}): Task =>
  ({
    id: 't',
    agent_id: 'claude-code',
    provider_config: { 'claude-code': { flags: '--x' } },
    worktree_path: null,
    base_dir: null,
    repo_name: null,
    ...extra
  }) as unknown as Task

const modes = [{ id: 'claude-code', initialCommand: 'claude --session-id {id} {flags}' }]

/** A project whose folder on its computer (`c1`) is `path` (null = no folder). */
const folderProject = (path: string | null, selected_repo: string | null = null) => ({
  placements: path ? [{ computer_id: 'c1', path, status: 'ready' as const }] : [],
  resolved_computer_id: 'c1',
  selected_repo
})

describe('mainTerminalProps', () => {
  it('derives every spawn prop from task + project + modes, with no conversation hint', () => {
    // The resume is decided at spawn by the agent's computer (robustness plan §9).
    const p = mainTerminalProps(task(), { execution_context: null }, modes)
    expect(p).toEqual({
      mode: 'claude-code',
      supportsSessionId: true,
      providerFlags: '--x',
      executionContext: null
    })
  })

  it('unknown modes do not pre-mint', () => {
    expect(mainTerminalProps(task(), null, []).supportsSessionId).toBe(false)
  })
})

describe('plainMainTerminalCwd', () => {
  const project = folderProject('/p')
  it('is the project root for a task with nothing bound', () => {
    expect(plainMainTerminalCwd(task(), project)).toBe('/p')
  })
  it('is null whenever the cwd needs async resolution or a different root', () => {
    expect(plainMainTerminalCwd(task({ has_worktree: true }), project)).toBeNull()
    expect(plainMainTerminalCwd(task({ has_base_dir: true }), project)).toBeNull()
    expect(plainMainTerminalCwd(task({ repo_name: 'r' }), project)).toBeNull()
    expect(plainMainTerminalCwd(task(), folderProject('/p', 'r'))).toBeNull()
    expect(plainMainTerminalCwd(task(), folderProject(null))).toBeNull()
  })
})

describe('main terminal cwd', () => {
  // The project's folder on the task's computer is passed in (`projectRoot`).
  const project = { selected_repo: null }
  const repos = [
    { name: 'api', path: '/wrap/api' },
    { name: 'web', path: '/wrap/web' }
  ]

  it('the task-bound repo name wins over the project default', () => {
    expect(taskRepoName(task({ repo_name: 'web' }), { selected_repo: 'api' })).toBe('web')
    expect(taskRepoName(task(), { selected_repo: 'api' })).toBe('api')
    expect(taskRepoName(null, null)).toBeNull()
  })

  const ok = (worktreePath: string | null, baseDir: string | null = null) =>
    ({ state: 'ok', worktreePath, baseDir }) as const
  const own = task({ has_worktree: true, has_base_dir: true })

  it('a worktree wins over everything (paths as the computer answered)', () => {
    expect(mainTerminalCwd(own, project, '/wrap', repos, ok('/wt', '/b'))).toBe('/wt')
  })

  it('then the base dir', () => {
    expect(
      mainTerminalCwd(
        task({ has_base_dir: true, repo_name: 'api' }),
        project,
        '/wrap',
        repos,
        ok(null, '/b')
      )
    ).toBe('/b')
  })

  it('own folder not read yet / computer away: null, NEVER the project folder (§9 7d)', () => {
    expect(mainTerminalCwd(own, project, '/wrap', repos, null)).toBeNull()
    expect(
      mainTerminalCwd(own, project, '/wrap', repos, { state: 'offline', computerId: 'pc' })
    ).toBeNull()
    expect(mainTerminalCwdNeedsRepos(own, project, '/wrap')).toBe(false)
  })

  it('then the bound child repo of a multi-repo project', () => {
    expect(mainTerminalCwd(task({ repo_name: 'web' }), project, '/wrap', repos, null)).toBe(
      '/wrap/web'
    )
    expect(mainTerminalCwd(task(), { selected_repo: 'api' }, '/wrap', repos, null)).toBe(
      '/wrap/api'
    )
  })

  it('a bound repo that no longer exists falls back to the first detected one', () => {
    expect(mainTerminalCwd(task({ repo_name: 'gone' }), project, '/wrap', repos, null)).toBe(
      '/wrap/api'
    )
  })

  it('no repo bound, or no child repos: the project root (never an arbitrary child)', () => {
    expect(mainTerminalCwd(task(), project, '/wrap', repos, null)).toBe('/wrap')
    expect(mainTerminalCwd(task({ repo_name: 'web' }), project, '/wrap', [], null)).toBe('/wrap')
  })

  it('nothing to run in: null', () => {
    expect(mainTerminalCwd(task(), project, null, [], null)).toBeNull()
    expect(mainTerminalCwd(task(), null, null, [], null)).toBeNull()
  })

  it('taskRepoPath is the task-bound axis the page shows (worktree > base dir > resolved repo)', () => {
    expect(taskRepoPath(task({ has_worktree: true }), '/r', ok('/wt'))).toBe('/wt')
    expect(taskRepoPath(task({ has_base_dir: true }), '/r', ok(null, '/b'))).toBe('/b')
    expect(taskRepoPath(task({ has_worktree: true }), '/r', null)).toBeNull()
    expect(taskRepoPath(task(), '/r', null)).toBe('/r')
    expect(taskRepoPath(null, null, null)).toBeNull()
  })

  it('S7: a task with its own folder and no known path never runs in the project folder', () => {
    const own = task({ has_worktree: true })
    // Loading / offline / missing on its computer: taskRepoPath is null.
    expect(mainTerminalCwdFrom(own, null, '/project')).toBeNull()
    expect(mainTerminalCwdFrom(task({ has_base_dir: true }), '', '/project')).toBeNull()
    expect(mainTerminalCwdFrom(own, '/wt', '/project')).toBe('/wt')
    // No folder of its own: the project folder is the task's folder.
    expect(mainTerminalCwdFrom(task(), null, '/project')).toBe('/project')
    expect(mainTerminalCwdFrom(task(), '/project/web', '/project')).toBe('/project/web')
  })

  it('S7: ownFolderMissing — its computer answered and holds no folder for it', () => {
    const own = task({ has_worktree: true })
    expect(ownFolderMissing(own, ok(null))).toBe(true)
    expect(ownFolderMissing(own, ok('/wt'))).toBe(false)
    expect(ownFolderMissing(task({ has_base_dir: true }), ok(null, '/b'))).toBe(false)
    // Not answered yet / away: not "missing" — unknown.
    expect(ownFolderMissing(own, null)).toBe(false)
    expect(ownFolderMissing(own, { state: 'offline', computerId: 'pc' })).toBe(false)
    expect(ownFolderMissing(task(), ok(null))).toBe(false)
  })
})
