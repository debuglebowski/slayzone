/**
 * The cached command resolver the hub and the computer spawn git through: a bare
 * `git` makes the OS try every PATH entry on every call, so the absolute path is
 * resolved once per PATH and reused while the binary is still there.
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createCommandResolver, gitCommand } from './resolve-command'

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

/** `<dir>/<name>/git`, executable. */
function fakeGit(name: string): string {
  mkdirSync(join(dir, name), { recursive: true })
  const file = join(dir, name, 'git')
  writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 })
  return file
}

describe.skipIf(process.platform === 'win32')('createCommandResolver', () => {
  it('resolves the absolute path once and reuses it for the same PATH', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-cached-'))
    const git = fakeGit('b')
    const env = { PATH: [join(dir, 'a'), join(dir, 'b')].join(delimiter) }
    const resolve = createCommandResolver('git')
    expect(resolve(env)).toBe(git)
    expect(resolve(env)).toBe(git)
  })

  it('a git that appears earlier on the same PATH is not looked for while the cached one exists', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-cached-'))
    const later = fakeGit('b')
    const env = { PATH: [join(dir, 'a'), join(dir, 'b')].join(delimiter) }
    const resolve = createCommandResolver('git')
    expect(resolve(env)).toBe(later)
    fakeGit('a')
    expect(resolve(env)).toBe(later)
  })

  it('re-resolves when the cached binary disappears', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-cached-'))
    const first = fakeGit('a')
    const second = fakeGit('b')
    const env = { PATH: [join(dir, 'a'), join(dir, 'b')].join(delimiter) }
    const resolve = createCommandResolver('git')
    expect(resolve(env)).toBe(first)
    unlinkSync(first)
    expect(resolve(env)).toBe(second)
  })

  it('re-resolves when PATH changes', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-cached-'))
    const a = fakeGit('a')
    const b = fakeGit('b')
    const resolve = createCommandResolver('git')
    expect(resolve({ PATH: join(dir, 'a') })).toBe(a)
    expect(resolve({ PATH: join(dir, 'b') })).toBe(b)
    expect(resolve({ PATH: join(dir, 'a') })).toBe(a)
  })

  it('not found: the bare name, so the spawn still reports ENOENT as before', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-cached-'))
    const resolve = createCommandResolver('git')
    expect(resolve({ PATH: join(dir, 'none') })).toBe('git')
    // ...and found once it is installed, with no restart.
    const git = fakeGit('none')
    expect(resolve({ PATH: join(dir, 'none') })).toBe(git)
  })

  it('defaults to process.env', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-cached-'))
    const git = fakeGit('a')
    const saved = process.env.PATH
    process.env.PATH = join(dir, 'a')
    try {
      expect(createCommandResolver('git')()).toBe(git)
    } finally {
      process.env.PATH = saved
    }
  })

  it('gitCommand is a shared git resolver', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-cached-'))
    const git = fakeGit('a')
    expect(gitCommand({ PATH: join(dir, 'a') })).toBe(git)
  })
})

describe('createCommandResolver on Windows', () => {
  it('keeps the bare name for a .cmd/.bat: spawn without a shell cannot run those', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-cached-'))
    writeFileSync(join(dir, 'git.cmd'), '@echo off\r\n')
    const resolve = createCommandResolver('git', 'win32')
    expect(resolve({ PATH: dir, PATHEXT: '.CMD' })).toBe('git')
  })

  it('caches git.exe', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-cached-'))
    writeFileSync(join(dir, 'git.exe'), '')
    const resolve = createCommandResolver('git', 'win32')
    expect(resolve({ Path: dir, PATHEXT: '.EXE' })?.toLowerCase()).toBe(
      join(dir, 'git.exe').toLowerCase()
    )
  })
})
