/**
 * T-104: ids that become path segments, and writes/deletes kept inside their base dir.
 * Vitest suite (run by `run_package_tests packages/shared/platform`).
 */
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  UnsafePathError,
  assertPathSafeId,
  containedPath,
  isPathSafeId,
  isUnsafePathError
} from './safe-path'
import { setSecurityLogSink } from './security-log'

const lines: Array<Record<string, unknown>> = []
setSecurityLogSink((line) => lines.push(JSON.parse(line)))
afterEach(() => {
  lines.length = 0
})

const BAD_IDS = [
  '..',
  '../..',
  '.',
  '',
  '/etc',
  '/',
  'C:\\Windows',
  'C:',
  '%2e%2e',
  '%2e%2e%2f',
  'a/b',
  'a\\b',
  '../x',
  'a\0b',
  '\0',
  'a b',
  'x'.repeat(129)
]

function codeOf(fn: () => unknown): unknown {
  try {
    fn()
  } catch (err) {
    return isUnsafePathError(err) ? err.code : err
  }
  return 'no throw'
}

describe('assertPathSafeId', () => {
  it('accepts every id shape the app makes', () => {
    for (const id of [
      '3f2b9c1e-7a4d-4c5e-9b8a-1d2e3f4a5b6c',
      'task-1',
      't1',
      'orphan_no-vs',
      'x'.repeat(128)
    ]) {
      expect(isPathSafeId(id)).toBe(true)
      expect(assertPathSafeId(id, 'taskId')).toBe(id)
    }
    expect(lines).toHaveLength(0)
  })

  it('refuses traversal, separators, absolute paths, encodings, NUL and empty', () => {
    for (const id of BAD_IDS) {
      expect(isPathSafeId(id)).toBe(false)
      expect(codeOf(() => assertPathSafeId(id, 'taskId'))).toBe('INVALID_ID')
    }
    for (const notAString of [undefined, null, 1, {}, ['a']]) {
      expect(codeOf(() => assertPathSafeId(notAString, 'taskId'))).toBe('INVALID_ID')
    }
  })

  it('writes one denied audit line per refusal, with the kind and code', () => {
    codeOf(() => assertPathSafeId('..', 'projectId'))
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      event: 'hub.path.refused',
      outcome: 'denied',
      detail: { kind: 'projectId', code: 'INVALID_ID', value: '".."' }
    })
  })

  it('is a stable, recognisable error', () => {
    let caught: unknown
    try {
      assertPathSafeId('..', 'taskId')
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(UnsafePathError)
    expect((caught as Error).message).toBe(
      "Invalid taskId: an id is 1-128 letters, digits, '_' or '-'"
    )
    // Structural match across a module copy; never a foreign error with that name.
    const copy = Object.assign(new Error('x'), { name: 'UnsafePathError', code: 'INVALID_ID' })
    expect(isUnsafePathError(copy)).toBe(true)
    expect(isUnsafePathError(Object.assign(new Error('x'), { name: 'UnsafePathError' }))).toBe(
      false
    )
  })
})

describe('containedPath', () => {
  const base = path.resolve('/srv/hub/storage/artifacts')

  it('resolves a path strictly inside its base', () => {
    expect(containedPath(base, 'task-1')).toBe(path.join(base, 'task-1'))
    expect(containedPath(base, 'task-1', 'a.md')).toBe(path.join(base, 'task-1', 'a.md'))
    // A name that merely starts with dots is a name, not a parent reference.
    expect(containedPath(base, '..foo')).toBe(path.join(base, '..foo'))
  })

  it('refuses the base itself, anything above or beside it, absolute paths and NUL', () => {
    for (const segments of [
      [''],
      ['.'],
      ['..'],
      ['../..'],
      ['task-1', '..'],
      ['../artifacts-other'],
      ['/etc/passwd'],
      ['task-1', '/etc'],
      ['a\0b']
    ]) {
      expect(codeOf(() => containedPath(base, ...segments))).toBe('PATH_OUTSIDE_BASE')
    }
  })
})
