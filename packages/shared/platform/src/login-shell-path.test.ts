import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  findOnPath,
  LOGIN_SHELL_PATH_MARKER,
  loginShellPathProbes,
  mergePathLists,
  parseLoginShellPathOutput
} from './login-shell-path'

const isWin = process.platform === 'win32'

/**
 * A fake login shell named `name` whose startup files are noisy (a prompt theme,
 * gitstatus, a terminal-title escape) on stdout, then runs the `-c` command with
 * `extraDir` prepended to PATH, then prints more noise.
 */
function noisyShell(name: string, extraDir: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-login-path-'))
  const p = path.join(dir, name)
  fs.writeFileSync(
    p,
    [
      '#!/bin/sh',
      'echo "gitstatus: initializing"',
      "printf '\\033]0;title\\007'",
      'while [ "$1" != "-c" ]; do shift; done',
      'shift',
      `PATH="${extraDir}:$PATH"`,
      'eval "$1"',
      'echo "trailing rc noise"'
    ].join('\n') + '\n'
  )
  fs.chmodSync(p, 0o755)
  return p
}

describe('parseLoginShellPathOutput', () => {
  test('finds the marked line among startup noise', () => {
    const out = `prompt noise\n\x1b]0;title\x07\n${LOGIN_SHELL_PATH_MARKER}/opt/homebrew/bin:/usr/bin\nmore noise\n`
    expect(parseLoginShellPathOutput(out)).toBe('/opt/homebrew/bin:/usr/bin')
  })

  test('tolerates CRLF line endings', () => {
    expect(parseLoginShellPathOutput(`noise\r\n${LOGIN_SHELL_PATH_MARKER}/a:/b\r\n`)).toBe('/a:/b')
  })

  test('no marker → null (never mistakes noise for a PATH)', () => {
    expect(parseLoginShellPathOutput('gitstatus: initializing\n/usr/bin:/bin\n')).toBeNull()
  })

  test('empty marked value → null', () => {
    expect(parseLoginShellPathOutput(`${LOGIN_SHELL_PATH_MARKER}\n`)).toBeNull()
  })
})

describe('mergePathLists', () => {
  const list = (...entries: string[]) => entries.join(path.delimiter)

  test('login-shell entries first, then inherited entries it lacks', () => {
    expect(
      mergePathLists(list('/opt/homebrew/bin', '/usr/bin'), list('/usr/bin', '/custom/bin'))
    ).toBe(list('/opt/homebrew/bin', '/usr/bin', '/custom/bin'))
  })

  test('drops empty entries and duplicates', () => {
    expect(mergePathLists(list('/a', '', '/a', '/b'), list('', '/b', ''))).toBe(list('/a', '/b'))
  })

  test('no inherited PATH → login-shell PATH as is', () => {
    expect(mergePathLists(list('/a', '/b'), undefined)).toBe(list('/a', '/b'))
  })
})

describe('loginShellPathProbes', () => {
  test('Windows → no probes', () => {
    if (!isWin) return
    expect(loginShellPathProbes('C:\\Windows\\System32\\cmd.exe')).toEqual([])
  })

  test('interactive login first, login-only fallback', () => {
    if (isWin) return
    const probes = loginShellPathProbes('/bin/zsh')
    expect(probes.map((p) => p.args.slice(0, -1))).toEqual([
      ['-i', '-l', '-c'],
      ['-l', '-c']
    ])
    expect(probes.every((p) => p.file === '/bin/zsh')).toBe(true)
  })

  test('round-trips through a noisy interactive shell', () => {
    if (isWin) return
    const shell = noisyShell('zsh', '/opt/fake-brew/bin')
    const [probe] = loginShellPathProbes(shell)
    const out = execFileSync(probe.file, probe.args, { encoding: 'utf-8' })
    const probed = parseLoginShellPathOutput(out)
    expect(probed?.split(':')[0]).toBe('/opt/fake-brew/bin')
    expect(probed).not.toContain('noise')
  })

  test('fish joins its PATH list with colons', () => {
    if (isWin) return
    let fish: string
    try {
      fish = execFileSync('/bin/sh', ['-c', 'command -v fish'], { encoding: 'utf-8' }).trim()
    } catch {
      return // fish not installed
    }
    const probe = loginShellPathProbes(fish).at(-1)!
    const out = execFileSync(probe.file, probe.args, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore']
    })
    const probed = parseLoginShellPathOutput(out)
    // A bare `echo $PATH` in fish prints the list space-separated.
    expect(probed).toContain(':')
  })
})

describe('findOnPath', () => {
  // Doctor's "Binary found": the hub asks it about its own PATH, a computer about
  // the PATH its ptys get — one lookup, so the two can never answer differently.
  test.skipIf(isWin)('finds an executable on env.PATH, and nothing that is not there', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-find-on-path-'))
    try {
      const tool = path.join(dir, 'slz-tool')
      fs.writeFileSync(tool, '#!/bin/sh\n')
      fs.chmodSync(tool, 0o755)
      const env = { PATH: `${dir}:/usr/bin:/bin` }
      expect(await findOnPath('slz-tool', env)).toBe(tool)
      expect(await findOnPath('slz-tool-missing', env)).toBeNull()
      expect(await findOnPath('slz-tool', { PATH: '/usr/bin:/bin' }), 'not on THIS PATH').toBeNull()
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test.skipIf(isWin)('a name is a name, never shell syntax', async () => {
    expect(await findOnPath('sh; echo injected', { PATH: '/usr/bin:/bin' })).toBeNull()
  })
})
