/**
 * git-snapshot integration tests — uses a real temp git repo.
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/agent-turns/src/server/git-snapshot.test.ts
 */
import { test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { snapshotWorktree, deleteTurnRef, diffIsEmpty } from './git-snapshot.js'
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-gs-'))
  git(dir, 'init', '-q', '-b', 'main')
  git(dir, 'config', 'user.email', 'test@test')
  git(dir, 'config', 'user.name', 'test')
  git(dir, 'commit', '--allow-empty', '-m', 'init')
  return dir
}

function refExists(repo: string, refName: string): boolean {
  const r = spawnSync('git', ['rev-parse', '--verify', refName], { cwd: repo, encoding: 'utf-8' })
  return r.status === 0
}

const repos: string[] = []
function freshRepo(): string {
  const r = mkRepo()
  repos.push(r)
  return r
}

await describe('snapshotWorktree — clean tree', () => {
  test('always commits a snapshot with parent=HEAD; ref created', async () => {
    const repo = freshRepo()
    const head = git(repo, 'rev-parse', 'HEAD')
    const sha = await snapshotWorktree(repo, 'turn-A')
    expect(sha !== null).toBe(true)
    // sha must NOT equal HEAD — always a fresh commit so `<sha>^` reliably points at HEAD-at-snap-time.
    expect(sha === head).toBe(false)
    // Parent of snapshot commit is HEAD.
    const parent = git(repo, 'rev-parse', `${sha}^`)
    expect(parent).toBe(head)
    expect(refExists(repo, 'refs/slayzone/turns/turn-A')).toBe(true)
  })
})

await describe('snapshotWorktree — dirty tree', () => {
  test('captures tracked edits', async () => {
    const repo = freshRepo()
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'add a')
    const headBefore = git(repo, 'rev-parse', 'HEAD')

    fs.writeFileSync(path.join(repo, 'a.txt'), 'two')
    const sha = await snapshotWorktree(repo, 'turn-B')
    expect(sha !== null).toBe(true)
    expect(sha === headBefore).toBe(false)

    // Working tree NOT mutated by snapshot
    expect(fs.readFileSync(path.join(repo, 'a.txt'), 'utf-8')).toBe('two')
    // Ref points at snapshot
    expect(refExists(repo, 'refs/slayzone/turns/turn-B')).toBe(true)
  })

  test('captures untracked files via -u', async () => {
    const repo = freshRepo()
    fs.writeFileSync(path.join(repo, 'fresh.txt'), 'brand new')
    const sha = await snapshotWorktree(repo, 'turn-C')
    expect(sha !== null).toBe(true)

    // Verify the untracked file is reachable from the snapshot commit's tree.
    const tree = git(repo, 'ls-tree', '-r', sha as string)
    expect(tree.includes('fresh.txt')).toBe(true)

    // Working tree still has it
    expect(fs.existsSync(path.join(repo, 'fresh.txt'))).toBe(true)
  })
})

await describe('snapshotWorktree — failure modes', () => {
  test('non-git path returns null', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-no-git-'))
    repos.push(dir)
    const sha = await snapshotWorktree(dir, 'turn-X')
    expect(sha).toBeNull()
  })
})

await describe('deleteTurnRef', () => {
  test('removes existing ref', async () => {
    const repo = freshRepo()
    await snapshotWorktree(repo, 'turn-D')
    expect(refExists(repo, 'refs/slayzone/turns/turn-D')).toBe(true)
    await deleteTurnRef(repo, 'turn-D')
    expect(refExists(repo, 'refs/slayzone/turns/turn-D')).toBe(false)
  })

  test('silent on missing ref', async () => {
    const repo = freshRepo()
    await deleteTurnRef(repo, 'no-such-turn') // should not throw
    expect(true).toBe(true)
  })
})

await describe('diffIsEmpty', () => {
  test('same SHA → true', async () => {
    const repo = freshRepo()
    const head = git(repo, 'rev-parse', 'HEAD')
    expect(await diffIsEmpty(repo, head, head)).toBe(true)
  })

  test('different SHAs with changes → false', async () => {
    const repo = freshRepo()
    const head1 = git(repo, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(repo, 'b.txt'), 'hi')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'add b')
    const head2 = git(repo, 'rev-parse', 'HEAD')
    expect(await diffIsEmpty(repo, head1, head2)).toBe(false)
  })

  test('two snapshots with no edits between → true', async () => {
    const repo = freshRepo()
    fs.writeFileSync(path.join(repo, 'c.txt'), 'static')
    const sha1 = (await snapshotWorktree(repo, 'turn-E1'))!
    const sha2 = (await snapshotWorktree(repo, 'turn-E2'))!
    // -u captures untracked; both snapshots see the same tree → no diff
    expect(await diffIsEmpty(repo, sha1, sha2)).toBe(true)
  })

  test('snapshots before/after edit → false', async () => {
    const repo = freshRepo()
    fs.writeFileSync(path.join(repo, 'd.txt'), 'before')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'd before')
    const sha1 = (await snapshotWorktree(repo, 'turn-F1'))!
    fs.writeFileSync(path.join(repo, 'd.txt'), 'after')
    const sha2 = (await snapshotWorktree(repo, 'turn-F2'))!
    expect(await diffIsEmpty(repo, sha1, sha2)).toBe(false)
  })
})

await describe('snapshot is non-destructive', () => {
  test('HEAD untouched after snapshot', async () => {
    const repo = freshRepo()
    const headBefore = git(repo, 'rev-parse', 'HEAD')
    fs.writeFileSync(path.join(repo, 'x.txt'), 'pending')
    await snapshotWorktree(repo, 'turn-G')
    const headAfter = git(repo, 'rev-parse', 'HEAD')
    expect(headAfter).toBe(headBefore)
  })

  test('stash list stays empty (we use isolated index, not stash)', async () => {
    const repo = freshRepo()
    fs.writeFileSync(path.join(repo, 'y.txt'), 'change')
    await snapshotWorktree(repo, 'turn-H')
    const list = git(repo, 'stash', 'list')
    expect(list).toBe('')
  })

  test('user index untouched: pre-staged files still staged after snapshot', async () => {
    const repo = freshRepo()
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'add tracked')
    fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two')
    git(repo, 'add', 'tracked.txt') // stage edit
    fs.writeFileSync(path.join(repo, 'unstaged.txt'), 'fresh') // untracked
    const stagedBefore = git(repo, 'diff', '--cached', '--name-only')
    expect(stagedBefore).toBe('tracked.txt')

    await snapshotWorktree(repo, 'turn-I')

    const stagedAfter = git(repo, 'diff', '--cached', '--name-only')
    expect(stagedAfter).toBe('tracked.txt')
    // unstaged.txt still NOT staged in user's index
    const unstagedStatus = git(repo, 'status', '--porcelain', 'unstaged.txt')
    expect(unstagedStatus.startsWith('??')).toBe(true)
  })

  test('untracked-only changes captured', async () => {
    const repo = freshRepo()
    fs.writeFileSync(path.join(repo, 'newfile.txt'), 'untracked content')
    const sha = (await snapshotWorktree(repo, 'turn-J'))!
    const tree = git(repo, 'ls-tree', '-r', sha)
    expect(tree.includes('newfile.txt')).toBe(true)
  })

  test('gitignored files excluded', async () => {
    const repo = freshRepo()
    fs.writeFileSync(path.join(repo, '.gitignore'), 'secret.txt\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-m', 'gitignore')
    fs.writeFileSync(path.join(repo, 'secret.txt'), 'do not capture')
    fs.writeFileSync(path.join(repo, 'public.txt'), 'capture me')
    const sha = (await snapshotWorktree(repo, 'turn-K'))!
    const tree = git(repo, 'ls-tree', '-r', sha)
    expect(tree.includes('public.txt')).toBe(true)
    expect(tree.includes('secret.txt')).toBe(false)
  })
})

// Cleanup
for (const r of repos) {
  try { fs.rmSync(r, { recursive: true, force: true }) } catch { /* ignore */ }
}
