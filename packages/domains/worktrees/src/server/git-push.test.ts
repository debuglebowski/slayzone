/**
 * gitPush pushes the branch checked out at `repoPath` — decided here, from git, never
 * from a branch name the client sends. A client-supplied name once made Push in a task
 * with a custom working directory run `git push -u origin main` from a checkout on
 * another branch.
 *
 * Run with: pnpm exec vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/domains/worktrees/src/server/git-push.test.ts
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@slayzone/diagnostics/server', () => ({ recordDiagnosticEvent: () => {} }))
vi.mock('@slayzone/terminal/server', () => ({ getEnrichedPath: () => process.env.PATH ?? '' }))

const { gitPush } = await import('./git-worktree')

let root: string
let remote: string
let work: string
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
const remoteHas = (branch: string) =>
  git(remote, 'branch', '--list', branch).replace('*', '').trim() === branch

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'git-push-'))
  remote = join(root, 'remote.git')
  work = join(root, 'work')
  execFileSync('git', ['init', '-q', '--bare', remote])
  execFileSync('git', ['init', '-q', '-b', 'main', work])
  git(work, 'config', 'user.email', 't@t')
  git(work, 'config', 'user.name', 't')
  git(work, 'config', 'commit.gpgsign', 'false')
  git(work, 'remote', 'add', 'origin', remote)
  writeFileSync(join(work, 'a'), '1')
  git(work, 'add', '.')
  git(work, 'commit', '-q', '-m', 'init')
  git(work, 'push', '-q', '-u', 'origin', 'main')
  git(work, 'checkout', '-q', '-b', 'feat')
  writeFileSync(join(work, 'a'), '2')
  git(work, 'commit', '-q', '-am', 'feat')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('gitPush', () => {
  it('pushes the checked-out branch and sets its upstream', async () => {
    expect(await gitPush(work)).toEqual({ success: true })
    expect(remoteHas('feat')).toBe(true)
    expect(git(work, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feat')
  })

  it('pushes to the existing upstream on later pushes', async () => {
    await gitPush(work)
    writeFileSync(join(work, 'a'), '3')
    git(work, 'commit', '-q', '-am', 'more')
    expect(await gitPush(work)).toEqual({ success: true })
    expect(git(remote, 'rev-parse', 'feat')).toBe(git(work, 'rev-parse', 'HEAD'))
  })

  it('never pushes another branch, whatever HEAD is', async () => {
    const mainBefore = git(remote, 'rev-parse', 'main')
    git(work, 'checkout', '-q', 'main')
    writeFileSync(join(work, 'b'), 'local only')
    git(work, 'add', '.')
    git(work, 'commit', '-q', '-m', 'local main')
    git(work, 'checkout', '-q', 'feat')
    await gitPush(work)
    expect(git(remote, 'rev-parse', 'main')).toBe(mainBefore)
  })

  it('refuses on a detached HEAD instead of guessing', async () => {
    git(work, 'checkout', '-q', '--detach')
    const result = await gitPush(work)
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/not on a branch/i)
  })
})
