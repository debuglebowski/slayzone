/**
 * FU5 (computer stalls): judging a path re-canonicalized EVERY root of the request's
 * scope (`realpath` per root, more for a missing one) and every allowed root — 3 ms a
 * call with a task's 54 sibling worktrees, and a burst of `fs.pathExists` /
 * `slay.checkConfigured` / `agentConfig.fs` requests judges hundreds of paths. The
 * roots' canonical spellings are now remembered for 2 s, forgotten at once on any
 * write the jail judges or performs; the judged path itself is never cached.
 */
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const counted = vi.hoisted(() => ({ realpath: 0 }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  const native = ((...args: Parameters<typeof fs.realpathSync.native>) => {
    counted.realpath++
    return fs.realpathSync.native(...args)
  }) as typeof fs.realpathSync.native
  const realpathSync = Object.assign(
    (...args: Parameters<typeof fs.realpathSync>) => fs.realpathSync(...args),
    { native }
  ) as typeof fs.realpathSync
  return { ...fs, realpathSync, default: { ...fs, realpathSync } }
})

const { JailViolationError, jailedFs, judgePath, runInScopeJail } = await import('./path-jail')

let base: string
let proj: string
let siblings: string[]
beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'jail-cache-')))
  proj = join(base, 'proj')
  mkdirSync(join(proj, 'src'), { recursive: true })
  writeFileSync(join(proj, 'src', 'f.ts'), 'x')
  // A task scope as on the dev computer: its folder, and 50 other tasks' worktrees
  // carved out (a third of them deleted long ago).
  siblings = Array.from({ length: 50 }, (_, i) => join(base, 'proj-workspaces', `task-${i}`))
  siblings.forEach((w, i) => i % 3 && mkdirSync(w, { recursive: true }))
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(base, { recursive: true, force: true })
})
const scope = (excluded = siblings) => ({
  label: 'task t',
  roots: [proj],
  excluded,
  foreign: excluded,
  hostReads: false
})
const judgeIn = (jail: ReturnType<typeof scope>, path: string) =>
  runInScopeJail(jail, () => judgePath(path, [base]))

describe('root spellings are remembered briefly, not re-resolved per path', () => {
  test('200 paths in a 51-root scope: realpath calls do not scale with paths × roots', () => {
    const jail = scope()
    const target = join(proj, 'src', 'f.ts')
    counted.realpath = 0
    for (let i = 0; i < 200; i++) expect(judgeIn(jail, target)).toBe(target)
    // Was ≈ 200 × (51 roots + missing ancestors + allowed root): > 13,000.
    console.log(`[fu5] 200 judged paths, 51-root scope: ${counted.realpath} realpath calls`)
    expect(counted.realpath).toBeLessThan(200 * 4)
  })

  test("a write the jail performs forgets them at once: a sibling's root moved and re-linked is carved out", () => {
    const moved = siblings[1]!
    const elsewhere = join(base, 'proj-workspaces', 'elsewhere')
    mkdirSync(elsewhere, { recursive: true })
    writeFileSync(join(elsewhere, 'secret'), 's')
    const jail = scope([moved])
    const jailWide = { ...jail, roots: [proj, join(base, 'proj-workspaces')] }
    expect(judgeIn(jailWide, join(elsewhere, 'secret'))).toBe(join(elsewhere, 'secret'))
    // The sibling's worktree is moved by a hub frame (through the jail) …
    jailedFs.rename(
      judgePath(moved, [base], { access: 'entry' }),
      judgePath(`${moved}-old`, [base], { access: 'entry' })
    )
    // … and its old name re-pointed at `elsewhere` by someone else.
    symlinkSync(elsewhere, moved)
    expect(() => judgeIn(jailWide, join(elsewhere, 'secret'))).toThrow(JailViolationError)
  })

  test('a change nobody tells the jail about is seen within 2 s (the accepted bound)', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const linked = join(base, 'proj-workspaces', 'linked')
    const a = join(base, 'proj-workspaces', 'a')
    const b = join(base, 'proj-workspaces', 'b')
    for (const d of [a, b]) mkdirSync(d, { recursive: true })
    writeFileSync(join(b, 'f'), 'b')
    symlinkSync(a, linked)
    const jail = { ...scope([linked]), roots: [proj, join(base, 'proj-workspaces')] }
    expect(judgeIn(jail, join(b, 'f'))).toBe(join(b, 'f'))
    // Re-pointed out of band (a shell): the jail may judge by the old spelling …
    unlinkSync(linked)
    symlinkSync(b, linked)
    vi.advanceTimersByTime(1_000)
    expect(judgeIn(jail, join(b, 'f'))).toBe(join(b, 'f'))
    // … for at most 2 s.
    vi.advanceTimersByTime(1_001)
    expect(() => judgeIn(jail, join(b, 'f'))).toThrow(JailViolationError)
  })

  test('a root that did not exist is seen the moment it does (no remembered absence)', () => {
    const later = join(base, 'later')
    expect(() => judgePath(join(later, 'f'), [later])).toThrow(JailViolationError)
    mkdirSync(later)
    expect(judgePath(join(later, 'f'), [later])).toBe(join(later, 'f'))
  })
})
