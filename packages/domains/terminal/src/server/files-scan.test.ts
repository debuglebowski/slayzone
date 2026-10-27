/**
 * Tests for files-scan: `@file` autocomplete backing.
 */
import { expect, test } from 'vitest'
import { promises as fs, mkdtempSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listProjectFiles } from './files-scan'

const execFileAsync = promisify(execFile)

async function makeTmpDir(): Promise<string> {
  return mkdtempSync(path.join(os.tmpdir(), 'files-scan-test-'))
}

async function writeFile(root: string, rel: string, content = ''): Promise<void> {
  const p = path.join(root, rel)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content, 'utf-8')
}

test('fs-walk fallback: non-git dir returns files', async () => {
  const dir = await makeTmpDir()
  await writeFile(dir, 'src/App.tsx', '')
  await writeFile(dir, 'src/index.ts', '')
  await writeFile(dir, 'README.md', '')
  const results = await listProjectFiles(dir, 'app')
  const paths = results.map((r) => r.path)
  expect(paths, 'App.tsx matched').toContain('src/App.tsx')
})

test('fs-walk respects skip set (node_modules, dist, .git excluded)', async () => {
  const dir = await makeTmpDir()
  await writeFile(dir, 'src/keep.ts', '')
  await writeFile(dir, 'node_modules/foo/index.js', '')
  await writeFile(dir, 'dist/bundle.js', '')
  const results = await listProjectFiles(dir, '')
  const paths = results.map((r) => r.path)
  expect(
    paths.some((p) => p.includes('node_modules')),
    'node_modules excluded'
  ).toBe(false)
  expect(
    paths.some((p) => p.includes('dist/')),
    'dist excluded'
  ).toBe(false)
  expect(
    paths.some((p) => p.includes('keep.ts')),
    'src file kept'
  ).toBe(true)
})

test('fs-walk: dotfiles / dotdirs excluded', async () => {
  const dir = await makeTmpDir()
  await writeFile(dir, '.env', '')
  await writeFile(dir, '.git/HEAD', '')
  await writeFile(dir, 'visible.ts', '')
  const results = await listProjectFiles(dir, '')
  const paths = results.map((r) => r.path)
  expect(paths, 'dotfile excluded').not.toContain('.env')
  expect(
    paths.some((p) => p.startsWith('.git')),
    '.git excluded'
  ).toBe(false)
  expect(paths, 'regular file kept').toContain('visible.ts')
})

test('fs-walk: depth cap stops recursion', async () => {
  const dir = await makeTmpDir()
  // Create deeply nested file at depth 6 (beyond maxDepth 4).
  await writeFile(dir, 'a/b/c/d/e/f/deep.ts', '')
  await writeFile(dir, 'top.ts', '')
  const results = await listProjectFiles(dir, '')
  const paths = results.map((r) => r.path)
  expect(paths, 'shallow file kept').toContain('top.ts')
  expect(paths, 'deep file pruned').not.toContain('a/b/c/d/e/f/deep.ts')
})

test('query filter: prefix match on basename ranks above substring-in-path', async () => {
  const dir = await makeTmpDir()
  await writeFile(dir, 'widgets/Profile.tsx', '') // contains 'profile' in path only (as basename prefix — Profile → profile starts with profile)
  await writeFile(dir, 'data/user-dashboard/summary.json', '') // path contains 'dashboard'
  await writeFile(dir, 'Dashboard.tsx', '') // basename starts with 'dashboard'
  const results = await listProjectFiles(dir, 'dashboard')
  const paths = results.map((r) => r.path)
  // Dashboard.tsx = prefix match on basename (score 3). summary.json has 'dashboard' in path only (score 1).
  expect(paths[0], 'prefix match ranks first').toBe('Dashboard.tsx')
  expect(paths, 'path-only match still included').toContain('data/user-dashboard/summary.json')
})

test('empty query with fs-walk returns all files', async () => {
  const dir = await makeTmpDir()
  await writeFile(dir, 'a.ts', '')
  await writeFile(dir, 'b.ts', '')
  const results = await listProjectFiles(dir, '')
  const paths = results.map((r) => r.path)
  expect(paths).toContain('a.ts')
  expect(paths).toContain('b.ts')
})

test('limit caps result count', async () => {
  const dir = await makeTmpDir()
  for (let i = 0; i < 20; i++) {
    await writeFile(dir, `file-${i}.ts`, '')
  }
  const results = await listProjectFiles(dir, '', 5)
  expect(results.length, `got ${results.length}, expected ≤5`).toBeLessThanOrEqual(5)
})

test('git ls-files path: honors .gitignore', async () => {
  const dir = await makeTmpDir()
  // Init a real git repo so the git branch is taken.
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: dir })
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir })
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: dir })
  } catch {
    console.log('    (skipped — git not available)')
    return
  }
  await writeFile(dir, '.gitignore', 'ignored.ts\n')
  await writeFile(dir, 'tracked.ts', '')
  await writeFile(dir, 'ignored.ts', '')
  const results = await listProjectFiles(dir, '')
  const paths = results.map((r) => r.path)
  expect(paths, 'tracked file included').toContain('tracked.ts')
  expect(paths, 'gitignored file excluded').not.toContain('ignored.ts')
})
