/**
 * The hub's first git spawn reads the user's login-shell PATH without freezing the
 * event loop. Own file: the PATH probe is cached per module, so it must run here first.
 *
 * The probe used to be `execFileSync` on the first spawn: a slow shell init stalled
 * every other request, ws heartbeat and pty of the hub for as long as the shell took.
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, expect, test } from 'vitest'
import { setShellOverride } from '@slayzone/platform'
import { configureGitExec, execAsync } from './exec-async'

const dir = mkdtempSync(join(tmpdir(), 'git-login-path-'))
afterAll(() => {
  setShellOverride(null)
  configureGitExec(null)
  rmSync(dir, { recursive: true, force: true })
})

test.skipIf(process.platform === 'win32')(
  'a cold hub spawn probes the login-shell PATH asynchronously and gives the child its PATH',
  async () => {
    // A shell whose PATH answer waits for a gate only this process's event loop opens:
    // a blocking probe never sees it and gives up (no PATH), a non-blocking one does.
    const gate = join(dir, 'gate')
    const started = join(dir, 'started')
    const shell = join(dir, 'fake-shell')
    writeFileSync(
      shell,
      `#!/bin/sh\n: > '${started}'\ni=0\nwhile [ ! -e '${gate}' ]; do\n  i=$((i+1)); [ $i -gt 30 ] && exit 1\n  sleep 0.01\ndone\nprintf '\\n__SLAYZONE_PATH__/probe/bin\\n'\n`,
      { mode: 0o755 }
    )
    setShellOverride(shell)
    // The hub's own PATH source (the login shell); only the refusal is stubbed.
    configureGitExec({ refuse: () => {} })
    const opener = setInterval(() => {
      if (existsSync(started)) writeFileSync(gate, '')
    }, 5)
    try {
      const result = await execAsync('/bin/sh', ['-c', 'printf %s "$PATH"'])
      expect(result.status).toBe(0)
      expect(result.stdout.split(':')).toContain('/probe/bin')
    } finally {
      clearInterval(opener)
    }
  }
)
