/**
 * The hub reads its credentials key ONCE, before anything spawns, and keeps it out of
 * its own environment (review M1): every process the hub starts — git and its hooks,
 * a repo's setup script, a terminal, an agent — inherits `process.env`.
 */
import { spawnSync } from 'node:child_process'
import { closeSync, openSync, writeFileSync } from 'node:fs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { readCredentialsSecretInput, watchCredentialsUpdates } from './credentials-secret-input.js'
import { execFileSync, spawn } from 'node:child_process'

const SECRET = 'an-operator-credentials-secret-0123456789abcdef'
const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('readCredentialsSecretInput', () => {
  test('from the desktop pipe: current + previous keys; the fd var is removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slz-cred-fd-'))
    dirs.push(dir)
    const file = join(dir, 'payload')
    writeFileSync(file, JSON.stringify({ current: 'c'.repeat(43), previous: ['p'.repeat(43)] }))
    const fd = openSync(file, 'r')
    const env: NodeJS.ProcessEnv = { SLAYZONE_HUB_CREDENTIALS_FD: String(fd) }
    expect(readCredentialsSecretInput(env)).toEqual({
      secret: 'c'.repeat(43),
      previous: ['p'.repeat(43)],
      source: 'pipe'
    })
    expect(env.SLAYZONE_HUB_CREDENTIALS_FD).toBeUndefined()
    expect(() => closeSync(fd), 'the fd was closed after reading').toThrow()
  })

  test("from an operator's env: read, then removed, so no child process inherits it", () => {
    const env = { ...process.env, SLAYZONE_HUB_CREDENTIALS_SECRET: SECRET }
    expect(readCredentialsSecretInput(env)).toEqual({ secret: SECRET, previous: [], source: 'env' })
    expect(env.SLAYZONE_HUB_CREDENTIALS_SECRET).toBeUndefined()
    // What git, a hook or a setup script spawned with the hub's env would see.
    const child = spawnSync('/usr/bin/env', [], { env, encoding: 'utf8' })
    expect(child.stdout).not.toContain(SECRET)
  })

  test('a pipe the desktop could not fill (no key this session): null, still removed', () => {
    const dir = mkdtempSync(join(tmpdir(), 'slz-cred-fd-'))
    dirs.push(dir)
    const file = join(dir, 'payload')
    writeFileSync(file, '')
    const fd = openSync(file, 'r')
    const env: NodeJS.ProcessEnv = { SLAYZONE_HUB_CREDENTIALS_FD: String(fd) }
    expect(readCredentialsSecretInput(env)).toEqual({ secret: null, previous: [], source: 'pipe' })
  })

  test('nothing given: none', () => {
    expect(readCredentialsSecretInput({})).toEqual({ secret: null, previous: [], source: 'none' })
  })

  test.skipIf(process.platform === 'win32')(
    'L4: a key sent later on the still-open pipe reaches the running hub',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'slz-cred-fifo-'))
      dirs.push(dir)
      const fifo = join(dir, 'pipe')
      execFileSync('mkfifo', [fifo])
      const first = JSON.stringify({ current: null, previous: [] })
      const later = JSON.stringify({ current: 'L'.repeat(43), previous: ['o'.repeat(43)] })
      // One writer keeps the pipe open: the first line now, the key a little later.
      const writer = spawn('sh', [
        '-c',
        `{ printf '%s\\n' '${first}'; sleep 0.3; printf '%s\\n' '${later}'; sleep 1; } > "$1"`,
        'sh',
        fifo
      ])
      const fd = openSync(fifo, 'r')
      const env: NodeJS.ProcessEnv = { SLAYZONE_HUB_CREDENTIALS_FD: String(fd) }
      expect(readCredentialsSecretInput(env, { keepOpen: true })).toEqual({
        secret: null,
        previous: [],
        source: 'pipe'
      })
      const got = await new Promise((resolve) => {
        const stop = watchCredentialsUpdates((input) => {
          stop()
          resolve(input)
        })
      })
      expect(got).toEqual({ secret: 'L'.repeat(43), previous: ['o'.repeat(43)], source: 'pipe' })
      writer.kill()
    }
  )
})
