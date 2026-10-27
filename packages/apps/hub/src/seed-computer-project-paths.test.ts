/**
 * The one-time hand-off of legacy `projects.path` values to the local computer.
 *
 * That column is being deleted — one path cannot describe two machines — but
 * every existing install has real values in it, so dropping it cold would blank
 * every project the user has. These are the rules that keep the hand-off from
 * doing damage of its own.
 */
import { expect, test } from 'vitest'
import { seedProjectPaths, type SeedTarget } from './seed-computer-project-paths.js'

/** A computer with a known mapping set and a known set of paths present on disk. */
function fakeComputer(opts: { mapped?: Record<string, string>; onDisk?: string[] } = {}) {
  const mapped = { ...(opts.mapped ?? {}) }
  const onDisk = new Set(opts.onDisk ?? [])
  const adopted: Array<[string, string]> = []
  const target: SeedTarget = {
    resolve: async (projectId) => ({ path: mapped[projectId] ?? null }),
    exists: async (path) => onDisk.has(path),
    adopt: async (projectId, path) => {
      adopted.push([projectId, path])
      mapped[projectId] = path
    }
  }
  return { target, adopted, mapped }
}

test('adopts a legacy path that exists on the computer', async () => {
  const r = fakeComputer({ onDisk: ['/home/k/dev/app'] })
  const out = await seedProjectPaths([{ id: 'p1', path: '/home/k/dev/app' }], r.target)
  expect(out.adopted, 'adopted').toEqual(['p1'])
  expect(r.adopted, 'call').toEqual([['p1', '/home/k/dev/app']])
})

// A reconnect must never overwrite a path the user has since re-pointed. The
// seed is a one-time courtesy, not an authority.
test('never overwrites a mapping the computer already has', async () => {
  const r = fakeComputer({ mapped: { p1: '/somewhere/else' }, onDisk: ['/home/k/dev/app'] })
  const out = await seedProjectPaths([{ id: 'p1', path: '/home/k/dev/app' }], r.target)
  expect(out.adopted, 'nothing adopted').toEqual([])
  expect(out.skippedExisting, 'skipped').toEqual(['p1'])
  expect(r.mapped.p1, 'left alone').toBe('/somewhere/else')
})

// The legacy value describes whatever machine was the default computer. Recording
// it unchecked would write a mapping that is wrong by construction.
test('skips a legacy path that is not on this machine', async () => {
  const r = fakeComputer({ onDisk: [] })
  const out = await seedProjectPaths([{ id: 'p1', path: '/home/k/dev/app' }], r.target)
  expect(out.adopted, 'nothing adopted').toEqual([])
  expect(out.skippedMissing, 'skipped missing').toEqual(['p1'])
})

test('ignores projects with no legacy path at all', async () => {
  const r = fakeComputer({ onDisk: [] })
  const out = await seedProjectPaths([{ id: 'p1', path: null }], r.target)
  expect(out, 'no-op').toEqual({ adopted: [], skippedExisting: [], skippedMissing: [] })
})

// One bad row must not leave the remaining projects unmapped — the user would
// have to re-adopt every one of them by hand.
test('one failing project does not abort the batch', async () => {
  const r = fakeComputer({ onDisk: ['/a', '/b'] })
  const boom: SeedTarget = {
    ...r.target,
    exists: async (p) => {
      if (p === '/a') throw new Error('computer blew up')
      return true
    }
  }
  const out = await seedProjectPaths(
    [
      { id: 'p1', path: '/a' },
      { id: 'p2', path: '/b' }
    ],
    boom
  )
  expect(out.adopted, 'second still adopted').toEqual(['p2'])
  expect(out.skippedMissing, 'first recorded as not seeded').toEqual(['p1'])
})
