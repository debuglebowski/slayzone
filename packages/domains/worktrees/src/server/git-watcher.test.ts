/**
 * GitWatcher on a real repo: which file changes reach `git:diff-changed`, and whether
 * an event says a ref moved (`refsChanged`, what the branch graph refreshes on).
 *
 * Nested checkouts (agent worktrees under `.claude/worktrees/…`, a cloned repo in a
 * subdir) are their own repos: their edits are not this repo's diff, and used to
 * refetch it up to 5×/s while any agent worked. Submodules ARE part of the diff.
 *
 * Run with: pnpm exec vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/domains/worktrees/src/server/git-watcher.test.ts
 */
import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createGitWatcher, type GitWatcher } from './git-watcher'

type Event = { worktreePath: string; refsChanged: boolean }

let root: string
let repo: string
let watcher: GitWatcher | null = null
let events: Event[] = []

function git(cmd: string, cwd = repo): string {
  return execSync(`git ${cmd}`, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'T',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 'T',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  }).trim()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Start watching, then wait out the backend's startup noise. */
async function watch(): Promise<void> {
  watcher = createGitWatcher()
  watcher.on('git:diff-changed', (e: Event) => events.push(e))
  watcher.subscribe(repo)
  await sleep(600)
  events = []
}

/** Events that arrive within `ms` (debounce 200ms + FSEvents latency). */
async function eventsAfter(action: () => void, ms = 1500): Promise<Event[]> {
  events = []
  action()
  await sleep(ms)
  return events
}

beforeAll(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'git-watcher-')))
  repo = join(root, 'repo')
  git(`init -q -b main ${repo}`, root)
  writeFileSync(join(repo, 'a.txt'), 'a')
  git('add a.txt')
  git('-c commit.gpgsign=false commit -qm init')
  // Nested checkout: a worktree living inside the repo (gitignored, like .claude/worktrees).
  writeFileSync(join(repo, '.gitignore'), 'nested/\n')
  mkdirSync(join(repo, 'nested'))
  git(`worktree add -q ${join(repo, 'nested', 'wt')} -b wt`)
})
afterAll(() => rmSync(root, { recursive: true, force: true }))
afterEach(() => {
  watcher?.closeAll()
  watcher = null
})

describe('GitWatcher', () => {
  it('a tracked-file edit emits, without refsChanged', async () => {
    await watch()
    const got = await eventsAfter(() => writeFileSync(join(repo, 'a.txt'), 'edited'))
    expect(got.length).toBeGreaterThan(0)
    expect(got.every((e) => e.worktreePath === repo)).toBe(true)
    expect(got.some((e) => e.refsChanged)).toBe(false)
  })

  it('a commit emits with refsChanged', async () => {
    await watch()
    const got = await eventsAfter(() => {
      git('add a.txt')
      git('-c commit.gpgsign=false commit -qm edit')
    })
    expect(got.some((e) => e.refsChanged)).toBe(true)
  })

  it('edits inside a nested checkout do not emit', async () => {
    await watch()
    const got = await eventsAfter(() => {
      writeFileSync(join(repo, 'nested', 'wt', 'a.txt'), 'nested edit')
      writeFileSync(join(repo, 'nested', 'wt', 'new.txt'), 'new')
    })
    expect(got).toEqual([])
  })

  it("the nested worktree's index/HEAD under .git/worktrees do not emit", async () => {
    await watch()
    const got = await eventsAfter(() => git('add -A', join(repo, 'nested', 'wt')))
    expect(got).toEqual([])
  })
})
