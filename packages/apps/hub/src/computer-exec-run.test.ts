/**
 * An `exec.run` request lives as long as its command may: the command's own
 * `timeoutMs` (the computer ends it there) plus room for that kill and the reply.
 * Without it the gateway's 30 s default failed a 5-minute automation AI action at
 * 30 s — recorded as failed with no output while it kept running on the computer.
 */
import { expect, test } from 'vitest'
import { execRunOnComputer, EXEC_RUN_REPLY_GRACE_MS } from './computer-exec-run'

const ok = { stdout: 'done', stderr: '', status: 0, timedOut: false }

test("the request timeout is the command's own plus grace — never the gateway default", async () => {
  const calls: Array<{ method: string; timeoutMs: number | undefined }> = []
  const gateway = {
    request: async (_id: string, method: string, _params: unknown, timeoutMs?: number) => {
      calls.push({ method, timeoutMs })
      return ok
    }
  }
  const out = await execRunOnComputer(gateway, 'c1', { command: 'claude -p x', timeoutMs: 300_000 })
  expect(out).toEqual(ok)
  expect(calls).toEqual([{ method: 'exec.run', timeoutMs: 300_000 + EXEC_RUN_REPLY_GRACE_MS }])
  expect(EXEC_RUN_REPLY_GRACE_MS).toBeGreaterThan(2_000) // the computer's SIGKILL grace
})
