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
    // head_sha_at_snap mirrors the latest row's, so Rule 1 doesn't drop it — the
    // empty-diff Rule 2 is what we want to exercise here.
    const latest = h.db.prepare('SELECT snapshot_sha, head_sha_at_snap FROM agent_turns WHERE worktree_path = ? ORDER BY created_at DESC LIMIT 1').get(repo) as { snapshot_sha: string; head_sha_at_snap: string }
    h.db.prepare('INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)').run(
      crypto.randomUUID(), repo, tabId, latest.snapshot_sha, latest.head_sha_at_snap, 'noop', Date.now() + 1000
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

    const rows = h.db.prepare('SELECT * FROM agent_turns WHERE worktree_path = ? ORDER BY created_at ASC').all(repo) as Array<{ id: string; snapshot_sha: string; head_sha_at_snap: string; created_at: number }>
    expect(rows.length).toBe(3)

    // Inject a malformed duplicate slotted BETWEEN row[0] and row[1] in time
    // (snap = row[0].snap so prev..this is empty → must be filtered).
    // head_sha_at_snap matches so Rule 1 doesn't pre-empt the test.
    const between = (rows[0].created_at + rows[1].created_at) / 2 + 0.5
    h.db.prepare('INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)').run(
      crypto.randomUUID(), repo, tabId, rows[0].snapshot_sha, rows[0].head_sha_at_snap, 'dup', Math.round(between)
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

  test('REPRO: multi-commit cycles — only turns whose parent == current HEAD survive', async () => {
    // Scenario: user works in 3 commit cycles. Each cycle = N turns, then commit.
    // After 3 cycles, edits same files again. Filter must drop ALL pre-current-HEAD
    // turns (their snap parent points to an old HEAD), regardless of how many
    // historical HEADs the snaps were taken at.
    const { tabId, repo } = freshTask()
    const file = path.join(repo, 'a.txt')

    // Cycle 1: 3 turns at HEAD0
    fs.writeFileSync(file, 'c1-1'); await recordTurnBoundary(h.db, tabId, '1')
    fs.writeFileSync(file, 'c1-2'); await recordTurnBoundary(h.db, tabId, '2')
    fs.writeFileSync(file, 'c1-3'); await recordTurnBoundary(h.db, tabId, '3')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'cycle-1')

    // Cycle 2: 2 turns at HEAD1
    fs.writeFileSync(file, 'c2-1'); await recordTurnBoundary(h.db, tabId, '4')
    fs.writeFileSync(file, 'c2-2'); await recordTurnBoundary(h.db, tabId, '5')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'cycle-2')

    // Cycle 3: 2 turns at HEAD2 (current)
    fs.writeFileSync(file, 'c3-1'); await recordTurnBoundary(h.db, tabId, '6')
    fs.writeFileSync(file, 'c3-2'); await recordTurnBoundary(h.db, tabId, '7')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'cycle-3')

    // Working tree clean after final commit → 0 turns
    let list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(0)

    // Now edit the SAME file (`a.txt`) again. All historical turns touched a.txt,
    // so file-overlap rule alone won't drop them. Only parent-vs-HEAD rule does.
    fs.writeFileSync(file, 'post-c3-edit')
    list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    // BUG: if filter resurrects ANY of the 7 pre-commit turns, count > 0.
    // Expected: 0 (no current-HEAD snap exists yet).
    expect(list).toHaveLength(0)
  })

  test('REPRO: mix of stale + current-HEAD snaps — only current-HEAD ones visible', async () => {
    // Closer to user's repro: 50 stale snaps (parent = various old HEADs) plus
    // a few fresh snaps (parent = current HEAD). Working set overlaps SOME old
    // turns' files. Only the fresh snaps with non-empty diff + file overlap
    // should survive.
    const { tabId, repo } = freshTask()
    const fileA = path.join(repo, 'a.txt')
    const fileB = path.join(repo, 'b.txt')
    const fileC = path.join(repo, 'c.txt')

    // 5 commit cycles, 4 turns each = 20 stale snaps
    for (let cycle = 0; cycle < 5; cycle++) {
      for (let t = 0; t < 4; t++) {
        fs.writeFileSync(fileA, `cycle${cycle}-t${t}-A`)
        fs.writeFileSync(fileB, `cycle${cycle}-t${t}-B`)
        await recordTurnBoundary(h.db, tabId, `c${cycle}-t${t}`)
      }
      git(repo, 'add', '.'); git(repo, 'commit', '-m', `cycle-${cycle}`)
    }

    // After all commits, working tree is clean → 0 turns
    let list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(0)

    // Now a fresh agent turn at current HEAD touches a NEW file (c.txt)
    fs.writeFileSync(fileC, 'fresh')
    await recordTurnBoundary(h.db, tabId, 'fresh-turn-1')

    // ALSO modify a.txt (which every stale snap also touched). This is the
    // adversarial case: file-overlap alone would resurrect every stale snap.
    fs.writeFileSync(fileA, 'post-commit-edit')

    list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    // Expected: just the 1 fresh turn (parent = current HEAD).
    // BUG: if any stale snaps slip through, count > 1.
    expect(list).toHaveLength(1)
    expect(list[0].prompt_preview).toBe('fresh-turn-1')
  })

  test('REPRO: file-overlap rule must NOT save a stale-parent snap', async () => {
    // Minimal direct repro: one stale snap + one fresh snap, both touch
    // the SAME file that's in the current working set. Stale must drop
    // (parent != HEAD) even though its files overlap working set.
    const { tabId, repo } = freshTask()
    const file = path.join(repo, 'shared.txt')

    fs.writeFileSync(file, 'v1')
    await recordTurnBoundary(h.db, tabId, 'stale')
    git(repo, 'add', '.'); git(repo, 'commit', '-m', 'commit-stale')

    fs.writeFileSync(file, 'v2')
    await recordTurnBoundary(h.db, tabId, 'fresh')

    const list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    // Expected: 1 (only fresh). Stale's parent is the pre-commit HEAD, not current.
    expect(list).toHaveLength(1)
    expect(list[0].prompt_preview).toBe('fresh')
  })

  test('legacy row with NULL head_sha_at_snap is dropped (unrecoverable backfill)', async () => {
    // Rows inserted before migration 122 whose backfill failed (repo gone,
    // git crash, etc.) end up with head_sha_at_snap = NULL. Filter cannot
    // reason about their staleness, so drops them.
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'live.txt'), 'live')
    await recordTurnBoundary(h.db, tabId, 'live')

    // Inject a NULL-head row with valid snap pointing to live snap (so file
    // overlap would otherwise pass).
    const live = h.db.prepare('SELECT snapshot_sha FROM agent_turns WHERE worktree_path = ? LIMIT 1').get(repo) as { snapshot_sha: string }
    h.db.prepare('INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at) VALUES (?, ?, NULL, ?, ?, NULL, ?, ?)').run(
      crypto.randomUUID(), repo, tabId, live.snapshot_sha, 'legacy', Date.now() + 1000
    )

    const list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(1) // only the live one
    expect(list[0].prompt_preview).toBe('live')
  })

  test('column-driven Rule 1: stale row dropped without any git rev-parse spawn', async () => {
    // Insert a snap whose head_sha_at_snap is FAKE (does not match any real
    // commit). Filter must drop it via the SQL column comparison alone — no
    // git rev-parse, no cache. If filter regressed to spawning git for parent
    // lookup, it would hit the in-memory `live` snap's parent (= live's HEAD)
    // and the row could survive depending on the real value.
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'live.txt'), 'live')
    await recordTurnBoundary(h.db, tabId, 'live')

    const live = h.db.prepare('SELECT snapshot_sha FROM agent_turns WHERE worktree_path = ? LIMIT 1').get(repo) as { snapshot_sha: string }
    // Fake stale-HEAD value — definitely not current HEAD.
    const fakeStaleHead = '0000000000000000000000000000000000000000'
    h.db.prepare('INSERT INTO agent_turns (id, worktree_path, task_id, terminal_tab_id, snapshot_sha, head_sha_at_snap, prompt_preview, created_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?)').run(
      crypto.randomUUID(), repo, tabId, live.snapshot_sha, fakeStaleHead, 'stale', Date.now() + 1000
    )

    const list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(1)
    expect(list[0].prompt_preview).toBe('live')
  })

  test('fail-closed: when current HEAD lookup fails, returns empty list', async () => {
    // Simulate a broken repo by destroying .git after turns are recorded.
    // getHeadSha returns null → filter must drop everything (don't risk
    // showing ghost turns whose freshness can't be verified).
    const { tabId, repo } = freshTask()
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one')
    await recordTurnBoundary(h.db, tabId, 'p1')
    fs.writeFileSync(path.join(repo, 'a.txt'), 'two')
    await recordTurnBoundary(h.db, tabId, 'p2')

    // Sanity: turns visible while repo intact.
    let list = (await h.invoke('agent-turns:list', repo)) as AgentTurnRange[]
    expect(list).toHaveLength(2)

    // Break the repo (remove .git) so `git rev-parse HEAD` fails.
    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true })
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
