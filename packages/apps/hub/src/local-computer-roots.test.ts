/**
 * Local-computer path-jail widening policy.
 *
 * Routing the filesystem through the co-resident computer gave its `[homedir()]`
 * default authority over work the desktop app previously did unjailed, so every
 * project outside $HOME would have stopped working. These are the rules that
 * keep that from being a cap — pure functions, no computer needed.
 */
import { expect, test } from 'vitest'
import { isCoveredByRoots, missingRootsForProjects } from './local-computer-roots.js'

test('a root covers itself and anything beneath it', () => {
  expect(isCoveredByRoots('/home/kalle', ['/home/kalle']), 'the root itself').toEqual(true)
  expect(isCoveredByRoots('/home/kalle/dev/app', ['/home/kalle']), 'a descendant').toEqual(true)
})

// Prefix containment must respect the separator, or `/home/kalle2` would read
// as inside `/home/kalle` and the jail would leak to a sibling.
test('a sibling sharing a name prefix is not contained', () => {
  expect(isCoveredByRoots('/home/kalle2', ['/home/kalle']), 'sibling').toEqual(false)
})

// The unit is the PARENT: worktrees default to `../{name}-workspaces`, a
// sibling of the project. Seeding the project dir alone would admit the
// checkout and then refuse every worktree created from it.
test('asks for the project parent, not the project itself', () => {
  expect(missingRootsForProjects(['/Volumes/Work/app'], ['/home/kalle']), 'parent').toEqual([
    '/Volumes/Work'
  ])
})

test('asks for nothing when projects already sit inside the jail', () => {
  expect(
    missingRootsForProjects(['/home/kalle/dev/app', '/home/kalle/other'], ['/home/kalle']),
    'covered'
  ).toEqual([])
})

test('ignores a project with no path configured', () => {
  expect(missingRootsForProjects([null, null], ['/home/kalle']), 'null paths').toEqual([])
})

test('de-duplicates projects that share a parent', () => {
  expect(
    missingRootsForProjects(['/Volumes/Work/a', '/Volumes/Work/b'], ['/home/kalle']),
    'one entry'
  ).toEqual(['/Volumes/Work'])
})

// Otherwise the widen asks for both `/Volumes/Work/nested` and `/Volumes/Work`,
// leaving a redundant entry in the user's saved settings.
test('collapses an addition that a later, broader one subsumes', () => {
  expect(
    missingRootsForProjects(['/Volumes/Work/nested/a', '/Volumes/Work/b'], ['/home/kalle']),
    'collapsed'
  ).toEqual(['/Volumes/Work'])
})

// A path row of `/app` has parent `/`. Widening to the whole filesystem is
// never something to infer on the user's behalf — that row is simply bad.
test('refuses to infer the filesystem root', () => {
  expect(missingRootsForProjects(['/app'], ['/home/kalle']), 'no root grant').toEqual([])
})

// The computer's jail compares REAL paths. A project at ~/dev/proj where ~/dev is a
// symlink to another disk lives, as far as the jail can tell, under /Volumes/Disk/dev —
// outside [homedir()] — so its parent looked covered here (lexically it is) and the
// project was then refused on every fs/git call after the upgrade.
test('asks for the REAL parent of a project reached through a symlink', () => {
  const real = (p: string): string => (p === '/home/kalle/dev/proj' ? '/Volumes/Disk/dev/proj' : p)
  expect(
    missingRootsForProjects(['/home/kalle/dev/proj'], ['/home/kalle'], real),
    'real parent added although the lexical parent is already covered'
  ).toEqual(['/Volumes/Disk/dev'])
})

test('a symlinked project whose real location is already covered adds nothing', () => {
  const real = (p: string): string => (p === '/home/kalle/proj' ? '/home/kalle/other/proj' : p)
  expect(missingRootsForProjects(['/home/kalle/proj'], ['/home/kalle'], real), 'covered').toEqual(
    []
  )
})

test('still asks for the lexical parent too when it is not covered either', () => {
  const real = (p: string): string => (p === '/mnt/x/proj' ? '/data/x/proj' : p)
  expect(missingRootsForProjects(['/mnt/x/proj'], ['/home/kalle'], real), 'both').toEqual([
    '/mnt/x',
    '/data/x'
  ])
})
