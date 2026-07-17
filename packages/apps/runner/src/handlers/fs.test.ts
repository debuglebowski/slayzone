import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { RunnerConfig } from '../config'
import { createFsHandlers, FsMethods } from './fs'
import type { RunnerDialer } from './types'

const dialer: RunnerDialer = { notify: () => true }

function ctxWithRoots(roots: string[]) {
  const config: RunnerConfig = {
    hubUrl: 'ws://localhost:0/runners',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['fs']
  }
  return { dialer, config, log: () => {} }
}

let dir: string
let roots: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'runner-fs-'))
  // Canonicalize so containment holds on macOS (/var → /private/var).
  roots = [realpathSync(tmpdir())]
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('createFsHandlers — fs.pathExists', () => {
  it('is false for a missing path and true once the file exists', () => {
    const handlers = createFsHandlers(ctxWithRoots(roots))
    const file = join(dir, 'probe.txt')
    expect(handlers[FsMethods.pathExists]({ path: file })).toEqual({ exists: false })
    writeFileSync(file, 'x')
    expect(handlers[FsMethods.pathExists]({ path: file })).toEqual({ exists: true })
  })

  it('reports an existing directory as present', () => {
    const handlers = createFsHandlers(ctxWithRoots(roots))
    expect(handlers[FsMethods.pathExists]({ path: dir })).toEqual({ exists: true })
  })

  it('rejects an empty path via schema validation (before any fs access)', () => {
    const handlers = createFsHandlers(ctxWithRoots(roots))
    expect(() => handlers[FsMethods.pathExists]({ path: '' })).toThrow()
  })
})

describe('createFsHandlers — fs.removeDir', () => {
  it('recursively removes a populated directory tree', async () => {
    const handlers = createFsHandlers(ctxWithRoots(roots))
    const target = join(dir, 'nested')
    mkdirSync(join(target, 'deep'), { recursive: true })
    writeFileSync(join(target, 'deep', 'file.txt'), 'data')
    expect(existsSync(target)).toBe(true)

    const res = await handlers[FsMethods.removeDir]({ path: target })
    expect(res).toEqual({ ok: true })
    expect(existsSync(target)).toBe(false)
  })

  it('is idempotent — removing a nonexistent dir resolves ok (force:true)', async () => {
    const handlers = createFsHandlers(ctxWithRoots(roots))
    const gone = join(dir, 'never-existed')
    const res = await handlers[FsMethods.removeDir]({ path: gone })
    expect(res).toEqual({ ok: true })
  })
})

describe('createFsHandlers — allowedRoots guard', () => {
  it('rejects pathExists outside every allowed root', () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    // `/` is guaranteed to sit outside a tmpdir subroot.
    expect(() => handlers[FsMethods.pathExists]({ path: '/' })).toThrow(/allowedRoots/)
  })

  it('rejects a ../ traversal on pathExists', () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    expect(() => handlers[FsMethods.pathExists]({ path: join(dir, '..', 'escape') })).toThrow(
      /allowedRoots/
    )
  })

  it('rejects removeDir outside every allowed root — no deletion happens', async () => {
    // Root the runner at a child dir so a sibling is provably out of bounds.
    const child = join(dir, 'child')
    const sibling = join(dir, 'sibling')
    mkdirSync(child, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'keep.txt'), 'must survive')

    const handlers = createFsHandlers(ctxWithRoots([realpathSync(child)]))
    await expect(handlers[FsMethods.removeDir]({ path: sibling })).rejects.toThrow(/allowedRoots/)
    // The guard fired before rm — the sibling is untouched.
    expect(existsSync(join(sibling, 'keep.txt'))).toBe(true)
  })
})
