/**
 * file-editor router contract tests — exercise the fs procedures via tRPC
 * `createCaller` against a seeded tmp dir. Ports the coverage from the legacy
 * file-editor IPC-handler test (domains/file-editor/src/electron/handlers.test.ts).
 * showInFinder/watch (Electron AppDeps + subscription) were not covered there.
 * Run with: electron + experimental-loader (see test-utils/run-all.sh).
 */
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createTestHarness, test, expect } from '../../../../test-utils/ipc-harness.js'
import { fileEditorRouter } from './file-editor.js'

const h = await createTestHarness()
const caller = fileEditorRouter.createCaller({ db: h.slayDb })
const rootPath = h.tmpDir()

fs.mkdirSync(path.join(rootPath, 'src'))
fs.writeFileSync(path.join(rootPath, 'src', 'main.ts'), 'console.log("hello")')
fs.writeFileSync(path.join(rootPath, 'src', 'utils.ts'), 'export const x = 1')
fs.writeFileSync(path.join(rootPath, 'readme.md'), '# Hello')
fs.mkdirSync(path.join(rootPath, '.git'))
fs.writeFileSync(path.join(rootPath, '.git', 'config'), '')
fs.writeFileSync(path.join(rootPath, '.gitignore'), 'node_modules/\n*.log')
fs.mkdirSync(path.join(rootPath, 'node_modules'))
fs.writeFileSync(path.join(rootPath, 'node_modules', 'dep.js'), '')
fs.writeFileSync(path.join(rootPath, 'debug.log'), 'log content')

const didThrow = async (fn: () => Promise<unknown>): Promise<boolean> => {
  try {
    await fn()
    return false
  } catch {
    return true
  }
}

test('file-editor router: readDir sorts dirs first, hard-filters .git, FLAGS gitignored, lists subdir, empty for missing', async () => {
  const entries = (await caller.readDir({ rootPath, dirPath: '' })) as {
    name: string
    type: string
    ignored?: boolean
  }[]
  const types = entries.map((e) => e.type)
  const firstFile = types.indexOf('file')
  const lastDir = types.lastIndexOf('directory')
  if (lastDir >= 0 && firstFile >= 0) expect(lastDir < firstFile).toBe(true)

  const names = entries.map((e) => e.name)
  // .git is ALWAYS_IGNORED → hard-removed. gitignored entries are RETURNED but
  // flagged `ignored: true` (the renderer greys them, not the store).
  expect(names.includes('.git')).toBe(false)
  expect(entries.find((e) => e.name === 'node_modules')?.ignored).toBe(true)
  expect(entries.find((e) => e.name === 'debug.log')?.ignored).toBe(true)

  const sub = (await caller.readDir({ rootPath, dirPath: 'src' })) as { name: string }[]
  expect(sub.map((e) => e.name)).toContain('main.ts')
  expect(sub.map((e) => e.name)).toContain('utils.ts')

  expect(await caller.readDir({ rootPath, dirPath: 'missing-dir' })).toEqual([])
})

test('file-editor router: readFile content + rejects traversal', async () => {
  const result = (await caller.readFile({ rootPath, filePath: 'readme.md' })) as { content: string }
  expect(result.content).toBe('# Hello')
  expect(await didThrow(() => caller.readFile({ rootPath, filePath: '../../../etc/passwd' }))).toBe(true)
})

test('file-editor router: listAllFiles recursive, excludes ignored', async () => {
  const files = (await caller.listAllFiles({ rootPath })) as string[]
  expect(files).toContain('readme.md')
  expect(files).toContain('src/main.ts')
  expect(files).toContain('src/utils.ts')
  expect(files.includes('debug.log')).toBe(false)
  expect(files.includes('node_modules/dep.js')).toBe(false)
})

test('file-editor router: writeFile mutates disk', async () => {
  await caller.writeFile({ rootPath, filePath: 'readme.md', content: '# Updated' })
  expect(fs.readFileSync(path.join(rootPath, 'readme.md'), 'utf-8')).toBe('# Updated')
})

test('file-editor router: createFile new / rejects existing / creates parent dirs', async () => {
  await caller.createFile({ rootPath, filePath: 'new-file.txt' })
  expect(fs.existsSync(path.join(rootPath, 'new-file.txt'))).toBe(true)
  expect(await didThrow(() => caller.createFile({ rootPath, filePath: 'readme.md' }))).toBe(true)
  await caller.createFile({ rootPath, filePath: 'deep/nested/file.txt' })
  expect(fs.existsSync(path.join(rootPath, 'deep', 'nested', 'file.txt'))).toBe(true)
})

test('file-editor router: createDir single + nested', async () => {
  await caller.createDir({ rootPath, dirPath: 'new-dir' })
  expect(fs.statSync(path.join(rootPath, 'new-dir')).isDirectory()).toBe(true)
  await caller.createDir({ rootPath, dirPath: 'a/b/c' })
  expect(fs.statSync(path.join(rootPath, 'a', 'b', 'c')).isDirectory()).toBe(true)
})

test('file-editor router: rename file + rejects traversal', async () => {
  await caller.rename({ rootPath, oldPath: 'new-file.txt', newPath: 'renamed.txt' })
  expect(fs.existsSync(path.join(rootPath, 'renamed.txt'))).toBe(true)
  expect(fs.existsSync(path.join(rootPath, 'new-file.txt'))).toBe(false)
  expect(await didThrow(() => caller.rename({ rootPath, oldPath: 'renamed.txt', newPath: '../../escape.txt' }))).toBe(true)
})

test('file-editor router: delete file + dir recursive + rejects traversal', async () => {
  await caller.delete({ rootPath, targetPath: 'renamed.txt' })
  expect(fs.existsSync(path.join(rootPath, 'renamed.txt'))).toBe(false)
  await caller.delete({ rootPath, targetPath: 'a' })
  expect(fs.existsSync(path.join(rootPath, 'a'))).toBe(false)
  expect(await didThrow(() => caller.delete({ rootPath, targetPath: '../../danger' }))).toBe(true)
})
