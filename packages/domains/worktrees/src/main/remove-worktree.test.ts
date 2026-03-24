/**
 * Tests for removeWorktree multi-fallback branch cleanup.
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/worktrees/src/main/remove-worktree.test.ts
 */
import { createWorktree, removeWorktree, listBranches } from './git-worktree.js'
import { execSync } from 'child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
    process.exitCode = 1
  }
}

function expect(actual: unknown) {
  return {
    toBe(expected: unknown) {
      if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
    },
    toBeTruthy() { if (!actual) throw new Error(`Expected truthy, got ${JSON.stringify(actual)}`) },
    toBeFalsy() { if (actual) throw new Error(`Expected falsy, got ${JSON.stringify(actual)}`) },
  }
}

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' }
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

console.log('\nremoveWorktree — backward compat')

await test('no hint = removes worktree, preserves branch', async () => {
  const wtPath = path.join(root, 'wt-compat')
  await createWorktree(repoPath, wtPath, 'feature-compat')

  const result = await removeWorktree(repoPath, wtPath)
  expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
  expect(result.branchDeleted).toBe(undefined)
  expect(git('git branch --list feature-compat').length > 0).toBe(true)
  // Cleanup leaked branch
  git('git branch -D feature-compat')
})

console.log('\nremoveWorktree — multi-fallback branch cleanup')

await test('hint activates fallback: finds branch via metadata even if hint is wrong', async () => {
  const wtPath = path.join(root, 'wt-meta')
  await createWorktree(repoPath, wtPath, 'feature-meta')

  // Pass a wrong hint — metadata should still find "feature-meta"
  const result = await removeWorktree(repoPath, wtPath, 'nonexistent-branch')
  expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
  expect(result.branchDeleted).toBe(true)
  expect(git('git branch --list feature-meta')).toBe('')
})

await test('deletes branch via exact caller hint', async () => {
  const wtPath = path.join(root, 'wt-hint')
  await createWorktree(repoPath, wtPath, 'feature-hint')

  const result = await removeWorktree(repoPath, wtPath, 'feature-hint')
  expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
  expect(result.branchDeleted).toBe(true)
  expect(git('git branch --list feature-hint')).toBe('')
})

await test('falls back to path basename', async () => {
  const wtPath = path.join(root, 'feature-basename')
  await createWorktree(repoPath, wtPath, 'feature-basename')

  // Pass wrong hint — basename "feature-basename" matches a real branch
  const result = await removeWorktree(repoPath, wtPath, 'wrong-hint')
  expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
  expect(result.branchDeleted).toBe(true)
  expect(git('git branch --list feature-basename')).toBe('')
})

await test('reports failure when no candidate branch exists', async () => {
  const wtPath = path.join(root, 'wt-gone')
  await createWorktree(repoPath, wtPath, 'branch-gone')
  git('git worktree remove ' + wtPath + ' --force')
  git('git branch -D branch-gone')

  const result = await removeWorktree(repoPath, wtPath, 'branch-gone')
  expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
  expect(result.branchDeleted).toBeFalsy()
})

await test('skips current branch in candidates', async () => {
  const wtPath = path.join(root, 'wt-skip')
  await createWorktree(repoPath, wtPath, 'feature-skip')

  // "main" is the current branch — passed as hint but should be skipped; metadata finds "feature-skip"
  const result = await removeWorktree(repoPath, wtPath, 'main')
  expect(result.branchDeleted).toBe(true)
  expect(git('git branch --list feature-skip')).toBe('')
})

await test('handles relative worktree path', async () => {
  const relPath = '../wt-rel'
  const absPath = path.join(root, 'wt-rel')
  await createWorktree(repoPath, relPath, 'feature-rel')

  const result = await removeWorktree(repoPath, relPath, 'feature-rel')
  expect(fs.existsSync(path.join(absPath, '.git'))).toBe(false)
  expect(result.branchDeleted).toBe(true)
  expect(git('git branch --list feature-rel')).toBe('')
})

console.log('\nlistBranches regex')

await test('handles + prefix for worktree branches', async () => {
  const wtPath = path.join(root, 'wt-plus')
  await createWorktree(repoPath, wtPath, 'feature-plus')
  const branches = await listBranches(repoPath)
  expect(branches.some(b => b === 'feature-plus')).toBe(true)
  expect(branches.every(b => !b.startsWith('+'))).toBe(true)
  await removeWorktree(repoPath, wtPath)
})

console.log(`\n${passed} passed, ${failed} failed`)
fs.rmSync(root, { recursive: true, force: true })
