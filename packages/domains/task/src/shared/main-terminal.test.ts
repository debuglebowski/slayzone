import { describe, expect, it } from 'vitest'
import type { Task } from '@slayzone/task-contracts'
import {
  mainTerminalCwd,
  mainTerminalProps,
  plainMainTerminalCwd,
  taskRepoName,
  taskRepoPath
} from './main-terminal'

const task = (extra: Partial<Task> = {}): Task =>
  ({
    id: 't',
    terminal_mode: 'claude-code',
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
  it('derives every spawn prop from task + project + modes', () => {
    const p = mainTerminalProps(
      task({ currentConversationByMode: { 'claude-code': 'c1' } } as Partial<Task>),
      { execution_context: null },
      modes
    )
    expect(p).toEqual({
      mode: 'claude-code',
      conversationId: 'c1',
      existingConversationId: 'c1',
      conversationHydrated: true,
      supportsSessionId: true,
      providerFlags: '--x',
      executionContext: null
    })
  })

  it('an unhydrated task holds its spawn; unknown modes do not pre-mint', () => {
    const p = mainTerminalProps(task(), null, [])
    expect(p.conversationHydrated).toBe(false)
    expect(p.supportsSessionId).toBe(false)
    expect(p.conversationId).toBeUndefined()
  })
})

describe('plainMainTerminalCwd', () => {
  const project = folderProject('/p')
  it('is the project root for a task with nothing bound', () => {
    expect(plainMainTerminalCwd(task(), project)).toBe('/p')
  })
  it('is null whenever the cwd needs async resolution or a different root', () => {
    expect(plainMainTerminalCwd(task({ worktree_path: '/w' }), project)).toBeNull()
    expect(plainMainTerminalCwd(task({ base_dir: '/b' }), project)).toBeNull()
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

  it('a worktree wins over everything', () => {
    expect(
      mainTerminalCwd(task({ worktree_path: '/wt', base_dir: '/b' }), project, '/wrap', repos)
    ).toBe('/wt')
  })

  it('then the base dir', () => {
    expect(
      mainTerminalCwd(task({ base_dir: '/b', repo_name: 'api' }), project, '/wrap', repos)
    ).toBe('/b')
  })

  it('then the bound child repo of a multi-repo project', () => {
    expect(mainTerminalCwd(task({ repo_name: 'web' }), project, '/wrap', repos)).toBe('/wrap/web')
    expect(mainTerminalCwd(task(), { selected_repo: 'api' }, '/wrap', repos)).toBe('/wrap/api')
  })

  it('a bound repo that no longer exists falls back to the first detected one', () => {
    expect(mainTerminalCwd(task({ repo_name: 'gone' }), project, '/wrap', repos)).toBe('/wrap/api')
  })

  it('no repo bound, or no child repos: the project root (never an arbitrary child)', () => {
    expect(mainTerminalCwd(task(), project, '/wrap', repos)).toBe('/wrap')
    expect(mainTerminalCwd(task({ repo_name: 'web' }), project, '/wrap', [])).toBe('/wrap')
  })

  it('nothing to run in: null', () => {
    expect(mainTerminalCwd(task(), project, null, [])).toBeNull()
    expect(mainTerminalCwd(task(), null, null, [])).toBeNull()
  })

  it('taskRepoPath is the task-bound axis the page shows (worktree > base dir > resolved repo)', () => {
    expect(taskRepoPath(task({ worktree_path: '/wt' }), '/r')).toBe('/wt')
    expect(taskRepoPath(task({ base_dir: '/b' }), '/r')).toBe('/b')
    expect(taskRepoPath(task(), '/r')).toBe('/r')
    expect(taskRepoPath(null, null)).toBeNull()
  })
})
