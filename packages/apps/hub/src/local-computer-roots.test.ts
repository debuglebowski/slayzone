/**
 * Local-computer path-jail widening policy.
 *
 * Routing the filesystem through the co-resident computer gave its `[homedir()]`
 * default authority over work the desktop app previously did unjailed, so every
 * project outside $HOME would have stopped working. These are the rules that
 * keep that from being a cap — pure functions, no computer needed.
 */
import { isCoveredByRoots, missingRootsForProjects } from './local-computer-roots.js'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
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

function main(): void {
  console.log('\nlocal computer root widening\n')

  test('a root covers itself and anything beneath it', () => {
    assertEq(isCoveredByRoots('/home/kalle', ['/home/kalle']), true, 'the root itself')
    assertEq(isCoveredByRoots('/home/kalle/dev/app', ['/home/kalle']), true, 'a descendant')
  })

  // Prefix containment must respect the separator, or `/home/kalle2` would read
  // as inside `/home/kalle` and the jail would leak to a sibling.
  test('a sibling sharing a name prefix is not contained', () => {
    assertEq(isCoveredByRoots('/home/kalle2', ['/home/kalle']), false, 'sibling')
  })

  // The unit is the PARENT: worktrees default to `../{name}-workspaces`, a
  // sibling of the project. Seeding the project dir alone would admit the
  // checkout and then refuse every worktree created from it.
  test('asks for the project parent, not the project itself', () => {
    assertEq(
      missingRootsForProjects(['/Volumes/Work/app'], ['/home/kalle']),
      ['/Volumes/Work'],
      'parent'
    )
  })

  test('asks for nothing when projects already sit inside the jail', () => {
    assertEq(
      missingRootsForProjects(['/home/kalle/dev/app', '/home/kalle/other'], ['/home/kalle']),
      [],
      'covered'
    )
  })

  test('ignores a project with no path configured', () => {
    assertEq(missingRootsForProjects([null, null], ['/home/kalle']), [], 'null paths')
  })

  test('de-duplicates projects that share a parent', () => {
    assertEq(
      missingRootsForProjects(['/Volumes/Work/a', '/Volumes/Work/b'], ['/home/kalle']),
      ['/Volumes/Work'],
      'one entry'
    )
  })

  // Otherwise the widen asks for both `/Volumes/Work/nested` and `/Volumes/Work`,
  // leaving a redundant entry in the user's saved settings.
  test('collapses an addition that a later, broader one subsumes', () => {
    assertEq(
      missingRootsForProjects(['/Volumes/Work/nested/a', '/Volumes/Work/b'], ['/home/kalle']),
      ['/Volumes/Work'],
      'collapsed'
    )
  })

  // A path row of `/app` has parent `/`. Widening to the whole filesystem is
  // never something to infer on the user's behalf — that row is simply bad.
  test('refuses to infer the filesystem root', () => {
    assertEq(missingRootsForProjects(['/app'], ['/home/kalle']), [], 'no root grant')
  })

  // The computer's jail compares REAL paths. A project at ~/dev/proj where ~/dev is a
  // symlink to another disk lives, as far as the jail can tell, under /Volumes/Disk/dev —
  // outside [homedir()] — so its parent looked covered here (lexically it is) and the
  // project was then refused on every fs/git call after the upgrade.
  test('asks for the REAL parent of a project reached through a symlink', () => {
    const real = (p: string): string =>
      p === '/home/kalle/dev/proj' ? '/Volumes/Disk/dev/proj' : p
    assertEq(
      missingRootsForProjects(['/home/kalle/dev/proj'], ['/home/kalle'], real),
      ['/Volumes/Disk/dev'],
      'real parent added although the lexical parent is already covered'
    )
  })

  test('a symlinked project whose real location is already covered adds nothing', () => {
    const real = (p: string): string => (p === '/home/kalle/proj' ? '/home/kalle/other/proj' : p)
    assertEq(missingRootsForProjects(['/home/kalle/proj'], ['/home/kalle'], real), [], 'covered')
  })

  test('still asks for the lexical parent too when it is not covered either', () => {
    const real = (p: string): string => (p === '/mnt/x/proj' ? '/data/x/proj' : p)
    assertEq(
      missingRootsForProjects(['/mnt/x/proj'], ['/home/kalle'], real),
      ['/mnt/x', '/data/x'],
      'both'
    )
  })

  console.log(`\n${passed} passed, ${failed} failed\n`)
  if (failed > 0) process.exit(1)
}

main()
