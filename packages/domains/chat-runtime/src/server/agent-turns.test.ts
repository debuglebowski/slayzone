/**
 * Agent-turn snapshots live only on the computer holding the checkout (robustness
 * plan §9, P0; hub migration v207). The store records a turn (snapshot, dedupe,
 * per-worktree cap), lists it for the diff panel, takes the hub's old rows once, and
 * forgets them with the task's erasure.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { createAgentTurns, type TurnGit } from './agent-turns'
import { agentPromptImport, agentTurnImport } from './history-imports'
import { createLocalPrompts } from './prompts'
import { openChatStorage } from './storage'
import { createComputerTaskData } from './task-data'
import { finishStoredTaskErasure, prepareStoredTaskErasure } from './erase-stored-task'

const roots: string[] = []
const stores: Array<ReturnType<typeof openChatStorage>> = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})
function tmp(prefix: string) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}
function open() {
  const s = openChatStorage({ stateDir: tmp('slz-turns-'), hubScope: 'hub' })
  stores.push(s)
  return s
}
function git(repo: string, ...args: string[]) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}
function repo() {
  const dir = tmp('slz-turns-repo-')
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 't@t')
  git(dir, 'config', 'user.name', 't')
  writeFileSync(join(dir, 'seed.txt'), 'initial')
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'init')
  return dir
}

/** The real turn git, unjailed (the computer's handler jails it). */
async function localGit(): Promise<TurnGit> {
  const { runTurnGitOpLocally } = await import('../../../agent-turns/src/server/turn-git')
  return {
    canonical: (repoPath) => runTurnGitOpLocally('canonical', { repoPath }),
    snapshot: (repoPath, turnId) => runTurnGitOpLocally('snapshot', { repoPath, turnId }),
    deleteTurnRef: async (repoPath, turnId) => {
      await runTurnGitOpLocally('deleteTurnRef', { repoPath, turnId })
    },
    diffIsEmpty: (repoPath, from, to, cached) =>
      runTurnGitOpLocally('diffIsEmpty', { repoPath, from, to, cached }),
    filterTurns: (repoPath, rows) =>
      runTurnGitOpLocally('filterTurns', {
        repoPath,
        rows: rows as unknown as Array<Record<string, unknown>>
      }) as never
  }
}

describe('agent turns on the computer', () => {
  test('records a turn with changes, dedupes an identical one, lists it with its range', async () => {
    const storage = open()
    const turns = createAgentTurns(storage, await localGit())
    const dir = repo()
    expect(
      await turns.handle({
        op: 'record',
        projectId: null,
        taskId: 't',
        tabId: 't',
        repoPath: dir,
        promptPreview: ''
      })
    ).toEqual({
      recorded: false
    })
    writeFileSync(join(dir, 'a.txt'), 'one')
    const first = await turns.handle({
      op: 'record',
      projectId: null,
      taskId: 't',
      tabId: 't',
      repoPath: dir,
      promptPreview: 'add a'
    })
    expect(first).toMatchObject({ recorded: true, worktreePath: dir })
    // Nothing changed since: deduped.
    expect(
      await turns.handle({
        op: 'record',
        projectId: null,
        taskId: 't',
        tabId: 't',
        repoPath: dir,
        promptPreview: 'x'
      })
    ).toEqual({ recorded: false })
    const listed = (await turns.handle({
      op: 'list',
      taskId: 't',
      projectId: null,
      repoPath: dir
    })) as {
      worktreePath: string
      rows: Array<{
        id: string
        task_id: string | null
        prompt_preview: string
        prev_snapshot_sha: string | null
      }>
    }
    expect(listed.worktreePath).toBe(dir)
    expect(listed.rows).toHaveLength(1)
    expect(listed.rows[0]).toMatchObject({ task_id: 't', prompt_preview: 'add a' })
  })

  test('a deleted task records nothing', async () => {
    const storage = open()
    const turns = createAgentTurns(storage, await localGit())
    const dir = repo()
    writeFileSync(join(dir, 'a.txt'), 'one')
    storage.applyTaskLifecycle('t', 'deleted', 1)
    expect(
      await turns.handle({
        op: 'record',
        projectId: null,
        taskId: 't',
        tabId: 't',
        repoPath: dir,
        promptPreview: ''
      })
    ).toEqual({ recorded: false })
  })

  test('keeps the newest 50 turns per worktree', async () => {
    const storage = open()
    const turns = createAgentTurns(storage, await localGit())
    const dir = repo()
    for (let i = 0; i < 52; i++)
      turns.store.insert({
        id: `old-${String(i).padStart(2, '0')}`,
        worktree_path: dir,
        task_id: 't',
        terminal_tab_id: 't',
        snapshot_sha: 'x',
        head_sha_at_snap: 'y',
        prompt_preview: '',
        created_at: i
      })
    writeFileSync(join(dir, 'a.txt'), 'one')
    await turns.handle({
      op: 'record',
      taskId: 't',
      tabId: 't',
      projectId: null,
      repoPath: dir,
      promptPreview: ''
    })
    const ids = turns.store.ids(dir)
    expect(ids).toHaveLength(50)
    expect(ids).not.toContain('old-00')
    expect(ids).not.toContain('old-02')
    expect(ids).toContain('old-03')
  })

  test('hand-off imports are idempotent, keep a local row, and fill a moved preview', () => {
    const storage = open()
    const data = createComputerTaskData({
      storage,
      computerId: 'pc',
      imports: { 'agent-turn': agentTurnImport, 'agent-prompt': agentPromptImport },
      providerConfig: () => ({})
    })
    // A preview the legacy chat migration already moved here (the hub row was blanked).
    storage.createConversation({ id: 'c1', taskId: 't', tabId: 't', mode: 'claude-chat', epoch: 1 })
    storage.putRecord('c1', 1, {
      kind: 'settings',
      id: 'legacy-turn-preview:turn-1',
      value: { id: 'turn-1', promptPreview: 'moved preview' },
      at: 1
    })
    const turn = {
      id: 'turn-1',
      worktreePath: '/w',
      taskId: 't',
      tabId: 't',
      snapshotSha: 's',
      headShaAtSnap: 'h',
      promptPreview: '',
      createdAt: 5
    }
    const r1 = data.importBatch({
      kind: 'agent-turn',
      items: [{ key: 'turn-1', taskId: 't', value: turn }]
    })
    expect(r1.applied).toEqual(['turn-1'])
    data.importBatch({
      kind: 'agent-turn',
      items: [{ key: 'turn-1', taskId: 't', value: { ...turn, promptPreview: 'stale' } }]
    })
    const turns = createAgentTurns(storage, {} as TurnGit)
    expect(turns.store.get('turn-1')).toMatchObject({
      prompt_preview: 'moved preview',
      task_id: 't'
    })
    // An orphan turn (its task was deleted on the hub) keeps no task.
    data.importBatch({
      kind: 'agent-turn',
      items: [{ key: 'turn-2', taskId: 't', value: { ...turn, id: 'turn-2', taskId: null } }]
    })
    expect(turns.store.get('turn-2')).toMatchObject({ task_id: null })

    const prompt = {
      id: 'p1',
      agentId: 'claude-code',
      cliSessionId: 'sess',
      text: 'hello',
      createdAt: 3
    }
    data.importBatch({ kind: 'agent-prompt', items: [{ key: 'p1', taskId: 't', value: prompt }] })
    data.importBatch({ kind: 'agent-prompt', items: [{ key: 'p1', taskId: 't', value: prompt }] })
    expect(createLocalPrompts(storage).list('t')).toEqual([
      {
        id: 'p1',
        task_id: 't',
        agent_id: 'claude-code',
        cli_session_id: 'sess',
        text: 'hello',
        created_at: 3
      }
    ])
  })

  test("a task's erasure removes its turns", () => {
    const storage = open()
    const turns = createAgentTurns(storage, {} as TurnGit)
    for (const [id, task] of [
      ['a', 't'],
      ['b', 'other']
    ])
      turns.store.insert({
        id,
        worktree_path: '/w',
        task_id: task,
        terminal_tab_id: task,
        snapshot_sha: 's',
        head_sha_at_snap: 'h',
        prompt_preview: 'p',
        created_at: 1
      })
    const root = tmp('slz-turns-erase-')
    storage.compose((raw) => {
      prepareStoredTaskErasure(raw, 't')
      finishStoredTaskErasure(raw, root, 't')
    })
    expect(turns.store.get('a')).toBeNull()
    expect(turns.store.get('b')).not.toBeNull()
  })

  test("a task's deletion here forgets its turns at once (no turn of a deleted task)", async () => {
    const storage = open()
    const turns = createAgentTurns(storage, {} as TurnGit)
    for (const [id, task] of [
      ['a', 't'],
      ['b', 'other']
    ])
      turns.store.insert({
        id,
        worktree_path: '/w',
        task_id: task,
        terminal_tab_id: task,
        snapshot_sha: 's',
        head_sha_at_snap: 'h',
        prompt_preview: '',
        created_at: 1
      })
    storage.applyTaskLifecycle('t', 'deleted', 1)
    expect(turns.store.get('a')).toBeNull()
    expect(turns.store.get('b')).not.toBeNull()
    expect(await turns.handle({ op: 'deletedTaskTurns' })).toEqual([])
  })

  test('retention blanks old previews, keeps the turn', () => {
    const storage = open()
    const turns = createAgentTurns(storage, {} as TurnGit)
    turns.store.insert({
      id: 'old',
      worktree_path: '/w',
      task_id: 't',
      terminal_tab_id: 't',
      snapshot_sha: 's',
      head_sha_at_snap: 'h',
      prompt_preview: 'secret',
      created_at: 1
    })
    turns.store.insert({
      id: 'new',
      worktree_path: '/w',
      task_id: 't',
      terminal_tab_id: 't',
      snapshot_sha: 's2',
      head_sha_at_snap: 'h',
      prompt_preview: 'fresh',
      created_at: 1000
    })
    expect(turns.store.redactPreviewsBefore(500)).toBe(1)
    expect(turns.store.get('old')).toMatchObject({ prompt_preview: '' })
    expect(turns.store.get('new')).toMatchObject({ prompt_preview: 'fresh' })
  })
})
