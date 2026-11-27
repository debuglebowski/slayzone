/**
 * A local chat start reads the user's login-shell PATH without freezing the event
 * loop. Own file: the PATH probe is cached per module, so it must run here first.
 *
 * The probe used to be `execFileSync`: a slow shell init (1.4 s measured under load)
 * stalled every other request, ws heartbeat and pty of the process running it —
 * on a computer, long enough for its hub connection to drop.
 */
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SpawnOptions } from 'node:child_process'
import { afterEach, expect, test } from 'vitest'
import { setShellOverride } from '@slayzone/platform'
import { createChatOps } from './chat-handlers'
import { createDbChatDataOps } from './chat-data-ops'
import { createFakeTaskSessionStore } from './fake-task-session-store'
import * as mgr from './chat-transport-manager'
import { fakeChild } from './chat-transport-testkit'
import {
  createSlayzoneDbAdapter,
  createTestHarness
} from '../../../../../shared/test-utils/ipc-harness.js'

const dir = mkdtempSync(join(tmpdir(), 'chat-login-path-'))
afterEach(() => {
  setShellOverride(null)
  mgr.__resetForTests()
  mgr.resetTransportDeps()
  rmSync(dir, { recursive: true, force: true })
})

test.skipIf(process.platform === 'win32')(
  'a cold local chat start probes the login-shell PATH asynchronously',
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
    const opener = setInterval(() => {
      if (existsSync(started)) writeFileSync(gate, '')
    }, 5)

    const { db } = await createTestHarness()
    db.prepare("INSERT INTO projects (id, name, color) VALUES ('proj-1', 'P', '#000')").run()
    db.prepare(
      "INSERT INTO tasks (id, project_id, title) VALUES ('task-path', 'proj-1', 'T')"
    ).run()
    db.prepare(
      "INSERT INTO terminal_tabs (id, task_id, mode, position) VALUES ('tab-path', 'task-path', 'claude-chat', 0)"
    ).run()
    const spawns: SpawnOptions[] = []
    mgr.__resetForTests()
    mgr.resetTransportDeps()
    mgr.setTransportDepsForTests({
      whichBinary: async () => '/fake/claude',
      spawn: (_cmd, _args, opts) => {
        spawns.push(opts)
        const f = fakeChild()
        // Like a real child: `spawn` fires once the OS started it (a later tick).
        setImmediate(() => f.emitter.emit('spawn'))
        return f.child
      },
      broadcastEvent: () => {},
      broadcastExit: () => {},
      broadcastStateChange: () => {}
    })
    const ops = createChatOps({
      dataOps: createDbChatDataOps(createSlayzoneDbAdapter(db), createFakeTaskSessionStore())
    })
    try {
      await ops.start({
        tabId: 'tab-path',
        taskId: 'task-path',
        mode: 'claude-chat',
        cwd: dir,
        providerFlagsOverride: null
      })
    } finally {
      clearInterval(opener)
    }
    expect(spawns).toHaveLength(1)
    expect(String(spawns[0].env?.PATH).split(':')).toContain('/probe/bin')
  }
)
