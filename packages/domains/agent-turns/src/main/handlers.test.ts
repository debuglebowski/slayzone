/**
 * agent-turns:list IPC handler — filter + rethread of empty-diff turns.
 * Run: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/agent-turns/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerAgentTurnsHandlers } from './handlers.js'
import { recordTurnBoundary } from './turn-tracker.js'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentTurnRange } from '../shared/types.js'

function git(repo: string, ...args: string[]): string {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf-8' })
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`)
  return r.stdout.trim()
}

function mkRepo(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-h-')))
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
registerAgentTurnsHandlers(h.ipcMain as never, h.db)

const projectId = crypto.randomUUID()
h.db.prepare('INSERT INTO projects (id, name, color) VALUES (?, ?, ?)').run(projectId, 'P', '#000')

function freshTask(): { taskId: string; tabId: string; repo: string } {
  const repo = mkRepo()
  repos.push(repo)
  const taskId = crypto.randomUUID()
  const tabId = `tab-${taskId.slice(0, 8)}`
  h.db.prepare('INSERT INTO tasks (id, project_id, title, worktree_path) VALUES (?, ?, ?, ?)').run(taskId, projectId, 'T', repo)
  h.db.prepare('INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES (?, ?, ?, ?)').run(tabId, taskId, 'claude-code', 0)
  return { taskId, tabId, repo }
}

await describe('list filters empty-diff turns + re-threads prev_snapshot_sha', () => {
  test('drops a row whose snapshot equals prev (manually injected legacy case)', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'a.txt'), '1')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'a.txt'), '2')
    await recordTurnBoundary(h.db, tabId, 'p2')

    // Inject a malformed legacy turn: snapshot_sha = the latest, so prev..this is empty.
    const latest = h.db.prepare('SELECT snapshot_sha FROM agent_turns WHERE worktree_path = ? ORDER BY created_at DESC LIMIT 1').get(repo) as { snapshot_sha: string }
    h.db.prepare('INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, prompt_preview, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)').run(
      crypto.randomUUID(), repo, tabId, latest.snapshot_sha, 'noop', Date.now() + 1000
    )

    const list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(2) // legacy noop dropped
  })

  test('rethread: drop middle row whose snap equals prev — surviving next row pivots to surviving prev', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'b.txt'), 'first')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'second')
    await recordTurnBoundary(h.db, tabId, 'p2')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'third')
    await recordTurnBoundary(h.db, tabId, 'p3')

    const rows = h.db.prepare('SELECT * FROM agent_turns WHERE worktree_path = ? ORDER BY created_at ASC').all(repo) as Array<{ id: string; snapshot_sha: string; created_at: number }>
    expect(rows.length).toBe(3)

    // Inject a malformed duplicate slotted BETWEEN row[0] and row[1] in time
    // (snap = row[0].snap so prev..this is empty → must be filtered).
    const between = (rows[0].created_at + rows[1].created_at) / 2 + 0.5
    h.db.prepare('INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, prompt_preview, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?)').run(
      crypto.randomUUID(), repo, tabId, rows[0].snapshot_sha, 'dup', Math.round(between)
    )

    const list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(3) // dup filtered
    // Surviving chain: each row's prev_snapshot_sha is the previous SURVIVING row's snap.
    expect(list[0].prev_snapshot_sha).toBeNull()
    expect(list[1].prev_snapshot_sha).toBe(list[0].snapshot_sha)
    expect(list[2].prev_snapshot_sha).toBe(list[1].snapshot_sha)
  })

  test('repeated list calls reuse the diff-empty cache (no extra git spawns)', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'd.txt'), 'cached')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'd.txt'), 'cached2')
    await recordTurnBoundary(h.db, tabId, 'p2')

    const list1 = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    const list2 = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list1).toHaveLength(2)
    expect(list2).toHaveLength(2)
    // Same shape both times — second call is fully memoized.
    expect(list1[0].snapshot_sha).toBe(list2[0].snapshot_sha)
    expect(list1[1].snapshot_sha).toBe(list2[1].snapshot_sha)
  })

  test('drops turns whose files no longer appear in working tree changes', async () => {
    const { tabId, repo } = freshTask()
    // Turn 1: only changes ephemeral.txt
    fs.writeFileSync(path.join(repo, 'ephemeral.txt'), 'x')
    await recordTurnBoundary(h.db, tabId, 'p1')
    // Turn 2: changes kept.txt
    fs.writeFileSync(path.join(repo, 'kept.txt'), 'y')
    await recordTurnBoundary(h.db, tabId, 'p2')

    // Both turns initially visible (both files present in working tree).
    let list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(2)

    // Revert ephemeral.txt → no longer in `git status`. Turn 1 must drop.
    fs.unlinkSync(path.join(repo, 'ephemeral.txt'))
    list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(1)
    expect(list[0].prev_snapshot_sha).toBeNull() // re-threaded as the new first turn
  })

  test('drops all turns when working tree is clean', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'temp.txt'), 'a')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'temp.txt'), 'b')
    await recordTurnBoundary(h.db, tabId, 'p2')

    fs.unlinkSync(path.join(repo, 'temp.txt'))
    const list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(0)
  })

  test('BUG: ghost turns resurrect after commit + new edit to same file', async () => {
    // Repro: user runs N turns touching a.txt, commits them, then edits a.txt
    // again. Filter currently resurrects all N pre-commit turns because a.txt
    // appears in the new working set, even though those turns are fully
    // committed and irrelevant to the new uncommitted change.
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'a.txt'), '1')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'a.txt'), '2')
    await recordTurnBoundary(h.db, tabId, 'p2')
    fs.writeFileSync(path.join(repo, 'a.txt'), '3')
    await recordTurnBoundary(h.db, tabId, 'p3')

    // Three pre-commit turns visible
    let list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(3)

    // Commit them all
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'work')

    // Working tree clean → no turns (passes today)
    list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(0)

    // User edits a.txt again, no new turn recorded yet
    fs.writeFileSync(path.join(repo, 'a.txt'), '4')

    // Bug: filter resurrects all 3 historical turns because a.txt now in
    // working set. Expected: 0 (committed turns must stay dropped).
    list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(0)
  })

  test('canonicalizes incoming worktreePath via realpath', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'c.txt'), 'data')
    await recordTurnBoundary(h.db, tabId, 'p')
    // realpath of repo == repo (it was already realpath'd in mkRepo)
    const list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(1)
  })
})

// Cleanup
for (const r of repos) {
  try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ }
}
h.cleanup()
