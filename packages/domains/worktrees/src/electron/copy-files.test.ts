/**
 * Tests for copy-ignored-files feature (getIgnoredFileTree, copyIgnoredFiles, resolveCopyBehavior)
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/worktrees/src/main/copy-files.test.ts
 */
import { createTestHarness, expect } from '../../../../shared/test-utils/ipc-harness.js'
import { registerWorktreeHandlers, resolveCopyBehavior } from './handlers.js'
import { createWorktree, getIgnoredFileTree, copyIgnoredFiles } from './git-worktree.js'
import type { IgnoredFileNode } from '../shared/types.js'
import { execSync } from 'child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'

const h = await createTestHarness()
registerWorktreeHandlers(h.ipcMain as never, h.db as never)

const root = h.tmpDir()
const repoPath = path.join(root, 'repo')
fs.mkdirSync(repoPath)

function git(cmd: string, cwd = repoPath) {
  return execSync(cmd, { cwd, encoding: 'utf-8', env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@test.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@test.com' } }).trim()
}

let passed = 0
let failed = 0

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.log(`  ✗ ${name}`)
    console.error(`    ${e}`)
    failed++
  }
}

function section(name: string) {
  console.log(`\n${name}`)
}

// --- Setup ---

git('git init')
fs.writeFileSync(path.join(repoPath, 'README.md'), '# Test')
fs.writeFileSync(path.join(repoPath, '.gitignore'), 'dist/\n*.log\nbuild/\n')
git('git add -A')
git('git commit -m "initial"')

// Create ignored files
fs.mkdirSync(path.join(repoPath, 'dist'), { recursive: true })
fs.writeFileSync(path.join(repoPath, 'dist', 'bundle.js'), 'console.log("hi")')
fs.writeFileSync(path.join(repoPath, 'dist', 'index.css'), 'body{}')
fs.mkdirSync(path.join(repoPath, 'dist', 'nested'), { recursive: true })
fs.writeFileSync(path.join(repoPath, 'dist', 'nested', 'deep.js'), 'deep')
fs.writeFileSync(path.join(repoPath, 'app.log'), 'log line')
fs.mkdirSync(path.join(repoPath, 'build'), { recursive: true })
fs.writeFileSync(path.join(repoPath, 'build', 'output.js'), 'output')

// --- getIgnoredFileTree ---

section('getIgnoredFileTree')

await test('returns top-level nodes', async () => {
  const tree = await getIgnoredFileTree(repoPath)
  expect(tree.length).toBe(3) // build/, dist/, app.log
  const names = tree.map(n => n.name)
  expect(names).toContain('app.log')
  expect(names).toContain('dist')
  expect(names).toContain('build')
})

await test('dirs sorted before files', async () => {
  const tree = await getIgnoredFileTree(repoPath)
  // build, dist are dirs — should come first
  expect(tree[0].isDirectory).toBe(true)
  expect(tree[1].isDirectory).toBe(true)
  expect(tree[2].isDirectory).toBe(false)
})

await test('directory nodes have correct fileCount and children', async () => {
  const tree = await getIgnoredFileTree(repoPath)
  const dist = tree.find(n => n.name === 'dist')!
  expect(dist.isDirectory).toBe(true)
  expect(dist.fileCount).toBe(3) // bundle.js, index.css, nested/deep.js
  expect(dist.children.length).toBe(3) // bundle.js, index.css, nested/
})

await test('nested directory has children', async () => {
  const tree = await getIgnoredFileTree(repoPath)
  const dist = tree.find(n => n.name === 'dist')!
  const nested = dist.children.find(c => c.name === 'nested')!
  expect(nested.isDirectory).toBe(true)
  expect(nested.fileCount).toBe(1)
  expect(nested.children.length).toBe(1)
  expect(nested.children[0].name).toBe('deep.js')
  expect(nested.children[0].isDirectory).toBe(false)
})

await test('top-level file has real size', async () => {
  const tree = await getIgnoredFileTree(repoPath)
  const logFile = tree.find(n => n.name === 'app.log')!
  expect(logFile.size).toBeGreaterThan(0)
})

await test('directory nodes have size 0', async () => {
  const tree = await getIgnoredFileTree(repoPath)
  const dist = tree.find(n => n.name === 'dist')!
  expect(dist.size).toBe(0)
})

await test('file node has correct path', async () => {
  const tree = await getIgnoredFileTree(repoPath)
  const dist = tree.find(n => n.name === 'dist')!
  const bundle = dist.children.find(c => c.name === 'bundle.js')!
  expect(bundle.path).toBe('dist/bundle.js')
})

await test('returns empty for repo with no ignored files', async () => {
  const cleanRepo = path.join(root, 'clean-repo')
  fs.mkdirSync(cleanRepo)
  git('git init', cleanRepo)
  fs.writeFileSync(path.join(cleanRepo, 'hello.txt'), 'hi')
  git('git add -A', cleanRepo)
  git('git commit -m "init"', cleanRepo)

  const tree = await getIgnoredFileTree(cleanRepo)
  expect(tree.length).toBe(0)
})

// --- copyIgnoredFiles ---

section('copyIgnoredFiles')

await test('copies selected directory to worktree', async () => {
  const wtPath = path.join(root, 'wt-copy-1')
  await createWorktree(repoPath, wtPath, 'copy-test-1')

  await copyIgnoredFiles(repoPath, wtPath, 'custom', ['dist'])
  expect(fs.existsSync(path.join(wtPath, 'dist', 'bundle.js'))).toBe(true)
  expect(fs.existsSync(path.join(wtPath, 'dist', 'nested', 'deep.js'))).toBe(true)
  expect(fs.existsSync(path.join(wtPath, 'app.log'))).toBe(false)

  git(`git worktree remove "${wtPath}" --force`)
})

await test('copies individual files', async () => {
  const wtPath = path.join(root, 'wt-copy-2')
  await createWorktree(repoPath, wtPath, 'copy-test-2')

  await copyIgnoredFiles(repoPath, wtPath, 'custom', ['app.log'])
  expect(fs.existsSync(path.join(wtPath, 'app.log'))).toBe(true)
  expect(fs.existsSync(path.join(wtPath, 'dist'))).toBe(false)

  git(`git worktree remove "${wtPath}" --force`)
})

await test('copies all with behavior=all', async () => {
  const wtPath = path.join(root, 'wt-copy-3')
  await createWorktree(repoPath, wtPath, 'copy-test-3')

  await copyIgnoredFiles(repoPath, wtPath, 'all', [])
  expect(fs.existsSync(path.join(wtPath, 'dist', 'bundle.js'))).toBe(true)
  expect(fs.existsSync(path.join(wtPath, 'app.log'))).toBe(true)
  expect(fs.existsSync(path.join(wtPath, 'build', 'output.js'))).toBe(true)

  git(`git worktree remove "${wtPath}" --force`)
})

await test('skips path traversal attempts', async () => {
  const wtPath = path.join(root, 'wt-copy-4')
  await createWorktree(repoPath, wtPath, 'copy-test-4')

  await copyIgnoredFiles(repoPath, wtPath, 'custom', ['../etc/passwd'])
  expect(fs.existsSync(path.join(wtPath, '..', 'etc'))).toBe(false)

  git(`git worktree remove "${wtPath}" --force`)
})

await test('copied content bytes match source', async () => {
  const wtPath = path.join(root, 'wt-copy-bytes')
  await createWorktree(repoPath, wtPath, 'copy-test-bytes')

  await copyIgnoredFiles(repoPath, wtPath, 'custom', ['dist', 'app.log'])
  const srcBundle = fs.readFileSync(path.join(repoPath, 'dist', 'bundle.js'))
  const dstBundle = fs.readFileSync(path.join(wtPath, 'dist', 'bundle.js'))
  expect(srcBundle.equals(dstBundle)).toBe(true)
  const srcLog = fs.readFileSync(path.join(repoPath, 'app.log'))
  const dstLog = fs.readFileSync(path.join(wtPath, 'app.log'))
  expect(srcLog.equals(dstLog)).toBe(true)

  git(`git worktree remove "${wtPath}" --force`)
})

await test('fallback path works when clonefile disabled', async () => {
  const wtPath = path.join(root, 'wt-copy-fallback')
  await createWorktree(repoPath, wtPath, 'copy-test-fallback')

  process.env.SLAYZONE_DISABLE_CLONEFILE = '1'
  try {
    await copyIgnoredFiles(repoPath, wtPath, 'custom', ['dist', 'app.log'])
  } finally {
    delete process.env.SLAYZONE_DISABLE_CLONEFILE
  }
  expect(fs.existsSync(path.join(wtPath, 'dist', 'bundle.js'))).toBe(true)
  expect(fs.existsSync(path.join(wtPath, 'dist', 'nested', 'deep.js'))).toBe(true)
  expect(fs.existsSync(path.join(wtPath, 'app.log'))).toBe(true)

  git(`git worktree remove "${wtPath}" --force`)
})

await test('preserves symlinks (pnpm node_modules pattern)', async () => {
  // Isolated repo so we don't pollute shared repoPath state
  const symRepo = path.join(root, 'sym-repo')
  fs.mkdirSync(symRepo)
  git('git init', symRepo)
  fs.writeFileSync(path.join(symRepo, 'README.md'), '# sym')
  fs.writeFileSync(path.join(symRepo, '.gitignore'), 'node_modules/\n')
  git('git add -A', symRepo)
  git('git commit -m "init"', symRepo)

  // Mimic pnpm: real file in .pnpm/, symlink in node_modules/
  fs.mkdirSync(path.join(symRepo, 'node_modules', '.pnpm', 'pkg@1.0.0'), { recursive: true })
  fs.writeFileSync(path.join(symRepo, 'node_modules', '.pnpm', 'pkg@1.0.0', 'index.js'), 'module.exports = 1')
  fs.symlinkSync('.pnpm/pkg@1.0.0', path.join(symRepo, 'node_modules', 'pkg'))

  const wtPath = path.join(root, 'wt-copy-symlink')
  await createWorktree(symRepo, wtPath, 'copy-test-symlink')

  await copyIgnoredFiles(symRepo, wtPath, 'custom', ['node_modules'])
  const linkPath = path.join(wtPath, 'node_modules', 'pkg')
  expect(fs.lstatSync(linkPath).isSymbolicLink()).toBe(true)
  expect(fs.readlinkSync(linkPath)).toBe('.pnpm/pkg@1.0.0')

  execSync(`git worktree remove "${wtPath}" --force`, { cwd: symRepo })
})

// --- resolveCopyBehavior ---

section('resolveCopyBehavior')

await test('returns ask by default', () => {
  const result = resolveCopyBehavior(h.db as never)
  expect(result.behavior).toBe('ask')
  expect(result.customPaths).toEqual([])
})

await test('returns global setting when set', () => {
  h.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_copy_behavior', 'all')").run()
  const result = resolveCopyBehavior(h.db as never)
  expect(result.behavior).toBe('all')
  h.db.prepare("DELETE FROM settings WHERE key = 'worktree_copy_behavior'").run()
})

await test('project override takes precedence', () => {
  h.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_copy_behavior', 'all')").run()
  const projectId = 'test-project-copy'
  h.db.prepare("INSERT OR REPLACE INTO projects (id, name, path, color, worktree_copy_behavior) VALUES (?, ?, ?, ?, ?)").run(
    projectId, 'Test', repoPath, '#000000', 'none'
  )

  const result = resolveCopyBehavior(h.db as never, projectId)
  expect(result.behavior).toBe('none')

  const global = resolveCopyBehavior(h.db as never)
  expect(global.behavior).toBe('all')

  h.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId)
  h.db.prepare("DELETE FROM settings WHERE key = 'worktree_copy_behavior'").run()
})

await test('returns custom paths for custom behavior', () => {
  h.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_copy_behavior', 'custom')").run()
  h.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('worktree_copy_paths', 'node_modules, .env, dist')").run()

  const result = resolveCopyBehavior(h.db as never)
  expect(result.behavior).toBe('custom')
  expect(result.customPaths).toEqual(['node_modules', '.env', 'dist'])

  h.db.prepare("DELETE FROM settings WHERE key LIKE 'worktree_copy%'").run()
})

// --- IPC handlers ---

section('IPC handlers')

await test('git:getIgnoredFileTree via IPC', async () => {
  const tree = await h.invoke('git:getIgnoredFileTree', repoPath) as IgnoredFileNode[]
  expect(tree.length).toBe(3)
  const dist = tree.find(n => n.name === 'dist')!
  expect(dist.children.length).toBe(3)
})

await test('git:copyIgnoredFiles via IPC', async () => {
  const wtPath = path.join(root, 'wt-ipc-copy')
  await createWorktree(repoPath, wtPath, 'ipc-copy-test')

  await h.invoke('git:copyIgnoredFiles', repoPath, wtPath, ['dist', 'app.log'])
  expect(fs.existsSync(path.join(wtPath, 'dist', 'bundle.js'))).toBe(true)
  expect(fs.existsSync(path.join(wtPath, 'app.log'))).toBe(true)

  git(`git worktree remove "${wtPath}" --force`)
})

await test('git:resolveCopyBehavior via IPC', () => {
  const result = h.invoke('git:resolveCopyBehavior') as { behavior: string }
  expect(result.behavior).toBe('ask')
})

// --- Done ---

h.cleanup()
console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
console.log('\nDone')
