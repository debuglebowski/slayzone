/**
 * Where a hub-started process STARTS (§9 Phase 7c): a terminal, background process,
 * warm agent or chat agent of a task starts inside that task's own folders on this
 * computer — an explicit cwd is judged against them, none means the task's own
 * folder (worktree, else base dir, else its project's folder). The hub no longer
 * knows those folders, so it can no longer check a cwd itself.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { implicitSpawnScope, type ScopeJail, scopedSpawnCwd } from './path-jail'

let base: string
let proj: string
let wtA: string
let wtB: string

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'scoped-spawn-')))
  proj = join(base, 'proj')
  wtA = join(base, 'wt', 'a')
  wtB = join(proj, '.wt', 'b')
  for (const d of [proj, wtA, wtB]) mkdirSync(d, { recursive: true })
})
afterEach(() => rmSync(base, { recursive: true, force: true }))

const machine = () => [base]
const jail = (roots: string[], excluded: string[] = []): ScopeJail => ({
  label: 'task a',
  roots,
  excluded,
  foreign: excluded,
  hostReads: false
})

describe('scopedSpawnCwd', () => {
  it("defaults to the scope's own folder (worktree first)", () => {
    expect(scopedSpawnCwd(jail([wtA, proj], [wtB]), undefined, machine())).toBe(wtA)
    expect(scopedSpawnCwd(jail([proj], [wtB]), undefined, machine())).toBe(proj)
  })

  it('admits an explicit cwd inside the scope', () => {
    expect(scopedSpawnCwd(jail([wtA, proj], [wtB]), join(wtA), machine())).toBe(wtA)
  })

  it("refuses a cwd in another task's folder, or out through a link", () => {
    expect(() => scopedSpawnCwd(jail([wtA, proj], [wtB]), wtB, machine())).toThrow(
      /another task's folder/
    )
    symlinkSync(wtB, join(wtA, 'to-b'))
    expect(() => scopedSpawnCwd(jail([wtA]), join(wtA, 'to-b'), machine())).toThrow(
      /outside the folders/
    )
  })

  it('refuses when the scope has no folder on this computer', () => {
    expect(() => scopedSpawnCwd(jail([join(base, 'gone')]), undefined, machine())).toThrow(
      /no folder on this computer/
    )
  })
})

describe('implicitSpawnScope', () => {
  it('names the task (with its project) or the project a spawn is for', () => {
    expect(implicitSpawnScope({ taskId: 't1', projectId: 'p1' })).toEqual({
      kind: 'task',
      taskId: 't1',
      projectId: 'p1'
    })
    expect(implicitSpawnScope({ projectId: 'p1' })).toEqual({ kind: 'project', projectId: 'p1' })
    expect(implicitSpawnScope({ cwd: '/x' })).toBeNull()
    expect(implicitSpawnScope(null)).toBeNull()
  })
})

describe('a project with no folder here', () => {
  it('answers with the caller-supplied error, so the hub can ask to place it', () => {
    const placed = new Error('place project p1')
    expect(() =>
      scopedSpawnCwd(jail([join(base, 'gone')]), undefined, machine(), () => placed)
    ).toThrow(placed)
  })
})
