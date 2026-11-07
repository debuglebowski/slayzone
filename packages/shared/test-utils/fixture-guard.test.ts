import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, expect, test } from 'vitest'

const rootDir = resolve(import.meta.dirname, '../../..')
const work = mkdtempSync(join(realpathSync(tmpdir()), 'fixture-guard-outer-'))
const outerPids: number[] = []
afterAll(() => {
  for (const pid of outerPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      /* gone */
    }
  }
  rmSync(work, { recursive: true, force: true })
})

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** The fixture file under the harness config, nested, in the given mode. */
async function runFixture(
  mode: 'leak' | 'clean'
): Promise<{ code: number | null; out: string; pids: number[] }> {
  const pidFile = join(work, `${mode}.pids`)
  writeFileSync(pidFile, '')
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FIXTURE_GUARD_MODE: mode,
    FIXTURE_GUARD_PIDS: pidFile
  }
  if (process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1'
  const result = await new Promise<{ code: number | null; out: string }>((done) => {
    const child = spawn(
      process.execPath,
      [
        join(rootDir, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        join(rootDir, 'packages/shared/test-utils/fixture-guard.fixture.config.ts')
      ],
      { cwd: rootDir, env, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let out = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (out += d))
    child.on('close', (code) => done({ code, out }))
  })
  const pids = readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number)
  outerPids.push(...pids)
  return { ...result, pids }
}

test('a file that leaves processes in its temp dirs fails, and they are reaped', async () => {
  const { code, out, pids } = await runFixture('leak')
  expect(pids, out).toHaveLength(2)
  expect(code, out).not.toBe(0)
  expect(out).toMatch(/left 2 processes running in its temp dirs/)
  for (const pid of pids) expect(out).toContain(`pid ${pid}`)
  for (const pid of pids) expect(alive(pid), `pid ${pid} reaped`).toBe(false)
})

test('a file that stops what it started passes', async () => {
  const { code, out, pids } = await runFixture('clean')
  expect(pids, out).toHaveLength(2)
  expect(code, out).toBe(0)
})
