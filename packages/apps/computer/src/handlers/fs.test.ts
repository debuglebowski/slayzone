import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  HubToComputerMethods,
  ComputerNotificationMethods
} from '@slayzone/computer-transport/shared'
import type { ComputerConfig } from '../config'
import { createFsHandlers } from './fs'
import type { ComputerDialer } from './types'

// Method names come from the SHARED frame contract, never a local copy. This
// module used to declare its own `FsMethods` + zod schemas that only "MIRRORED"
// the contract — the same divergence class that silently broke git.* and proc.*
// (four separate wire mismatches). Importing the canonical names here means a
// rename on either side fails the build instead of a routed call at runtime.
const M = HubToComputerMethods

const dialer: ComputerDialer = { notify: () => true }

function ctxWithRoots(roots: string[], notify?: ComputerDialer['notify']) {
  const config: ComputerConfig = {
    hubUrl: 'ws://localhost:0/computers',
    name: 'test',
    allowedRoots: roots,
    capabilities: ['fs']
  }
  return { dialer: notify ? { notify } : dialer, config, log: () => {} }
}

let dir: string
let roots: string[]

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'computer-fs-'))
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
    expect(handlers[M.fsPathExists]({ path: file })).toEqual({ exists: false })
    writeFileSync(file, 'x')
    expect(handlers[M.fsPathExists]({ path: file })).toEqual({ exists: true })
  })

  it('reports an existing directory as present', () => {
    const handlers = createFsHandlers(ctxWithRoots(roots))
    expect(handlers[M.fsPathExists]({ path: dir })).toEqual({ exists: true })
  })

  it('rejects an empty path via schema validation (before any fs access)', () => {
    const handlers = createFsHandlers(ctxWithRoots(roots))
    expect(() => handlers[M.fsPathExists]({ path: '' })).toThrow()
  })
})

describe('createFsHandlers — fs.removeDir', () => {
  it('recursively removes a populated directory tree', async () => {
    const handlers = createFsHandlers(ctxWithRoots(roots))
    const target = join(dir, 'nested')
    mkdirSync(join(target, 'deep'), { recursive: true })
    writeFileSync(join(target, 'deep', 'file.txt'), 'data')
    expect(existsSync(target)).toBe(true)

    const res = await handlers[M.fsRemoveDir]({ path: target })
    expect(res).toEqual({ ok: true })
    expect(existsSync(target)).toBe(false)
  })

  it('is idempotent — removing a nonexistent dir resolves ok (force:true)', async () => {
    const handlers = createFsHandlers(ctxWithRoots(roots))
    const gone = join(dir, 'never-existed')
    const res = await handlers[M.fsRemoveDir]({ path: gone })
    expect(res).toEqual({ ok: true })
  })
})

describe('createFsHandlers — allowedRoots guard', () => {
  it('rejects pathExists outside every allowed root', () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    // `/` is guaranteed to sit outside a tmpdir subroot.
    expect(() => handlers[M.fsPathExists]({ path: '/' })).toThrow(/allowedRoots/)
  })

  it('rejects a ../ traversal on pathExists', () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    expect(() => handlers[M.fsPathExists]({ path: join(dir, '..', 'escape') })).toThrow(
      /allowedRoots/
    )
  })

  it('rejects removeDir outside every allowed root — no deletion happens', async () => {
    // Root the computer at a child dir so a sibling is provably out of bounds.
    const child = join(dir, 'child')
    const sibling = join(dir, 'sibling')
    mkdirSync(child, { recursive: true })
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'keep.txt'), 'must survive')

    const handlers = createFsHandlers(ctxWithRoots([realpathSync(child)]))
    await expect(handlers[M.fsRemoveDir]({ path: sibling })).rejects.toThrow(/allowedRoots/)
    // The guard fired before rm — the sibling is untouched.
    expect(existsSync(join(sibling, 'keep.txt'))).toBe(true)
  })

  // A computer with no configured roots is the standalone default. It must refuse
  // everything rather than fall open — including the browse ops the picker calls
  // first, which is exactly where an accidental fail-open would be least visible.
  it('refuses every op when allowedRoots is empty', async () => {
    const handlers = createFsHandlers(ctxWithRoots([]))
    expect(() => handlers[M.fsPathExists]({ path: dir })).toThrow(/no allowedRoots/)
    await expect(handlers[M.fsListDir]({ path: dir })).rejects.toThrow(/no allowedRoots/)
    await expect(handlers[M.fsMkdir]({ path: join(dir, 'x') })).rejects.toThrow(/no allowedRoots/)
    expect(handlers[M.fsListRoots]({})).toEqual({
      roots: [],
      home: expect.any(String),
      platform: process.platform,
      sep: expect.any(String)
    })
  })
})

describe('createFsHandlers — fs.listRoots', () => {
  it('returns the realpath-resolved jail plus the computer platform idiom', () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const res = handlers[M.fsListRoots]({}) as {
      roots: string[]
      platform: string
      sep: string
    }
    expect(res.roots).toEqual([realpathSync(dir)])
    expect(res.platform).toBe(process.platform)
    expect(res.sep).toBe(process.platform === 'win32' ? '\\' : '/')
  })

  it('drops a configured root that does not exist rather than offering a dead end', () => {
    const absent = join(dir, 'not-created')
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir), absent]))
    const res = handlers[M.fsListRoots]({}) as { roots: string[] }
    expect(res.roots).toEqual([realpathSync(dir)])
  })
})

describe('createFsHandlers — fs.listDir', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'alpha'), { recursive: true })
    mkdirSync(join(dir, 'repo', '.git'), { recursive: true })
    mkdirSync(join(dir, '.hidden'), { recursive: true })
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'zeta.txt'), 'x')
  })

  it('lists directories before files, both alphabetical', async () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const res = (await handlers[M.fsListDir]({ path: dir })) as {
      entries: { name: string; type: string }[]
    }
    expect(res.entries.map((e) => e.name)).toEqual(['alpha', 'repo', 'zeta.txt'])
    expect(res.entries.map((e) => e.type)).toEqual(['directory', 'directory', 'file'])
  })

  it('flags a directory containing .git so the picker can mark repos', async () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const res = (await handlers[M.fsListDir]({ path: dir })) as {
      entries: { name: string; isGitRepo?: boolean }[]
    }
    expect(res.entries.find((e) => e.name === 'repo')?.isGitRepo).toBe(true)
    expect(res.entries.find((e) => e.name === 'alpha')?.isGitRepo).toBeUndefined()
  })

  it('hides dotfiles by default and reveals them with includeHidden', async () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const plain = (await handlers[M.fsListDir]({ path: dir })) as { entries: { name: string }[] }
    expect(plain.entries.map((e) => e.name)).not.toContain('.hidden')

    const withHidden = (await handlers[M.fsListDir]({ path: dir, includeHidden: true })) as {
      entries: { name: string }[]
    }
    expect(withHidden.entries.map((e) => e.name)).toContain('.hidden')
  })

  it('never lists node_modules or .git, even with includeHidden', async () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const res = (await handlers[M.fsListDir]({ path: dir, includeHidden: true })) as {
      entries: { name: string }[]
    }
    const names = res.entries.map((e) => e.name)
    expect(names).not.toContain('node_modules')
    expect(names).not.toContain('.git')
  })

  it('omits files under dirsOnly', async () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const res = (await handlers[M.fsListDir]({ path: dir, dirsOnly: true })) as {
      entries: { name: string }[]
    }
    expect(res.entries.map((e) => e.name)).toEqual(['alpha', 'repo'])
  })

  // The picker uses a null parent to stop offering "up". A root that reported a
  // parent would render an affordance the jail then refuses — a dead control
  // reads as a bug, so the boundary has to be explicit in the payload.
  it('reports parent null at an allowed root and a real parent below it', async () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const atRoot = (await handlers[M.fsListDir]({ path: dir })) as { parent: string | null }
    expect(atRoot.parent).toBeNull()

    const below = (await handlers[M.fsListDir]({ path: join(dir, 'alpha') })) as {
      parent: string | null
    }
    expect(below.parent).toBe(realpathSync(dir))
  })

  it('returns absolute paths on every entry', async () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const res = (await handlers[M.fsListDir]({ path: dir })) as {
      entries: { name: string; path: string }[]
    }
    expect(res.entries.find((e) => e.name === 'alpha')?.path).toBe(join(realpathSync(dir), 'alpha'))
  })
})

describe('createFsHandlers — fs.mkdir', () => {
  it('creates nested directories and returns the canonical path', async () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const target = join(dir, 'a', 'b', 'c')
    const res = (await handlers[M.fsMkdir]({ path: target })) as { path: string }
    expect(existsSync(target)).toBe(true)
    expect(res.path).toBe(realpathSync(target))
  })

  it('refuses to create outside the jail', async () => {
    const child = join(dir, 'child')
    mkdirSync(child, { recursive: true })
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(child)]))
    await expect(handlers[M.fsMkdir]({ path: join(dir, 'escape') })).rejects.toThrow(/allowedRoots/)
    expect(existsSync(join(dir, 'escape'))).toBe(false)
  })
})

describe('createFsHandlers — file-editor ops', () => {
  beforeEach(() => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'index.ts'), 'export const a = 1\n')
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
    writeFileSync(join(dir, 'ignored.txt'), 'nope')
  })

  it('readDir returns root-relative paths and honours .gitignore', () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const res = handlers[M.fsReadDir]({ rootPath: dir, dirPath: '' }) as {
      entries: { name: string; path: string; ignored?: boolean }[]
    }
    expect(res.entries.find((e) => e.name === 'index.ts')).toBeUndefined()
    expect(res.entries.find((e) => e.name === 'src')?.path).toBe('src')
    expect(res.entries.find((e) => e.name === 'ignored.txt')?.ignored).toBe(true)
  })

  it('round-trips writeFile → readFile', () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    handlers[M.fsWriteFile]({ rootPath: dir, filePath: 'src/new.ts', content: 'hi' })
    expect(handlers[M.fsReadFile]({ rootPath: dir, filePath: 'src/new.ts' })).toEqual({
      content: 'hi'
    })
  })

  it('rejects a rootPath outside the jail before file-editor sees it', () => {
    const child = join(dir, 'child')
    mkdirSync(child, { recursive: true })
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(child)]))
    expect(() => handlers[M.fsReadDir]({ rootPath: dir, dirPath: '' })).toThrow(/allowedRoots/)
  })

  // file-editor's own assertWithinRoot is the second guard: the jail bounds the
  // machine, the root bounds the workspace. A relative escape stays inside the
  // jail, so only this guard can catch it.
  it('rejects a relative escape from the root even when it stays inside the jail', () => {
    const child = join(dir, 'child')
    mkdirSync(child, { recursive: true })
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    expect(() => handlers[M.fsReadFile]({ rootPath: child, filePath: '../.gitignore' })).toThrow(
      /traversal/i
    )
  })

  it('listAllFiles reports truncated:false below the wire cap', () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const res = handlers[M.fsListAllFiles]({ rootPath: dir }) as {
      files: string[]
      truncated: boolean
    }
    expect(res.files).toContain('src/index.ts')
    expect(res.files).not.toContain('ignored.txt')
    expect(res.truncated).toBe(false)
  })

  it('searchFiles clamps maxResults to the wire cap instead of erroring', () => {
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)]))
    const res = handlers[M.fsSearchFiles]({
      rootPath: dir,
      query: 'export',
      options: { maxResults: 10_000_000 }
    }) as { results: { path: string }[]; truncated: boolean }
    expect(res.results.map((r) => r.path)).toContain('src/index.ts')
    expect(res.truncated).toBe(false)
  })
})

describe('createFsHandlers — watch lifecycle', () => {
  it('streams fs.change tagged with the hub-minted watchId, and stops on watchStop', async () => {
    const notify = vi.fn(() => true)
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)], notify))

    expect(handlers[M.fsWatchStart]({ watchId: 'w1', rootPath: dir })).toEqual({ ok: true })
    writeFileSync(join(dir, 'touched.txt'), 'x')
    // The watcher debounces 100ms before emitting.
    await vi.waitFor(() => expect(notify).toHaveBeenCalled(), { timeout: 5000 })

    const [method, params] = notify.mock.calls[0] as unknown as [string, { watchId: string }]
    expect(method).toBe(ComputerNotificationMethods.fsChange)
    expect(params.watchId).toBe('w1')

    expect(handlers[M.fsWatchStop]({ watchId: 'w1' })).toEqual({ ok: true })
    notify.mockClear()
    writeFileSync(join(dir, 'after-stop.txt'), 'x')
    await new Promise((r) => setTimeout(r, 300))
    expect(notify).not.toHaveBeenCalled()
  }, 20_000) // macOS `fs.watch` recursive rides FSEvents, whose latency grows with load. // Must exceed the waitFor above, or the test times out before the wait can.

  // A hub retry after reconnect must not leave two live subscriptions feeding one
  // client — the panel would see every change twice and refetch twice.
  it('is idempotent on watchId — a repeated start does not double-deliver', async () => {
    const notify = vi.fn(() => true)
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(dir)], notify))

    handlers[M.fsWatchStart]({ watchId: 'w1', rootPath: dir })
    handlers[M.fsWatchStart]({ watchId: 'w1', rootPath: dir })
    writeFileSync(join(dir, 'once.txt'), 'x')
    await vi.waitFor(() => expect(notify).toHaveBeenCalled(), { timeout: 5000 })
    await new Promise((r) => setTimeout(r, 300))

    const forThisFile = notify.mock.calls.filter(
      (c) => (c[1] as { relPath: string }).relPath === 'once.txt'
    )
    expect(forThisFile).toHaveLength(1)

    handlers[M.fsWatchStop]({ watchId: 'w1' })
  }, 20_000)

  it('refuses to watch a root outside the jail', () => {
    const child = join(dir, 'child')
    mkdirSync(child, { recursive: true })
    const handlers = createFsHandlers(ctxWithRoots([realpathSync(child)]))
    expect(() => handlers[M.fsWatchStart]({ watchId: 'w1', rootPath: dir })).toThrow(/allowedRoots/)
  })
})
