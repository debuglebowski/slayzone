/**
 * agentTurns tRPC router contract tests — `list` (empty-diff filter + stale-snap
 * rules + re-threading) and the `onChanged` streaming subscription. Ports the
 * coverage from the legacy agent-turns IPC-handler test
 * (domains/agent-turns/src/electron/handlers.test.ts) onto `caller.list`.
 * Run: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron --import tsx/esm \
 *   --experimental-loader ./packages/shared/test-utils/loader.ts \
 *   packages/shared/transport/src/server/routers/agent-turns.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../test-utils/ipc-harness.js'
import { agentTurnsRouter } from './agent-turns.js'
import { agentTurnsEvents, recordTurnBoundary } from '@slayzone/agent-turns/server'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { AgentTurnRange } from '@slayzone/agent-turns/shared'

// --- onChanged subscription (unchanged — nothing else touches it) ---

const subCtx = { db: {} as never, dataRoot: '' }

await describe('agentTurns.onChanged subscription', () => {
  test('forwards each agent-turns:changed emit, stops after unsubscribe', async () => {
    const caller = agentTurnsRouter.createCaller(subCtx)
    const obs = await caller.onChanged()
    const got: string[] = []
    const sub = obs.subscribe({ next: (v: string) => got.push(v) })

    agentTurnsEvents.emit('agent-turns:changed', '/tmp/wt-a')
    agentTurnsEvents.emit('agent-turns:changed', '/tmp/wt-b')
    sub.unsubscribe()
    agentTurnsEvents.emit('agent-turns:changed', '/tmp/wt-after-unsub')

    expect(got).toEqual(['/tmp/wt-a', '/tmp/wt-b'])
  })

  test('teardown removes the listener (no leak)', async () => {
    const before = agentTurnsEvents.listenerCount('agent-turns:changed')
    const caller = agentTurnsRouter.createCaller(subCtx)
    const obs = await caller.onChanged()
    const sub = obs.subscribe({ next: () => {} })
    expect(agentTurnsEvents.listenerCount('agent-turns:changed')).toBe(before + 1)
    sub.unsubscribe()
    expect(agentTurnsEvents.listenerCount('agent-turns:changed')).toBe(before)
  })
})

// --- list (empty-diff filter + stale-snap rules + re-threading) ---

const h = await createTestHarness()
const caller = agentTurnsRouter.createCaller({ db: h.slayDb, dataRoot: '' })
const repos: string[] = []

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
const list = (repo: string): Promise<AgentTurnRange[]> =>
  caller.list({ worktreePath: repo }) as Promise<AgentTurnRange[]>

await describe('agentTurns.list filters empty-diff turns + re-threads prev_snapshot_sha', () => {
  test('drops a row whose snapshot equals prev (legacy noop)', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'a.txt'), '1')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'a.txt'), '2')
    await recordTurnBoundary(h.db, tabId, 'p2')

    const latest = h.db
      .prepare('SELECT snapshot_sha, head_sha_at_snap FROM agent_turns WHERE worktree_path = ? ORDER BY created_at DESC LIMIT 1')
      .get(repo) as { snapshot_sha: string; head_sha_at_snap: string }
    h.db
      .prepare('INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), repo, tabId, latest.snapshot_sha, latest.head_sha_at_snap, 'noop', Date.now() + 1000)

    expect(await list(repo)).toHaveLength(2)
  })

  test('rethread: drop middle dup — surviving next pivots to surviving prev', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'b.txt'), 'first')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'second')
    await recordTurnBoundary(h.db, tabId, 'p2')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'third')
    await recordTurnBoundary(h.db, tabId, 'p3')

    const rows = h.db
      .prepare('SELECT * FROM agent_turns WHERE worktree_path = ? ORDER BY created_at ASC')
      .all(repo) as Array<{ id: string; snapshot_sha: string; head_sha_at_snap: string; created_at: number }>
    expect(rows.length).toBe(3)
    const between = (rows[0].created_at + rows[1].created_at) / 2 + 0.5
    h.db
      .prepare('INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), repo, tabId, rows[0].snapshot_sha, rows[0].head_sha_at_snap, 'dup', Math.round(between))

    const l = await list(repo)
    expect(l).toHaveLength(3)
    expect(l[0].prev_snapshot_sha).toBeNull()
    expect(l[1].prev_snapshot_sha).toBe(l[0].snapshot_sha)
    expect(l[2].prev_snapshot_sha).toBe(l[1].snapshot_sha)
  })

  test('repeated list calls reuse the diff-empty cache', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'd.txt'), 'cached')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'd.txt'), 'cached2')
    await recordTurnBoundary(h.db, tabId, 'p2')
    const l1 = await list(repo)
    const l2 = await list(repo)
    expect(l1).toHaveLength(2)
    expect(l2).toHaveLength(2)
    expect(l1[0].snapshot_sha).toBe(l2[0].snapshot_sha)
    expect(l1[1].snapshot_sha).toBe(l2[1].snapshot_sha)
  })

  test('drops turns whose files no longer appear in working tree changes', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'ephemeral.txt'), 'x')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'kept.txt'), 'y')
    await recordTurnBoundary(h.db, tabId, 'p2')
    expect(await list(repo)).toHaveLength(2)
    fs.unlinkSync(path.join(repo, 'ephemeral.txt'))
    const l = await list(repo)
    expect(l).toHaveLength(1)
    expect(l[0].prev_snapshot_sha).toBeNull()
  })

  test('drops all turns when working tree is clean', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'temp.txt'), 'a')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'temp.txt'), 'b')
    await recordTurnBoundary(h.db, tabId, 'p2')
    fs.unlinkSync(path.join(repo, 'temp.txt'))
    expect(await list(repo)).toHaveLength(0)
  })

  test('ghost turns stay dropped after commit + new edit to same file', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'a.txt'), '1')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'a.txt'), '2')
    await recordTurnBoundary(h.db, tabId, 'p2')
    fs.writeFileSync(path.join(repo, 'a.txt'), '3')
    await recordTurnBoundary(h.db, tabId, 'p3')
    expect(await list(repo)).toHaveLength(3)
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'work')
    expect(await list(repo)).toHaveLength(0)
    fs.writeFileSync(path.join(repo, 'a.txt'), '4')
    expect(await list(repo)).toHaveLength(0)
  })

  test('multi-commit cycles — only turns whose parent == current HEAD survive', async () => {
    const { tabId, repo } = freshTask()
    const file = path.join(repo, 'a.txt')
    fs.writeFileSync(file, 'c1-1'); await recordTurnBoundary(h.db, tabId, '1')
    fs.writeFileSync(file, 'c1-2'); await recordTurnBoundary(h.db, tabId, '2')
    fs.writeFileSync(file, 'c1-3'); await recordTurnBoundary(h.db, tabId, '3')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'cycle-1')
    fs.writeFileSync(file, 'c2-1'); await recordTurnBoundary(h.db, tabId, '4')
    fs.writeFileSync(file, 'c2-2'); await recordTurnBoundary(h.db, tabId, '5')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'cycle-2')
    fs.writeFileSync(file, 'c3-1'); await recordTurnBoundary(h.db, tabId, '6')
    fs.writeFileSync(file, 'c3-2'); await recordTurnBoundary(h.db, tabId, '7')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'cycle-3')
    expect(await list(repo)).toHaveLength(0)
    fs.writeFileSync(file, 'post-c3-edit')
    expect(await list(repo)).toHaveLength(0)
  })

  test('mix of stale + current-HEAD snaps — only current-HEAD ones visible', async () => {
    const { tabId, repo } = freshTask()
    const fileA = path.join(repo, 'a.txt')
    const fileB = path.join(repo, 'b.txt')
    const fileC = path.join(repo, 'c.txt')
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let t = 0; t < 4; t++) {
        fs.writeFileSync(fileA, `cycle${cycle}-t${t}-A`)
        fs.writeFileSync(fileB, `cycle${cycle}-t${t}-B`)
        await recordTurnBoundary(h.db, tabId, `c${cycle}-t${t}`)
      }
      git(repo, 'add', '.'); git(repo, 'commit', '-m', `cycle-${cycle}`)
    }
    expect(await list(repo)).toHaveLength(0)
    fs.writeFileSync(fileC, 'fresh')
    await recordTurnBoundary(h.db, tabId, 'fresh-turn-1')
    fs.writeFileSync(fileA, 'post-commit-edit')
    const l = await list(repo)
    expect(l).toHaveLength(1)
    expect(l[0].prompt_preview).toBe('fresh-turn-1')
  })

  test('file-overlap rule must NOT save a stale-parent snap', async () => {
    const { tabId, repo } = freshTask()
    const file = path.join(repo, 'shared.txt')
    fs.writeFileSync(file, 'v1')
    await recordTurnBoundary(h.db, tabId, 'stale')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'commit-stale')
    fs.writeFileSync(file, 'v2')
    await recordTurnBoundary(h.db, tabId, 'fresh')
    const l = await list(repo)
    expect(l).toHaveLength(1)
    expect(l[0].prompt_preview).toBe('fresh')
  })

  test('legacy row with NULL head_sha_at_snap is dropped', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'live.txt'), 'live')
    await recordTurnBoundary(h.db, tabId, 'live')
    const live = h.db.prepare('SELECT snapshot_sha FROM agent_turns WHERE worktree_path = ? LIMIT 1').get(repo) as { snapshot_sha: string }
    h.db
      .prepare('INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)')
      .run(crypto.randomUUID(), repo, tabId, live.snapshot_sha, 'legacy', Date.now() + 1000)
    const l = await list(repo)
    expect(l).toHaveLength(1)
    expect(l[0].prompt_preview).toBe('live')
  })

  test('column-driven Rule 1: stale row dropped via SQL column compare', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'live.txt'), 'live')
    await recordTurnBoundary(h.db, tabId, 'live')
    const live = h.db.prepare('SELECT snapshot_sha FROM agent_turns WHERE worktree_path = ? LIMIT 1').get(repo) as { snapshot_sha: string }
    h.db
      .prepare('INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)')
      .run(crypto.randomUUID(), repo, tabId, live.snapshot_sha, '0000000000000000000000000000000000000000', 'stale', Date.now() + 1000)
    const l = await list(repo)
    expect(l).toHaveLength(1)
    expect(l[0].prompt_preview).toBe('live')
  })

  test('fail-closed: when current HEAD lookup fails, returns empty list', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two')
    await recordTurnBoundary(h.db, tabId, 'p2')
    expect(await list(repo)).toHaveLength(2)
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true })
    expect(await list(repo)).toHaveLength(0)
  })

  test('canonicalizes incoming worktreePath via realpath', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'c.txt'), 'data')
    await recordTurnBoundary(h.db, tabId, 'p')
    expect(await list(repo)).toHaveLength(1)
  })

  test('uncommitted turn survives an external commit of an unrelated file', async () => {
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'dirty.txt'), 'agent work in progress')
    await recordTurnBoundary(h.db, tabId, 'agent-turn')
    let l = await list(repo)
    expect(l).toHaveLength(1)
    expect(l[0].prompt_preview).toBe('agent-turn')
    fs.writeFileSync(path.join(repo, 'unrelated.txt'), 'unrelated change')
    git(repo, 'add', 'unrelated.txt'); git(repo, 'commit', '-m', 'unrelated commit')
    l = await list(repo)
    expect(l).toHaveLength(1)
    expect(l[0].prompt_preview).toBe('agent-turn')
  })

  test('multiple uncommitted session turns survive an external commit cycle', async () => {
    const { tabId, repo } = freshTask()
    const fileA = path.join(repo, 'a.txt')
    const fileB = path.join(repo, 'b.txt')
    const ext = path.join(repo, 'ext.txt')
    fs.writeFileSync(fileA, 'a-v1'); await recordTurnBoundary(h.db, tabId, 't1')
    fs.writeFileSync(fileA, 'a-v2'); await recordTurnBoundary(h.db, tabId, 't2')
    fs.writeFileSync(fileB, 'b-v1'); await recordTurnBoundary(h.db, tabId, 't3')
    expect(await list(repo)).toHaveLength(3)
    fs.writeFileSync(ext, 'e1'); git(repo, 'add', 'ext.txt'); git(repo, 'commit', '-m', 'ext1')
    fs.writeFileSync(ext, 'e2'); git(repo, 'add', 'ext.txt'); git(repo, 'commit', '-m', 'ext2')
    const l = await list(repo)
    expect(l).toHaveLength(3)
    expect(l.map((t) => t.prompt_preview)).toEqual(['t1', 't2', 't3'])
  })
})

for (const r of repos) {
  try {
    fs.rmSync(r, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}
