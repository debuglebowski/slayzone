/**
 * turn-tracker integration tests (worktree-scoped).
 * Run: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/agent-turns/src/main/turn-tracker.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { recordTurnBoundary, initChatTurnSubscriber, initPtyTurnSubscriber } from './turn-tracker.js'
import { listTurnsForWorktree } from './db.js'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

function git(repo: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function mkRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-tt-')))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@test')
  git(dir, 'config', 'user.name', 'test')
  fs.writeFileSync(path.join(dir, 'seed.txt'), 'initial')
  git(dir, 'add', '.')
  git(dir, 'commit', '-m', 'init')
  return dir
}

const repos: string[] = []
const h = await createTestHarness()
const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')

function freshTask(): { taskId: string; tabId: string; repo: string } {
  const repo = mkRepo()
  repos.push(repo)
  const taskId = crypto.randomUUID()
  const tabId = `tab-${taskId.slice(0, 8)}`
  h.db
    .prepare('INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, ?, ?)')
    .run(taskId, projectId, 'T', repo)
  h.db
    .prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)')
    .run(tabId, taskId, 'claude-code', 0)
  return { taskId, tabId, repo }
}

await describe('recordTurnBoundary — single snapshot per call', () => {
  test('first call inserts row scoped to worktree, prev_snapshot_sha null', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'first.txt'), 'first edit')
    await recordTurnBoundary(h.db, tabId, 'first prompt')
    const list = listTurnsForWorktree(h.db, repo)
    expect(list).toHaveLength(1)
    expect(list[0].prompt_preview).toBe('first prompt')
    expect(list[0].prev_snapshot_sha).toBeNull()
    expect(list[0].worktree_path).toBe(repo)
  })

  test('second call with new edits → row chained via prev_snapshot_sha', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'first.txt'), 'first edit')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'edit.txt'), 'change 1')
    await recordTurnBoundary(h.db, tabId, 'p2')
    const list = listTurnsForWorktree(h.db, repo)
    expect(list).toHaveLength(2)
    expect(list[1].prev_snapshot_sha).toBe(list[0].snapshot_sha)
  })

  test('repeat with no edits → dedupe drops it', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'first.txt'), 'first')
    await recordTurnBoundary(h.db, tabId, 'p1')
    // No edits between calls — second call must be deduped.
    await recordTurnBoundary(h.db, tabId, 'p2-noop')
    expect(listTurnsForWorktree(h.db, repo)).toHaveLength(1)
  })

  test('first call with NO edits (clean worktree) → dropped', async () => {
    const { tabId, repo } = freshTask()
    await recordTurnBoundary(h.db, tabId, 'noop on clean tree')
    expect(listTurnsForWorktree(h.db, repo)).toHaveLength(0)
  })
})

await describe('multi-task in same worktree', () => {
  test('two tasks share one worktree → unified turn list, task_id preserved per row', async () => {
    const repo = mkRepo()
    repos.push(repo)
    const taskA = crypto.randomUUID()
    const taskB = crypto.randomUUID()
    const tabA = `tab-${taskA.slice(0, 8)}`
    const tabB = `tab-${taskB.slice(0, 8)}`
    h.db.prepare('INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, ?, ?)').run(taskA, projectId, 'A', repo)
    h.db.prepare('INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, ?, ?)').run(taskB, projectId, 'B', repo)
    h.db.prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)').run(tabA, taskA, 'claude-code', 0)
    h.db.prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)').run(tabB, taskB, 'claude-code', 0)

    fs.writeFileSync(path.join(repo, 'a.txt'), 'from A')
    await recordTurnBoundary(h.db, tabA, 'A first')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'from B')
    await recordTurnBoundary(h.db, tabB, 'B first')

    const list = listTurnsForWorktree(h.db, repo)
    expect(list).toHaveLength(2)
    expect(list[0].task_id).toBe(taskA)
    expect(list[1].task_id).toBe(taskB)
  })
})

await describe('task deletion sets task_id to NULL but keeps the turn', () => {
  test('ON DELETE SET NULL', async () => {
    const { taskId, tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'before-delete.txt'), 'data')
    await recordTurnBoundary(h.db, tabId, 'before delete')
    expect(listTurnsForWorktree(h.db, repo)[0].task_id).toBe(taskId)

    // Cascade deletes the tab too. Drop tab first to avoid FK noise.
    h.db.prepare('DELETE FROM terminal_tabs WHERE id = ?').run(tabId)
    h.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId)

    const list = listTurnsForWorktree(h.db, repo)
    expect(list).toHaveLength(1)
    expect(list[0].task_id).toBeNull()
  })
})

await describe('worktree path fallback', () => {
  test('uses project.path when task.worktree_path empty', async () => {
    const repo = mkRepo()
    repos.push(repo)
    const altProj = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color, path) VALUES (?, ?, ?, ?)').run(altProj, 'fb', '#0', repo)
    const taskId = crypto.randomUUID()
    const tabId = `tab-${taskId.slice(0, 8)}`
    h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)').run(taskId, altProj, 'T')
    h.db.prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)').run(tabId, taskId, 'claude-code', 0)
    fs.writeFileSync(path.join(repo, 'fb.txt'), 'fb')
    await recordTurnBoundary(h.db, tabId, 'x')
    expect(listTurnsForWorktree(h.db, repo)).toHaveLength(1)
  })

  test('skips when both worktree_path AND project.path empty', async () => {
    const noPathProj = crypto.randomUUID()
    h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(noPathProj, 'np', '#0')
    const taskId = crypto.randomUUID()
    const tabId = `tab-${taskId.slice(0, 8)}`
    h.db.prepare('INSERT INTO tasks (id, project_id, title) VALUES (?, ?, ?)').run(taskId, noPathProj, 'T')
    h.db.prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)').run(tabId, taskId, 'claude-code', 0)
    await recordTurnBoundary(h.db, tabId, 'x')
    // Nothing inserted for this specific task
    const row = h.db.prepare('SELECT COUNT(*) as c FROM agent_turns WHERE task_id = ?').get(taskId)
    expect(row).toEqual({ c: 0 })
  })
})

await describe('snapshot fail (no .git)', () => {
  test('no row inserted', async () => {
    const { tabId, repo } = freshTask()
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true })
    await recordTurnBoundary(h.db, tabId, 'x')
    expect(listTurnsForWorktree(h.db, repo)).toHaveLength(0)
  })
})

await describe('prompt_preview truncation', () => {
  test('clamps to 200 chars + collapses whitespace', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'a.txt'), 'something')
    await recordTurnBoundary(h.db, tabId, '   line1\n\n\nline2 ' + 'x'.repeat(500))
    const list = listTurnsForWorktree(h.db, repo)
    expect(list[0].prompt_preview.length).toBe(200)
    expect(list[0].prompt_preview.startsWith('line1 line2')).toBe(true)
  })
})

await describe('retention: 50 per worktree', () => {
  test('51st turn pushes out turn #1 in same worktree', async () => {
    const { tabId, repo } = freshTask()
    let firstId: string | null = null
    for (let i = 0; i < 51; i++) {
      fs.writeFileSync(path.join(repo, `r${i}.txt`), `${i}`)
      await recordTurnBoundary(h.db, tabId, `t${i}`)
      if (i === 0) firstId = listTurnsForWorktree(h.db, repo)[0].id
    }
    const list = listTurnsForWorktree(h.db, repo)
    expect(list).toHaveLength(50)
    expect(list.find((t) => t.id === firstId!) === undefined).toBe(true)
  })
})

await describe('initChatTurnSubscriber', () => {
  test('user-message stash → result records boundary with text', async () => {
    const { tabId, repo } = freshTask()
    const sub = initChatTurnSubscriber(h.db)
    sub(tabId, { kind: 'user-message', text: 'fix me' } as never)
    fs.writeFileSync(path.join(repo, 'fixed.txt'), 'patched')
    sub(tabId, { kind: 'result', isError: false } as never)
    await new Promise((r) => setTimeout(r, 250))
    const list = listTurnsForWorktree(h.db, repo)
    expect(list).toHaveLength(1)
    expect(list[0].prompt_preview).toBe('fix me')
  })
})

await describe('initPtyTurnSubscriber', () => {
  test('claude-code mode tab + non-empty Enter → row w/ empty prompt', async () => {
    const { tabId, repo, taskId } = freshTask()
    fs.writeFileSync(path.join(repo, 'pty.txt'), 'change')
    const sub = initPtyTurnSubscriber(h.db)
    sub(`${taskId}:${tabId}`, taskId, 'do work\n')
    await new Promise((r) => setTimeout(r, 250))
    const list = listTurnsForWorktree(h.db, repo)
    expect(list).toHaveLength(1)
    // Raw PTY stdin is unreliable (contains edit keystrokes/escapes) — we don't
    // reconstruct it. prompt_preview stays empty until a structured-event source
    // exists for TUI agents.
    expect(list[0].prompt_preview).toBe('')
    expect(list[0].terminal_tab_id).toBe(tabId)
  })

  test('plain terminal-mode tab is ignored', async () => {
    const repo = mkRepo()
    repos.push(repo)
    const taskId = crypto.randomUUID()
    const tabId = `tab-${taskId.slice(0, 8)}`
    h.db.prepare('INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, ?, ?)').run(taskId, projectId, 'T', repo)
    h.db.prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)').run(tabId, taskId, 'terminal', 0)
    fs.writeFileSync(path.join(repo, 'shell.txt'), 'x')
    const sub = initPtyTurnSubscriber(h.db)
    sub(`${taskId}:${tabId}`, taskId, 'ls -la')
    await new Promise((r) => setTimeout(r, 250))
    expect(listTurnsForWorktree(h.db, repo)).toHaveLength(0)
  })
})

// Cleanup
for (const r of repos) {
  try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ }
}
h.cleanup()
