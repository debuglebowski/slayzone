/**
 * The path scope of a hub request (§9 Phase 7b): on top of the machine bound, every
 * path a scoped request judges must lie inside the task's / project's own folders —
 * never another task's (even one the caller also owns), never outside through `..`
 * or a link, and a copy-in source outside the scope only on a hub without login.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { judgePath, judgePathIn, runInScopeJail, type ScopeJail } from './path-jail'

let base: string
let proj: string
let wtA: string
let wtB: string
let outside: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'scope-jail-')))
  proj = join(base, 'proj')
  wtA = join(base, 'wt', 'a')
  wtB = join(proj, '.wt', 'b') // task B's worktree nested inside the project folder
  outside = join(base, 'elsewhere')
  for (const d of [proj, wtA, wtB, outside]) mkdirSync(d, { recursive: true })
  writeFileSync(join(wtB, 'secret.txt'), 'b')
  writeFileSync(join(outside, 'x.txt'), 'x')
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

/** The machine bound: everything under `base`. */
const machine = () => [base]
const taskA: () => ScopeJail = () => ({
  label: 'task a',
  roots: [wtA],
  excluded: [wtB],
  foreign: [wtB],
  hostReads: false
})
/** Task N works in the project folder; B's nested worktree is carved out. */
const taskN: () => ScopeJail = () => ({
  label: 'task n',
  roots: [proj],
  excluded: [wtB, wtA],
  foreign: [wtB, wtA],
  hostReads: false
})
const inJail = <T>(jail: ScopeJail, fn: () => T): T => runInScopeJail(jail, fn)

describe('scope jail', () => {
  it('admits paths inside the scope root', () => {
    expect(inJail(taskA(), () => judgePath(join(wtA, 'f.ts'), machine()))).toBe(join(wtA, 'f.ts'))
    expect(inJail(taskN(), () => judgePath(join(proj, 'src'), machine()))).toBe(join(proj, 'src'))
  })

  it("refuses another task's root, even when the machine bound admits it", () => {
    expect(() => inJail(taskA(), () => judgePath(join(wtB, 'secret.txt'), machine()))).toThrow(
      /outside the folders of task a/
    )
    // B's worktree nested in N's project folder: carved out.
    expect(() => inJail(taskN(), () => judgePath(join(wtB, 'secret.txt'), machine()))).toThrow(
      /another task's folder/
    )
  })

  it('refuses `..` out of the scope and root-scoped traversal', () => {
    expect(() =>
      inJail(taskA(), () => judgePath(join(wtA, '..', '..', 'proj'), machine()))
    ).toThrow(/outside the folders/)
    expect(() =>
      inJail(taskN(), () => judgePathIn(proj, join('.wt', 'b', 'secret.txt'), machine()))
    ).toThrow(/another task's folder/)
  })

  it("refuses a link from the scope root into another task's root or out of every root", () => {
    symlinkSync(wtB, join(wtA, 'to-b'))
    symlinkSync(outside, join(wtA, 'to-out'))
    expect(() =>
      inJail(taskA(), () => judgePath(join(wtA, 'to-b', 'secret.txt'), machine()))
    ).toThrow(/outside the folders/)
    expect(() => inJail(taskA(), () => judgePath(join(wtA, 'to-out', 'x.txt'), machine()))).toThrow(
      /outside the folders/
    )
  })

  it('a task with no folder here is refused everything', () => {
    const none: ScopeJail = {
      label: 'task z',
      roots: [],
      excluded: [],
      foreign: [],
      hostReads: false
    }
    expect(() => inJail(none, () => judgePath(join(wtA, 'f'), machine()))).toThrow(
      /has no folder on this computer/
    )
  })

  it('a copy-in source may lie outside the scope only on a hub without login', () => {
    const src = join(outside, 'x.txt')
    expect(() => inJail(taskA(), () => judgePath(src, machine(), { hostRead: true }))).toThrow(
      /outside the folders/
    )
    expect(
      inJail({ ...taskA(), hostReads: true }, () => judgePath(src, machine(), { hostRead: true }))
    ).toBe(src)
    // Never past the machine bound, scope or not.
    expect(() =>
      inJail({ ...taskA(), hostReads: true }, () =>
        judgePath('/etc/hosts', machine(), { hostRead: true })
      )
    ).toThrow()
  })

  it('unscoped requests keep the machine bound only', () => {
    expect(judgePath(join(wtB, 'secret.txt'), machine())).toBe(join(wtB, 'secret.txt'))
  })

  it("a subtask sharing its parent's worktree is not carved out of it", () => {
    const sub: ScopeJail = {
      label: 'task s',
      roots: [wtA],
      excluded: [wtA],
      foreign: [wtA],
      hostReads: false
    }
    expect(inJail(sub, () => judgePath(join(wtA, 'f'), machine()))).toBe(join(wtA, 'f'))
  })

  it('a NEW root may lie outside the scope, never inside a foreign root', () => {
    const fresh = join(base, 'workspaces', 'new-wt')
    expect(inJail(taskA(), () => judgePath(fresh, machine(), { newRoot: true }))).toBe(fresh)
    expect(() =>
      inJail(taskA(), () => judgePath(join(wtB, 'nested'), machine(), { newRoot: true }))
    ).toThrow(/not task a's/)
    // Without the option the same fresh folder is outside the scope.
    expect(() => inJail(taskA(), () => judgePath(fresh, machine()))).toThrow(/outside the folders/)
  })
})
