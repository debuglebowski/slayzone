/**
 * Tests for removeWorktree multi-fallback branch cleanup.
 * Run with: ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron node_modules/vitest/vitest.mjs run --config packages/shared/test-utils/vitest.harness.config.ts packages/domains/worktrees/src/server/remove-worktree.test.ts
 */
import { afterAll, describe, expect, test } from 'vitest'
import { createWorktree, removeWorktree, listBranches } from './git-worktree.js'
import { execSync } from 'child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@test.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@test.com'
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'slayzone-rm-wt-'))
const repoPath = path.join(root, 'repo')
fs.mkdirSync(repoPath)

function git(cmd: string) {
  return execSync(cmd, { cwd: repoPath, encoding: 'utf-8', env: gitEnv }).trim()
}

// Setup repo
git('git init')
fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test')
git('git add -A')
git('git commit -m "initial"')

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('removeWorktree — backward compat', () => {
  test('no hint = removes worktree, preserves branch', async () => {
    const wtPath = path.join(root, 'wt-compat')
    await createWorktree(repoPath, wtPath, 'feature-compat')

    const result = await removeWorktree(repoPath, wtPath)
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
    expect(result.branchDeleted).toBe(undefined)
    expect(git('git branch --list feature-compat').length > 0).toBe(true)
    // Cleanup leaked branch
    git('git branch -D feature-compat')
  })
})

describe('removeWorktree — multi-fallback branch cleanup', () => {
  test('hint activates fallback: finds branch via metadata even if hint is wrong', async () => {
    const wtPath = path.join(root, 'wt-meta')
    await createWorktree(repoPath, wtPath, 'feature-meta')

    // Pass a wrong hint — metadata should still find "feature-meta"
    const result = await removeWorktree(repoPath, wtPath, 'nonexistent-branch')
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
    expect(result.branchDeleted).toBe(true)
    expect(git('git branch --list feature-meta')).toBe('')
  })

  test('deletes branch via exact caller hint', async () => {
    const wtPath = path.join(root, 'wt-hint')
    await createWorktree(repoPath, wtPath, 'feature-hint')

    const result = await removeWorktree(repoPath, wtPath, 'feature-hint')
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
    expect(result.branchDeleted).toBe(true)
    expect(git('git branch --list feature-hint')).toBe('')
  })

  test('falls back to path basename', async () => {
    const wtPath = path.join(root, 'feature-basename')
    await createWorktree(repoPath, wtPath, 'feature-basename')

    // Pass wrong hint — basename "feature-basename" matches a real branch
    const result = await removeWorktree(repoPath, wtPath, 'wrong-hint')
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
    expect(result.branchDeleted).toBe(true)
    expect(git('git branch --list feature-basename')).toBe('')
  })

  test('reports failure when no candidate branch exists', async () => {
    const wtPath = path.join(root, 'wt-gone')
    await createWorktree(repoPath, wtPath, 'branch-gone')
    git('git worktree remove ' + wtPath + ' --force')
    git('git branch -D branch-gone')

    const result = await removeWorktree(repoPath, wtPath, 'branch-gone')
    expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
    expect(result.branchDeleted).toBeFalsy()
  })

  test('skips current branch in candidates', async () => {
    const wtPath = path.join(root, 'wt-skip')
    await createWorktree(repoPath, wtPath, 'feature-skip')

    // "main" is the current branch — passed as hint but should be skipped; metadata finds "feature-skip"
    const result = await removeWorktree(repoPath, wtPath, 'main')
    expect(result.branchDeleted).toBe(true)
    expect(git('git branch --list feature-skip')).toBe('')
  })

  test('handles relative worktree path', async () => {
    const relPath = '../wt-rel'
    const absPath = path.join(root, 'wt-rel')
    await createWorktree(repoPath, relPath, 'feature-rel')

    const result = await removeWorktree(repoPath, relPath, 'feature-rel')
    expect(fs.existsSync(path.join(absPath, '.git'))).toBe(false)
    expect(result.branchDeleted).toBe(true)
    expect(git('git branch --list feature-rel')).toBe('')
  })
})

describe('listBranches regex', () => {
  test('handles + prefix for worktree branches', async () => {
    const wtPath = path.join(root, 'wt-plus')
    await createWorktree(repoPath, wtPath, 'feature-plus')
    const branches = await listBranches(repoPath)
    expect(branches.some((b) => b === 'feature-plus')).toBe(true)
    expect(branches.every((b) => !b.startsWith('+'))).toBe(true)
    await removeWorktree(repoPath, wtPath)
  })
})
