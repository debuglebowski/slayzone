/**
 * `findOnPath` answers from the filesystem, never from a process it has to start:
 * on a loaded machine a `/bin/sh -c 'command -v …'` probe ran past its timeout and
 * Doctor reported an installed binary as missing (`sh` → null in the computer suite).
 * Here every process start times out, as it did then.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'

vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>()
  const timedOut = (...args: unknown[]) => {
    const cb = args.find((a) => typeof a === 'function') as
      | ((err: Error, stdout: string, stderr: string) => void)
      | undefined
    const err = Object.assign(new Error('spawn timed out'), { killed: true, signal: 'SIGTERM' })
    setImmediate(() => cb?.(err, '', ''))
    return { kill: () => true, on: () => undefined } as never
  }
  return { ...real, execFile: timedOut, default: { ...real, execFile: timedOut } }
})

const { findOnPath } = await import('./login-shell-path')

describe.skipIf(process.platform === 'win32')(
  'findOnPath when no process can start in time',
  () => {
    test('still finds an executable on env.PATH, and nothing that is not there', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'slz-find-on-path-starved-'))
      try {
        const tool = path.join(dir, 'slz-tool')
        fs.writeFileSync(tool, '#!/bin/sh\n')
        fs.chmodSync(tool, 0o755)
        const notExecutable = path.join(dir, 'slz-data')
        fs.writeFileSync(notExecutable, 'data')
        const env = { PATH: `${dir}:/usr/bin:/bin` }
        expect(await findOnPath('slz-tool', env)).toBe(tool)
        expect(await findOnPath('sh', env)).toMatch(/\/sh$/)
        expect(await findOnPath('slz-data', env), 'not executable').toBeNull()
        expect(await findOnPath('slz-tool-missing', env)).toBeNull()
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })
  }
)
