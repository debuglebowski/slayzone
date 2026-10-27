/**
 * `slay computer roots` (T-27): the device-local way to change a computer's folder
 * limits now that a hub can no longer push them. Pins the edit rules — removals,
 * de-duplicated additions, a missing folder reported rather than saved. The running
 * computer's pickup of the file is covered in the computer app's own suite
 * (`hardening.test.ts`). Pure.
 */
import { describe, expect, test } from 'vitest'
import { editAllowedRoots } from './computer'

const exists = (d: string): boolean => d !== '/nope'

describe('editAllowedRoots', () => {
  test('adds a folder once, keeps order', () => {
    const added = editAllowedRoots(['/a'], { add: ['/b', '/a'], remove: [], exists })
    expect(added.roots).toEqual(['/a', '/b'])
  })
  test('nothing missing', () => {
    const added = editAllowedRoots(['/a'], { add: ['/b', '/a'], remove: [], exists })
    expect(added.missing).toEqual([])
  })

  test('removes a folder', () => {
    const removed = editAllowedRoots(['/a', '/b'], { add: [], remove: ['/a'], exists })
    expect(removed.roots).toEqual(['/b'])
  })

  test('remove then add', () => {
    const swapped = editAllowedRoots(['/a'], { add: ['/c'], remove: ['/a'], exists })
    expect(swapped.roots).toEqual(['/c'])
  })

  test('reports a folder that does not exist', () => {
    const missing = editAllowedRoots(['/a'], { add: ['/nope'], remove: [], exists })
    expect(missing.missing).toEqual(['/nope'])
  })

  test('can compute an empty set (the command refuses to save it)', () => {
    const emptied = editAllowedRoots(['/a'], { add: [], remove: ['/a'], exists })
    expect(emptied.roots).toEqual([])
  })
})
