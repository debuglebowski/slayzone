/**
 * Commits since a ref, in pages (FU1 S4): `getCommitsSincePage` answers a bounded
 * page and a cursor pinned to the branch's tip at the first page, so the pages of
 * one read always describe one history — a commit landing meanwhile neither shifts
 * nor repeats them. Put together they equal `getCommitsSince`'s whole answer.
 */
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { collectPages } from '@slayzone/platform/bounded-reads'
import { getCommitsSince, getCommitsSincePage } from './git-worktree'

const env = {
  ...process.env,
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'commit.gpgsign',
  GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'tag.gpgsign',
  GIT_CONFIG_VALUE_1: 'false',
  GIT_AUTHOR_NAME: 'T',
  GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 'T',
  GIT_COMMITTER_EMAIL: 't@t'
}
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env }).toString()
let repo: string
let base: string

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'commits-pages-'))
  git(repo, 'init', '-q', '-b', 'main')
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'base')
  base = git(repo, 'rev-parse', 'HEAD').trim()
  for (let i = 0; i < 130; i++) git(repo, 'commit', '-q', '--allow-empty', '-m', `c${i}`)
})
afterAll(() => rmSync(repo, { recursive: true, force: true }))

describe('getCommitsSincePage', () => {
  it('pages concatenate to the whole answer', async () => {
    const whole = await getCommitsSince(repo, base, 'main')
    expect(whole.length).toBe(130)
    let pages = 0
    const paged = await collectPages(async (cursor) => {
      pages++
      return getCommitsSincePage(repo, base, 'main', cursor, { maxItems: 50 })
    })
    expect(paged).toEqual(whole)
    expect(pages).toBe(3)
  })

  it('a commit landing mid-read changes nothing in that read', async () => {
    const whole = await getCommitsSince(repo, base, 'main')
    const first = await getCommitsSincePage(repo, base, 'main', null, { maxItems: 50 })
    git(repo, 'commit', '-q', '--allow-empty', '-m', 'landed meanwhile')
    const rest = await collectPages(async (cursor) =>
      cursor === null ? first : getCommitsSincePage(repo, base, 'main', cursor, { maxItems: 50 })
    )
    expect(rest).toEqual(whole)
  })

  it('an unknown branch is empty (as the whole read); a malformed cursor is refused', async () => {
    expect(await getCommitsSincePage(repo, base, 'no-such-branch', null)).toEqual({
      items: [],
      nextCursor: null
    })
    await expect(getCommitsSincePage(repo, base, 'main', 'not-a-cursor')).rejects.toThrow(/cursor/)
  })
})
