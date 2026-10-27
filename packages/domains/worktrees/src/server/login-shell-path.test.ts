/**
 * The hub's own process spawns (the zero-computer fallback) under the bare PATH a
 * GUI-launched app inherits: they must find the user's tools through the login-shell
 * PATH, and `gh` output must not carry the interactive shell's startup noise.
 *
 * Run with: pnpm exec vitest run --config packages/apps/app/vitest.config.ts \
 *   packages/domains/worktrees/src/server/login-shell-path.test.ts
 */
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { setShellOverride } from '@slayzone/platform'
import { whichBinary } from '@slayzone/terminal/server'
import { execAsync } from './exec-async'
import { runGhLocally } from './gh-cli'

const isWin = process.platform === 'win32'
/** What macOS hands an app opened from the Dock/Finder (launchd's default). */
const BARE_GUI_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

let dir: string
/** A dir only the user's login shell puts on PATH — stands in for /opt/homebrew/bin. */
let shellOnlyBin: string
let savedPath: string | undefined

function script(path: string, lines: string[]): string {
  writeFileSync(path, ['#!/bin/sh', ...lines].join('\n') + '\n')
  chmodSync(path, 0o755)
  return path
}

// The probes are cached per process, so the whole file shares one setup.
beforeAll(() => {
  if (isWin) return
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'hub-login-path-')))
  shellOnlyBin = join(dir, 'brew-bin')
  mkdirSync(shellOnlyBin)
  script(join(shellOnlyBin, 'gh'), ['echo "{\\"args\\":\\"$*\\"}"'])
  script(join(shellOnlyBin, 'brew-tool'), ['echo brew-tool ran'])
  // The user's shell: noisy startup files (prompt theme, gitstatus) on stdout.
  setShellOverride(
    script(join(dir, 'zsh'), [
      'echo "gitstatus: initializing"',
      'while [ "$1" != "-c" ]; do shift; done',
      'shift',
      `PATH="${shellOnlyBin}:$PATH"`,
      'eval "$1"'
    ])
  )
  savedPath = process.env.PATH
  process.env.PATH = BARE_GUI_PATH
})
afterAll(() => {
  if (isWin) return
  process.env.PATH = savedPath
  setShellOverride(null)
  rmSync(dir, { recursive: true, force: true })
})

describe.skipIf(isWin)('hub spawns under the bare GUI PATH', () => {
  it('whichBinary answers with the path, not shell startup noise', async () => {
    expect(await whichBinary('gh')).toBe(join(shellOnlyBin, 'gh'))
  })

  it('execAsync finds a tool only the login shell puts on PATH', async () => {
    const result = await execAsync('brew-tool', [], { cwd: dir })
    expect(result).toMatchObject({ status: 0, stdout: 'brew-tool ran\n' })
  })

  it('runGhLocally returns gh stdout untouched by the interactive shell', async () => {
    const result = await runGhLocally(['pr', 'list', '--json', 'number'], { cwd: dir })
    expect(result.status).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ args: 'pr list --json number' })
  })
})
