import { chatCwdFromSession, chatCwdFromTask, chosenFolder } from './chat-cwd'

const task = (
  fields: Partial<{
    has_worktree: boolean
    has_base_dir: boolean
    repo_name: string | null
    computer_id: string | null
  }> = {}
) => ({
  has_worktree: false,
  has_base_dir: false,
  repo_name: null,
  computer_id: null,
  ...fields
})
const ok = (worktreePath: string | null, baseDir: string | null = null) =>
  ({ state: 'ok', worktreePath, baseDir }) as const

describe('chatCwdFromSession', () => {
  it("is the folder of the tab's session on the hub, when it is this task's", () => {
    expect(chatCwdFromSession({ taskId: 't1', cwd: '/live' }, 't1')).toBe('/live')
  })

  it('is unknown without a session, or when the tab id backs another task', () => {
    expect(chatCwdFromSession(null, 't1')).toBeNull()
    expect(chatCwdFromSession({ taskId: 'other', cwd: '/x' }, 't1')).toBeNull()
  })
})

describe('chatCwdFromTask', () => {
  // A project has one folder per computer; the hub says which computer it uses.
  const project = {
    selected_repo: null,
    placements: [
      { computer_id: 'mac', path: '/proj', status: 'ready' as const },
      { computer_id: 'box', path: '/srv/proj', status: 'pending' as const }
    ],
    resolved_computer_id: 'mac'
  }

  it("resolves the folder desktop starts the task in: worktree, base dir, the project's folder", () => {
    expect(chatCwdFromTask(task({ has_worktree: true }), project, [], ok('/wt'))).toEqual({
      cwd: '/wt'
    })
    expect(chatCwdFromTask(task({ has_base_dir: true }), project, [], ok(null, '/base'))).toEqual({
      cwd: '/base'
    })
    expect(chatCwdFromTask(task(), project, [])).toEqual({ cwd: '/proj' })
  })

  it('a worktree / base dir waits for the computer (§9 7d), never the project folder', () => {
    expect(chatCwdFromTask(task({ has_worktree: true }), project, [])).toEqual({
      needsPaths: true
    })
    expect(
      chatCwdFromTask(task({ has_worktree: true }), project, [], {
        state: 'offline',
        computerId: 'mac'
      })
    ).toEqual({ needsPaths: true })
  })

  it("takes the project's folder on the computer the task runs on", () => {
    expect(chatCwdFromTask(task({ computer_id: 'box' }), project, [])).toEqual({
      cwd: '/srv/proj'
    })
  })

  it("asks for the project's child repos (on that folder) only when a bound repo decides it", () => {
    const bound = task({ repo_name: 'api' })
    expect(chatCwdFromTask(bound, project, null)).toEqual({ needsRepos: '/proj' })
    expect(chatCwdFromTask(bound, project, [{ name: 'api', path: '/proj/api' }])).toEqual({
      cwd: '/proj/api'
    })
    expect(chatCwdFromTask(task(), project, null)).toEqual({ cwd: '/proj' })
  })

  it("reads an older hub's single project folder (no placements)", () => {
    const legacy = { selected_repo: null, path: '/legacy' }
    expect(chatCwdFromTask(task(), legacy, [])).toEqual({ cwd: '/legacy' })
  })

  it('says when the task has no folder to run in', () => {
    const none = { selected_repo: null, placements: [], resolved_computer_id: 'mac' }
    expect(chatCwdFromTask(task(), none, [])).toEqual({ cwd: null })
    expect(chatCwdFromTask(task({ computer_id: 'elsewhere' }), project, [])).toEqual({ cwd: null })
    expect(chatCwdFromTask(task(), null, [])).toEqual({ cwd: null })
  })
})

describe('chosenFolder', () => {
  const project = (placements: Array<{ computer_id: string; path: string; status: string }>) => ({
    selected_repo: null,
    placements: placements as never,
    resolved_computer_id: 'c1'
  })

  it("is the folder chosen on the task's computer, in any state", () => {
    const p = project([
      { computer_id: 'c1', path: '/gone', status: 'missing' },
      { computer_id: 'c2', path: '/other', status: 'ready' }
    ])
    expect(chosenFolder(task(), p)).toBe('/gone')
    expect(chosenFolder(task({ computer_id: 'c2' }), p)).toBe('/other')
  })

  it('is null when none was chosen there', () => {
    expect(chosenFolder(task(), project([]))).toBeNull()
    expect(chosenFolder(task(), null)).toBeNull()
  })
})
