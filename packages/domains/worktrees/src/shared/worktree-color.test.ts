import { describe, it, expect } from 'vitest'
import {
  WORKTREE_COLORS,
  hashStr,
  assignWorktreeColors,
  assignNewWorktreeColors
} from './worktree-color'

describe('hashStr', () => {
  it('is deterministic for same input', () => {
    expect(hashStr('/a/b/c')).toBe(hashStr('/a/b/c'))
  })

  it('returns non-negative', () => {
    for (const p of ['', '/x', '/a/b', 'zzzzzzzzzzzz', '/nested/path/to/worktree']) {
      expect(hashStr(p)).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('assignWorktreeColors', () => {
  it('assigns a palette color to every input path', () => {
    const paths = ['/a', '/b', '/c']
    const map = assignWorktreeColors(paths)
    expect(map.size).toBe(3)
    for (const p of paths) {
      expect(WORKTREE_COLORS).toContain(map.get(p))
    }
  })

  it('is deterministic across calls with same input', () => {
    const paths = ['/alpha', '/bravo', '/charlie']
    const a = assignWorktreeColors(paths)
    const b = assignWorktreeColors(paths)
    for (const p of paths) expect(a.get(p)).toBe(b.get(p))
  })

  it('is deterministic regardless of input order', () => {
    const a = assignWorktreeColors(['/alpha', '/bravo', '/charlie'])
    const b = assignWorktreeColors(['/charlie', '/alpha', '/bravo'])
    for (const p of ['/alpha', '/bravo', '/charlie']) expect(a.get(p)).toBe(b.get(p))
  })

  it('probes past collisions so distinct paths get distinct colors when palette permits', () => {
    const paths = ['/one', '/two', '/three', '/four']
    const map = assignWorktreeColors(paths)
    const colors = new Set(map.values())
    expect(colors.size).toBe(paths.length)
  })

  it('gracefully degrades with duplicates when input exceeds palette', () => {
    const paths = Array.from({ length: WORKTREE_COLORS.length + 3 }, (_, i) => `/p${i}`)
    const map = assignWorktreeColors(paths)
    expect(map.size).toBe(paths.length)
    for (const c of map.values()) expect(WORKTREE_COLORS).toContain(c)
  })

  it('returns empty map for empty input', () => {
    expect(assignWorktreeColors([]).size).toBe(0)
  })
})

describe('assignNewWorktreeColors', () => {
  it('preserves existing assignments (sticky slots)', () => {
    const initial = assignWorktreeColors(['/a', '/b'])
    const next = assignNewWorktreeColors(['/a', '/b', '/c'], initial)
    expect(next.get('/a')).toBe(initial.get('/a'))
    expect(next.get('/b')).toBe(initial.get('/b'))
    expect(next.get('/c')).toBeDefined()
    expect(WORKTREE_COLORS).toContain(next.get('/c'))
  })

  it('assigns new paths into slots not used by existing', () => {
    const initial = assignWorktreeColors(['/a', '/b'])
    const usedColors = new Set(initial.values())
    const next = assignNewWorktreeColors(['/a', '/b', '/c', '/d'], initial)
    // Two new paths should not duplicate already-used slots if palette still has room.
    expect(next.get('/c')).toBeDefined()
    expect(next.get('/d')).toBeDefined()
    expect(usedColors.has(next.get('/c')!)).toBe(false)
    expect(usedColors.has(next.get('/d')!)).toBe(false)
  })

  it('is a no-op when no new paths are provided', () => {
    const initial = assignWorktreeColors(['/a', '/b'])
    const next = assignNewWorktreeColors(['/a', '/b'], initial)
    expect(next.size).toBe(2)
    expect(next.get('/a')).toBe(initial.get('/a'))
    expect(next.get('/b')).toBe(initial.get('/b'))
  })

  it('removed-from-input paths stay in the map (sticky until registry reset)', () => {
    const initial = assignWorktreeColors(['/a', '/b', '/c'])
    const next = assignNewWorktreeColors(['/a'], initial)
    // '/b' and '/c' are no longer in `newPaths` but remain in the returned map,
    // preserving their slot assignment so a future re-creation re-uses the same color.
    expect(next.get('/b')).toBe(initial.get('/b'))
    expect(next.get('/c')).toBe(initial.get('/c'))
  })
})
