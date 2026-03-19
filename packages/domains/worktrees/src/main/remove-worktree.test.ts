/**
 * Tests for removeWorktree with branch deletion.
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

console.log('\nremoveWorktree')

await test('backward compat: no branch param returns empty object', async () => {
  const wtPath = path.join(root, 'wt-compat')
  await createWorktree(repoPath, wtPath, 'feature-compat')
  const result = await removeWorktree(repoPath, wtPath)
  expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
  expect(result.branchDeleted).toBe(undefined)
  // Branch should still exist
  expect(git('git branch --list feature-compat').length > 0).toBe(true)
})

await test('deletes branch when branchToDelete provided', async () => {
  const wtPath = path.join(root, 'wt-del')
  await createWorktree(repoPath, wtPath, 'feature-del')
  const result = await removeWorktree(repoPath, wtPath, 'feature-del')
  expect(fs.existsSync(path.join(wtPath, '.git'))).toBe(false)
  expect(result.branchDeleted).toBe(true)
  expect(git('git branch --list feature-del')).toBe('')
})

await test('refuses to delete current branch', async () => {
  const wtPath = path.join(root, 'wt-safe')
  await createWorktree(repoPath, wtPath, 'feature-safe')
  const result = await removeWorktree(repoPath, wtPath, 'main')
  expect(result.branchDeleted).toBe(false)
  expect(result.branchError).toBeTruthy()
})

console.log('\nlistBranches regex')

await test('handles + prefix for worktree branches', async () => {
  // Create a worktree so one branch gets + prefix in git branch output
  const wtPath = path.join(root, 'wt-plus')
  await createWorktree(repoPath, wtPath, 'feature-plus')
  const branches = await listBranches(repoPath)
  expect(branches.some(b => b === 'feature-plus')).toBe(true)
  expect(branches.every(b => !b.startsWith('+'))).toBe(true)
  // Cleanup
  await removeWorktree(repoPath, wtPath)
})

console.log(`\n${passed} passed, ${failed} failed`)
fs.rmSync(root, { recursive: true, force: true })
