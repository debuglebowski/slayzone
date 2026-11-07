/**
 * Windows program lookup and invocation for argv runs (the conflict analysis's
 * agent CLI). Round-3 F6:
 * - npm installs a CLI as an extensionless sh shim (`claude`) PLUS `claude.cmd`.
 *   Trying the bare name first picked the shim, which Windows cannot spawn: the
 *   PATHEXT suffixes come first, as cmd.exe resolves.
 * - A `.cmd` runs through cmd.exe: its line is passed verbatim (no Node re-quoting)
 *   and its args quoted for cmd; the multi-line prompt goes by stdin, never on the
 *   line (cmd ends a command at the first newline).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { programInvocation } from './exec-run'
import { resolveCommand } from './resolve-command'

let dir = ''
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('on a Windows computer', () => {
  it('a .cmd (or .exe) wins over the extensionless npm sh shim', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-win-'))
    mkdirSync(join(dir, 'bin'))
    writeFileSync(join(dir, 'bin', 'claude'), '#!/bin/sh\n')
    writeFileSync(join(dir, 'bin', 'claude.cmd'), '@echo off\r\n')
    const env = { PATH: join(dir, 'bin'), PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    // PATHEXT spells it .CMD; Windows (like this test's disk) matches case-insensitively.
    expect(resolveCommand('claude', env, dir, 'win32')?.toLowerCase()).toBe(
      join(dir, 'bin', 'claude.cmd').toLowerCase()
    )
  })

  it('a name that already has its extension is taken as is', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-win-'))
    writeFileSync(join(dir, 'tool.exe'), '')
    expect(resolveCommand('tool.exe', { PATH: dir, PATHEXT: '.EXE' }, dir, 'win32')).toBe(
      join(dir, 'tool.exe')
    )
  })

  it('a .cmd runs through cmd.exe, its line verbatim and quoted for cmd', () => {
    dir = mkdtempSync(join(tmpdir(), 'resolve-win-'))
    writeFileSync(join(dir, 'claude.cmd'), '@echo off\r\n')
    const inv = programInvocation(
      { file: join(dir, 'claude.cmd'), args: ['--print', 'a "quoted" arg'] },
      dir,
      'win32'
    )
    expect(inv).toEqual({
      file: 'cmd.exe',
      args: ['/d', '/s', '/c', `""${join(dir, 'claude.cmd')}" "--print" "a ""quoted"" arg""`],
      windowsVerbatimArguments: true
    })
  })
})
