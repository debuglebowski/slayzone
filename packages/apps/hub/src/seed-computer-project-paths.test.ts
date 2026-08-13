/**
 * The one-time hand-off of legacy `projects.path` values to the local computer.
 *
 * That column is being deleted — one path cannot describe two machines — but
 * every existing install has real values in it, so dropping it cold would blank
 * every project the user has. These are the rules that keep the hand-off from
 * doing damage of its own.
 */
import { seedProjectPaths, type SeedTarget } from './seed-computer-project-paths.js'

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
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

function assertEq(actual: unknown, expected: unknown, msg: string): void {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`)
}

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

async function main(): Promise<void> {
  console.log('\nlegacy project path seeding\n')

  await test('adopts a legacy path that exists on the computer', async () => {
    const r = fakeComputer({ onDisk: ['/home/k/dev/app'] })
    const out = await seedProjectPaths([{ id: 'p1', path: '/home/k/dev/app' }], r.target)
    assertEq(out.adopted, ['p1'], 'adopted')
    assertEq(r.adopted, [['p1', '/home/k/dev/app']], 'call')
  })

  // A reconnect must never overwrite a path the user has since re-pointed. The
  // seed is a one-time courtesy, not an authority.
  await test('never overwrites a mapping the computer already has', async () => {
    const r = fakeComputer({ mapped: { p1: '/somewhere/else' }, onDisk: ['/home/k/dev/app'] })
    const out = await seedProjectPaths([{ id: 'p1', path: '/home/k/dev/app' }], r.target)
    assertEq(out.adopted, [], 'nothing adopted')
    assertEq(out.skippedExisting, ['p1'], 'skipped')
    assertEq(r.mapped.p1, '/somewhere/else', 'left alone')
  })

  // The legacy value describes whatever machine was the default computer. Recording
  // it unchecked would write a mapping that is wrong by construction.
  await test('skips a legacy path that is not on this machine', async () => {
    const r = fakeComputer({ onDisk: [] })
    const out = await seedProjectPaths([{ id: 'p1', path: '/home/k/dev/app' }], r.target)
    assertEq(out.adopted, [], 'nothing adopted')
    assertEq(out.skippedMissing, ['p1'], 'skipped missing')
  })

  await test('ignores projects with no legacy path at all', async () => {
    const r = fakeComputer({ onDisk: [] })
    const out = await seedProjectPaths([{ id: 'p1', path: null }], r.target)
    assertEq(out, { adopted: [], skippedExisting: [], skippedMissing: [] }, 'no-op')
  })

  // One bad row must not leave the remaining projects unmapped — the user would
  // have to re-adopt every one of them by hand.
  await test('one failing project does not abort the batch', async () => {
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
    assertEq(out.adopted, ['p2'], 'second still adopted')
    assertEq(out.skippedMissing, ['p1'], 'first recorded as not seeded')
  })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

void main()
