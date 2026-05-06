/**
 * Tests for files-scan: `@file` autocomplete backing.
 * Run with: pnpm exec tsx packages/domains/terminal/src/main/files-scan.test.ts
 */
import { promises as fs, mkdtempSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { listProjectFiles } from './files-scan'

const execFileAsync = promisify(execFile)

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function assertEqual<T>(actual: T, expected: T, label?: string): void {
  if (actual !== expected) {
    throw new Error(`${label ?? 'values'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

async function makeTmpDir(): Promise<string> {
  return mkdtempSync(path.join(os.tmpdir(), 'files-scan-test-'))
}

async function writeFile(root: string, rel: string, content = ''): Promise<void> {
  const p = path.join(root, rel)
  await fs.mkdir(path.dirname(p), { recursive: true })
  await fs.writeFile(p, content, 'utf-8')
}

console.log('\nfiles-scan')

await test('fs-walk fallback: non-git dir returns files', async () => {
  const dir = await makeTmpDir()
  await writeFile(dir, 'src/App.tsx', '')
  await writeFile(dir, 'src/index.ts', '')
  await writeFile(dir, 'README.md', '')
  const results = await listProjectFiles(dir, 'app')
  const paths = results.map((r) => r.path)
  assertEqual(paths.includes('src/App.tsx'), true, 'App.tsx matched')
})

await test('fs-walk respects skip set (node_modules, dist, .git excluded)', async () => {
  const dir = await makeTmpDir()
  await writeFile(dir, 'src/keep.ts', '')
  await writeFile(dir, 'node_modules/foo/index.js', '')
  await writeFile(dir, 'dist/bundle.js', '')
  const results = await listProjectFiles(dir, '')
  const paths = results.map((r) => r.path)
  assertEqual(paths.some((p) => p.includes('node_modules')), false, 'node_modules excluded')
  assertEqual(paths.some((p) => p.includes('dist/')), false, 'dist excluded')
  assertEqual(paths.some((p) => p.includes('keep.ts')), true, 'src file kept')
})

await test('fs-walk: dotfiles / dotdirs excluded', async () => {
  const dir = await makeTmpDir()
  await writeFile(dir, '.env', '')
  await writeFile(dir, '.git/HEAD', '')
  await writeFile(dir, 'visible.ts', '')
  const results = await listProjectFiles(dir, '')
  const paths = results.map((r) => r.path)
  assertEqual(paths.includes('.env'), false, 'dotfile excluded')
  assertEqual(paths.some((p) => p.startsWith('.git')), false, '.git excluded')
  assertEqual(paths.includes('visible.ts'), true, 'regular file kept')
})

await test('fs-walk: depth cap stops recursion', async () => {
  const dir = await makeTmpDir()
  // Create deeply nested file at depth 6 (beyond maxDepth 4).
  await writeFile(dir, 'a/b/c/d/e/f/deep.ts', '')
  await writeFile(dir, 'top.ts', '')
  const results = await listProjectFiles(dir, '')
  const paths = results.map((r) => r.path)
  assertEqual(paths.includes('top.ts'), true, 'shallow file kept')
  assertEqual(paths.includes('a/b/c/d/e/f/deep.ts'), false, 'deep file pruned')
})

await test('query filter: prefix match on basename ranks above substring-in-path', async () => {
  const dir = await makeTmpDir()
  await writeFile(dir, 'widgets/Profile.tsx', '') // contains 'profile' in path only (as basename prefix — Profile → profile starts with profile)
  await writeFile(dir, 'data/user-dashboard/summary.json', '') // path contains 'dashboard'
  await writeFile(dir, 'Dashboard.tsx', '') // basename starts with 'dashboard'
  const results = await listProjectFiles(dir, 'dashboard')
  const paths = results.map((r) => r.path)
  // Dashboard.tsx = prefix match on basename (score 3). summary.json has 'dashboard' in path only (score 1).
  assertEqual(paths[0], 'Dashboard.tsx', 'prefix match ranks first')
  assertEqual(paths.includes('data/user-dashboard/summary.json'), true, 'path-only match still included')
})

await test('empty query with fs-walk returns all files', async () => {
  const dir = await makeTmpDir()
  await writeFile(dir, 'a.ts', '')
  await writeFile(dir, 'b.ts', '')
  const results = await listProjectFiles(dir, '')
  const paths = results.map((r) => r.path)
  assertEqual(paths.includes('a.ts'), true)
  assertEqual(paths.includes('b.ts'), true)
})

await test('limit caps result count', async () => {
  const dir = await makeTmpDir()
  for (let i = 0; i < 20; i++) {
    await writeFile(dir, `file-${i}.ts`, '')
  }
  const results = await listProjectFiles(dir, '', 5)
  assertEqual(results.length <= 5, true, `got ${results.length}, expected ≤5`)
})

await test('git ls-files path: honors .gitignore', async () => {
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
  assertEqual(paths.includes('tracked.ts'), true, 'tracked file included')
  assertEqual(paths.includes('ignored.ts'), false, 'gitignored file excluded')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
