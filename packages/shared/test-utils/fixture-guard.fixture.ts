/**
 * Run ONLY by fixture-guard.test.ts, as a nested harness vitest (not a *.test.ts, so no
 * runner collects it on its own). FIXTURE_GUARD_MODE picks what the file leaves behind:
 *
 *   leak  — a detached process rooted in a dir from `mkdtempSync` (named import), and
 *           one rooted in a dir from `fs.promises.mkdtemp`, both left running;
 *   clean — the same processes, stopped and their dirs removed by the file itself.
 *
 * Each process writes its pid to FIXTURE_GUARD_PIDS so the outer test can check them.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, mkdtempSync, promises as fsp, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'

const mode = process.env.FIXTURE_GUARD_MODE
const started: Array<{ pid: number; dir: string }> = []

function startIn(dir: string): void {
  const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', join(dir, 'x.cjs')], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    detached: true,
    stdio: 'ignore'
  })
  child.unref()
  started.push({ pid: child.pid!, dir })
  appendFileSync(process.env.FIXTURE_GUARD_PIDS!, `${child.pid}\n`)
}

afterAll(() => {
  if (mode !== 'clean') return
  for (const { pid, dir } of started) {
    process.kill(pid, 'SIGKILL')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('starts processes rooted in its temp dirs', async () => {
  startIn(mkdtempSync(join(tmpdir(), 'fixture-guard-sync-')))
  startIn(await fsp.mkdtemp(join(tmpdir(), 'fixture-guard-async-')))
  expect(started).toHaveLength(2)
})
