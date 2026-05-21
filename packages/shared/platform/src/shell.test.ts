import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { buildShellInvocation, quoteForShell, setShellOverride } from './shell'

const isWin = process.platform === 'win32'

afterEach(() => setShellOverride(null))

/** Create a temp executable named `name` so resolveUserShell accepts it as a shell. */
function fakeShell(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-shell-'))
  const p = path.join(dir, name)
  fs.writeFileSync(p, isWin ? '@echo off\n' : '#!/bin/sh\n')
  if (!isWin) fs.chmodSync(p, 0o755)
  return p
}

describe('buildShellInvocation', () => {
  test('Windows → cmd /c <command>', () => {
    if (!isWin) return
    const { args } = buildShellInvocation('echo hi')
    expect(args).toEqual(['/c', 'echo hi'])
  })

  test('non-fish POSIX shell → -l -c <command>', () => {
    if (isWin) return
    setShellOverride(fakeShell('bash'))
    const { file, args } = buildShellInvocation('echo hi')
    expect(file.endsWith('/bash')).toBe(true)
    expect(args).toEqual(['-l', '-c', 'echo hi'])
  })

  test('fish shell → -i -l -c <command>', () => {
    if (isWin) return
    setShellOverride(fakeShell('fish'))
    const { args } = buildShellInvocation('echo hi')
    expect(args).toEqual(['-i', '-l', '-c', 'echo hi'])
  })

  test('the resolved { file, args } actually runs a command on this OS', () => {
    // No override → real shell. Proves the cmd /c (Windows) / -l -c (POSIX) arm
    // produces a spawnable invocation — the slay-init failure mode in issue #88.
    const { file, args } = buildShellInvocation('echo slz-ok')
    const out = execFileSync(file, args, { encoding: 'utf8' })
    expect(out).toContain('slz-ok')
  })
})

describe('quoteForShell', () => {
  test('quotes per host platform', () => {
    if (isWin) {
      expect(quoteForShell('a b')).toBe('"a b"')
    } else {
      expect(quoteForShell('a b')).toBe("'a b'")
      expect(quoteForShell("o'brien")).toBe(`'o'"'"'brien'`)
    }
  })
})
