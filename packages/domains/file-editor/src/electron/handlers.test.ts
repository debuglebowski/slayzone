/**
 * File editor handler contract tests
 * Run with: ELECTRON_RUN_AS_NODE=1 npx electron --import tsx/esm --loader ./packages/shared/test-utils/loader.ts packages/domains/file-editor/src/main/handlers.test.ts
 */
import { createTestHarness, test, expect, describe } from '../../../../shared/test-utils/ipc-harness.js'
import { registerFileEditorHandlers } from './handlers.js'
import * as fs from 'node:fs'
import * as path from 'node:path'

const h = await createTestHarness()
registerFileEditorHandlers(h.ipcMain as never)

const root = h.tmpDir()

// Seed filesystem
fs.mkdirSync(path.join(root, 'src'))
fs.writeFileSync(path.join(root, 'src', 'main.ts'), 'console.log("hello")')
fs.writeFileSync(path.join(root, 'src', 'utils.ts'), 'export const x = 1')
fs.writeFileSync(path.join(root, 'readme.md'), '# Hello')
fs.mkdirSync(path.join(root, '.git'))
fs.writeFileSync(path.join(root, '.git', 'config'), '')
fs.writeFileSync(path.join(root, '.gitignore'), 'node_modules/\n*.log')
fs.mkdirSync(path.join(root, 'node_modules'))
fs.writeFileSync(path.join(root, 'node_modules', 'dep.js'), '')
fs.writeFileSync(path.join(root, 'debug.log'), 'log content')

describe('fs:readDir', () => {
  test('lists root dir, sorts dirs first', () => {
    const entries = h.invoke('fs:readDir', root, '') as { name: string; type: string }[]
    const types = entries.map(e => e.type)
    const firstFile = types.indexOf('file')
    const lastDir = types.lastIndexOf('directory')
    if (lastDir >= 0 && firstFile >= 0) {
      expect(lastDir < firstFile ? true : false).toBe(true)
    }
  })

  test('filters .git (ALWAYS_IGNORED)', () => {
    const entries = h.invoke('fs:readDir', root, '') as { name: string }[]
    const names = entries.map(e => e.name)
    expect(names.includes('.git')).toBe(false)
  })

  test('filters gitignored entries', () => {
    const entries = h.invoke('fs:readDir', root, '') as { name: string }[]
    const names = entries.map(e => e.name)
    expect(names.includes('node_modules')).toBe(false)
    expect(names.includes('debug.log')).toBe(false)
  })

  test('lists subdirectory', () => {
    const entries = h.invoke('fs:readDir', root, 'src') as { name: string }[]
    const names = entries.map(e => e.name)
    expect(names).toContain('main.ts')
    expect(names).toContain('utils.ts')
  })

  test('returns empty list for missing subdirectory', () => {
    const entries = h.invoke('fs:readDir', root, 'missing-dir') as { name: string }[]
    expect(entries).toEqual([])
  })
})

describe('fs:readFile', () => {
  test('reads file content', () => {
    const result = h.invoke('fs:readFile', root, 'readme.md') as { content: string; tooLarge?: boolean }
    expect(result.content).toBe('# Hello')
  })

  test('rejects path traversal', () => {
    expect(() => h.invoke('fs:readFile', root, '../../../etc/passwd')).toThrow()
  })
})

describe('fs:listAllFiles', () => {
  test('lists all non-ignored files recursively', () => {
    const files = h.invoke('fs:listAllFiles', root) as string[]
    expect(files).toContain('readme.md')
    expect(files).toContain('src/main.ts')
    expect(files).toContain('src/utils.ts')
    // Ignored files should NOT appear
    expect(files.includes('debug.log')).toBe(false)
    expect(files.includes('node_modules/dep.js')).toBe(false)
  })
})

describe('fs:writeFile', () => {
  test('writes file', () => {
    h.invoke('fs:writeFile', root, 'readme.md', '# Updated')
    const content = fs.readFileSync(path.join(root, 'readme.md'), 'utf-8')
    expect(content).toBe('# Updated')
  })
})

describe('fs:createFile', () => {
  test('creates new file', () => {
    h.invoke('fs:createFile', root, 'new-file.txt')
    expect(fs.existsSync(path.join(root, 'new-file.txt'))).toBe(true)
  })

  test('rejects existing file', () => {
    expect(() => h.invoke('fs:createFile', root, 'readme.md')).toThrow()
  })

  test('creates parent dirs', () => {
    h.invoke('fs:createFile', root, 'deep/nested/file.txt')
    expect(fs.existsSync(path.join(root, 'deep', 'nested', 'file.txt'))).toBe(true)
  })
})

describe('fs:createDir', () => {
  test('creates directory', () => {
    h.invoke('fs:createDir', root, 'new-dir')
    expect(fs.statSync(path.join(root, 'new-dir')).isDirectory()).toBe(true)
  })

  test('creates nested dirs', () => {
    h.invoke('fs:createDir', root, 'a/b/c')
    expect(fs.statSync(path.join(root, 'a', 'b', 'c')).isDirectory()).toBe(true)
  })
})

describe('fs:rename', () => {
  test('renames file', () => {
    h.invoke('fs:rename', root, 'new-file.txt', 'renamed.txt')
    expect(fs.existsSync(path.join(root, 'renamed.txt'))).toBe(true)
    expect(fs.existsSync(path.join(root, 'new-file.txt'))).toBe(false)
  })

  test('rejects path traversal', () => {
    expect(() => h.invoke('fs:rename', root, 'renamed.txt', '../../escape.txt')).toThrow()
  })
})

describe('fs:delete', () => {
  test('deletes file', () => {
    h.invoke('fs:delete', root, 'renamed.txt')
    expect(fs.existsSync(path.join(root, 'renamed.txt'))).toBe(false)
  })

  test('deletes directory recursively', () => {
    h.invoke('fs:delete', root, 'a')
    expect(fs.existsSync(path.join(root, 'a'))).toBe(false)
  })

  test('rejects path traversal', () => {
    expect(() => h.invoke('fs:delete', root, '../../danger')).toThrow()
  })
})

h.cleanup()
console.log('\nDone')
