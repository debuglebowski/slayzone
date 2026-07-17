import { spawn, execFileSync, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { test as base, expect, type Page } from '@playwright/test'
import { launchIsolatedElectron } from '../fixtures/electron'

/**
 * Wave 3 — runner-ON loopback end-to-end.
 *
 * Validates the WHOLE hub/runner chain over a real runner link, in-process:
 *   1. Boot a fully isolated app with boot-config `{ server_mode:'local' }`. A hub
 *      always accepts runners, so the sidecar comes up with the gateway + hub-auth
 *      + identity live, and binds the TLS `/runners` wss listener on its own port
 *      (separate https server from the shared http /trpc; see server.ts).
 *   2. Mint a real join token via the `runners.mintJoinToken` tRPC mutation
 *      (embeds the hub's bound `wss://…/runners` URL + cert fingerprint to pin).
 *   3. Spawn the bundled @slayzone/runner as a loopback child process, pointed
 *      at that token → it dials the hub, enrolls, and appears connected in
 *      `runners.list`.
 *   4. Bind a seeded task to that runnerId (`setTaskRunner`), open a `terminal`
 *      PTY for it, and drive a command. The routing pty backend forwards the
 *      spawn → runner node-pty → `pty.data` → hub → renderer buffer, so the
 *      command's output streams back into `pty.getBuffer`.
 *
 * Two tests share this runner-ON boot:
 *   (b) MANUAL runner — mint a token via the tRPC proc, spawn the bundled runner
 *       DIRECTLY as a loopback child, assert enroll + a pty round-trips output.
 *       The deterministic full-loop baseline.
 *   (a) AUTO-ENROLL runner (Wave3.5-D3) — set `SLAYZONE_E2E_ALLOW_RUNNER=1` so
 *       the in-app supervisor spawns the runner itself: main waits for the
 *       sidecar ready, mints a token over loopback REST (`POST
 *       /api/runners/join-token`), injects it + the wss url into the runner env,
 *       and the runner auto-enrolls with ZERO manual token/spawn. Asserts the
 *       local runner reaches "connected" in `runners.list`. (The full pty-exec
 *       round-trip stays on the manual test (b) — auto-enroll timing to a live
 *       pty is the flaky part; connected is the D3 contract.)
 *
 * Isolation: `launchIsolatedElectron` gives a throwaway userdata dir, and the
 * spec pins `SLAYZONE_STORE_DIR` to it (via the fixture's extraEnv) so the
 * runner boot's identity/*.pem + hub-auth.sqlite land there, NOT the real dev
 * store. The runner's credential store + config also live under the temp dir.
 *
 * Uses the raw Playwright base (like 103): the shared worker fixture assumes a
 * plain non-runner server, which is exactly what this spec must boot without.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const APP_DIR = path.resolve(__dirname, '..', '..')
const RUNNER_DIR = path.resolve(APP_DIR, '..', 'runner')
const RUNNER_BIN = path.join(RUNNER_DIR, 'dist', 'bin.cjs')

/** Build the runner bundle on demand — it is not part of the app build pipeline
 *  (see packages/apps/runner/build.mjs). Idempotent: skip when the bundle is
 *  present AND newer than every runner source file, else (re)build. */
function ensureRunnerBuilt(): void {
  let needsBuild = !fs.existsSync(RUNNER_BIN)
  if (!needsBuild) {
    const binMtime = fs.statSync(RUNNER_BIN).mtimeMs
    const srcDir = path.join(RUNNER_DIR, 'src')
    const newest = newestMtime(srcDir)
    if (newest > binMtime) needsBuild = true
  }
  if (!needsBuild) return
  execFileSync('node', ['build.mjs'], { cwd: RUNNER_DIR, stdio: 'inherit' })
  if (!fs.existsSync(RUNNER_BIN)) {
    throw new Error(`runner build did not produce ${RUNNER_BIN}`)
  }
}

function newestMtime(dir: string): number {
  let newest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      newest = Math.max(newest, newestMtime(full))
    } else {
      newest = Math.max(newest, fs.statSync(full).mtimeMs)
    }
  }
  return newest
}

/** Minimal shape of the token embedded by mintJoinToken (szjt1.<b64url(json)>). */
function decodeHubUrl(token: string): string {
  const body = token.slice(token.indexOf('.') + 1)
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as {
    hubUrl: string
  }
  return payload.hubUrl
}

interface SpawnedRunner {
  proc: ChildProcess
  logs: string[]
  stop: () => Promise<void>
}

/** Spawn the bundled runner as a loopback child, dialing `hubUrl` with `token`.
 *  node-pty (used by the pty handler) loads under plain node here — the repo's
 *  prebuilt binary is ABI-compatible with the e2e node runtime (verified). */
function spawnLoopbackRunner(opts: {
  hubUrl: string
  joinToken: string
  credentialsDir: string
  allowedRoots: string
}): SpawnedRunner {
  const electronPath = require('electron') as unknown as string
  const logs: string[] = []
  // ELECTRON_RUN_AS_NODE runs the Electron binary as plain Node so the runner's
  // node-pty native addon shares the app's ABI — mirrors how the app supervisor
  // spawns it (local-runner-supervisor.ts).
  const proc = spawn(electronPath, [RUNNER_BIN], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      SLAYZONE_HUB_URL: opts.hubUrl,
      SLAYZONE_JOIN_TOKEN: opts.joinToken,
      SLAYZONE_RUNNER_NAME: 'e2e-loopback-runner',
      SLAYZONE_RUNNER_CREDENTIALS_DIR: opts.credentialsDir,
      SLAYZONE_RUNNER_ALLOWED_ROOTS: opts.allowedRoots
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const capture = (chunk: Buffer): void => {
    for (const line of chunk.toString().split('\n')) {
      if (line.trim()) logs.push(line)
    }
  }
  proc.stdout?.on('data', capture)
  proc.stderr?.on('data', capture)

  return {
    proc,
    logs,
    stop: async () => {
      if (proc.exitCode !== null || proc.signalCode !== null) return
      await new Promise<void>((resolve) => {
        const killTimer = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }, 3_000)
        proc.once('exit', () => {
          clearTimeout(killTimer)
          resolve()
        })
        try {
          proc.kill('SIGTERM')
        } catch {
          clearTimeout(killTimer)
          resolve()
        }
      })
    }
  }
}

/** All runners the hub currently knows about (store rows + live status). */
function listRunners(page: Page): Promise<
  Array<{ id: string; name: string; connected: boolean }>
> {
  return page.evaluate(
    () =>
      window.getTrpcVanillaClient().runners.list.query() as Promise<
        Array<{ id: string; name: string; connected: boolean }>
      >
  )
}

base.describe('Runner loopback (runner ON)', () => {
  base('runner enrolls over the runner link and runs a pty that streams back', async () => {
    base.setTimeout(180_000)
    ensureRunnerBuilt()

    const launched = await launchIsolatedElectron({
      name: 'runner-loopback',
      seedUserData: (userDataDir) => {
        // Local mode — a hub always builds the gateway + binds the /runners
        // listener, so no flag is needed.
        fs.writeFileSync(
          path.join(userDataDir, 'boot-config.json'),
          JSON.stringify({ server_mode: 'local' }, null, 2)
        )
      },
      // Pin the sidecar store to the isolated dir (identity + hub-auth.sqlite land
      // here, NOT the real dev store). We do NOT set SLAYZONE_E2E_ALLOW_RUNNER in
      // THIS test (the auto-enroll test below does) — here the assertions ride our
      // explicitly-spawned loopback runner whose token we mint post-bind.
      extraEnv: (userDataDir) => ({
        SLAYZONE_STORE_DIR: userDataDir
      })
    })

    let runner: SpawnedRunner | null = null
    try {
      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })

      // The sidecar's runner init (createHubAuth migrations) + listener bind are
      // async and happen after boot. mintJoinToken throws until the listener has
      // fed its URL/fingerprint into the runners registry, so poll it.
      let minted: { token: string } | null = null
      await expect
        .poll(
          async () => {
            try {
              minted = await page.evaluate(
                () =>
                  window
                    .getTrpcVanillaClient()
                    .runners.mintJoinToken.mutate({ label: 'e2e-loopback' }) as Promise<{
                    token: string
                  }>
              )
              return true
            } catch {
              return false
            }
          },
          { timeout: 60_000, intervals: [500, 1_000, 2_000] }
        )
        .toBe(true)
      expect(minted).not.toBeNull()
      const token = minted!.token
      const hubUrl = decodeHubUrl(token)
      // Wave3.5-D2: `/runners` is now a TLS-terminated wss listener on its own port
      // (separate from the shared http /trpc server). The runner extracts the pin
      // + this url from the token and dials wss with cert-pinning.
      expect(hubUrl).toMatch(/^wss:\/\/127\.0\.0\.1:\d+\/runners$/)

      // Spawn the loopback runner against the freshly minted token. Its creds +
      // allowedRoots live under the isolated userdata dir (nothing leaks).
      const credentialsDir = path.join(launched.userDataDir, 'runner-creds')
      runner = spawnLoopbackRunner({
        hubUrl,
        joinToken: token,
        credentialsDir,
        allowedRoots: launched.userDataDir
      })

      // ── Enroll handshake: the runner appears connected in runners.list. ──
      let runnerId: string | null = null
      await expect
        .poll(
          async () => {
            const rows = await listRunners(page)
            const mine = rows.find((r) => r.name === 'e2e-loopback-runner' && r.connected)
            runnerId = mine?.id ?? null
            return runnerId !== null
          },
          { timeout: 60_000, intervals: [500, 1_000, 2_000] }
        )
        .toBe(true)
      expect(runnerId).not.toBeNull()

      // ── PTY exec over the runner link. ──
      // Seed a project + task, bind the task to the runner, then create a
      // `terminal` (raw shell) PTY. The routing pty backend resolves the task's
      // runnerId and forwards the spawn to the runner; its node-pty output
      // streams back through the gateway into the session buffer.
      const projectPath = launched.userDataDir // an existing, readable dir
      const taskId = await page.evaluate(async (dir) => {
        const c = window.getTrpcVanillaClient()
        const project = await c.projects.create.mutate({
          name: 'Runner Loopback',
          color: '#22c55e',
          path: dir
        })
        const task = await c.task.create.mutate({
          projectId: project.id,
          title: 'Runner loopback task',
          status: 'in_progress'
        })
        return task.id as string
      }, projectPath)

      await page.evaluate(
        ({ tId, rId }) =>
          window.getTrpcVanillaClient().runners.setTaskRunner.mutate({
            taskId: tId,
            runnerId: rId
          }),
        { tId: taskId, rId: runnerId! }
      )
      // Sanity: the binding resolves to our runner (routing reads this per-spawn).
      const resolved = await page.evaluate(
        (tId) => window.getTrpcVanillaClient().runners.resolveTaskRunner.query({ taskId: tId }),
        taskId
      )
      expect(resolved.runnerId).toBe(runnerId)

      const sessionId = `${taskId}:${taskId}`
      const marker = `RUNNER_OK_${Date.now()}`

      // Create the PTY (terminal mode = raw shell) bound to this task.
      await page.evaluate(
        ({ sId, dir }) =>
          window.getTrpcVanillaClient().pty.create.mutate({
            sessionId: sId,
            cwd: dir,
            mode: 'terminal'
          }),
        { sId: sessionId, dir: projectPath }
      )

      // PTY exists (the remote spawn registered a session on the hub side).
      await expect
        .poll(
          () =>
            page.evaluate(
              (sId) => window.getTrpcVanillaClient().pty.exists.query({ sessionId: sId }),
              sessionId
            ),
          { timeout: 30_000, intervals: [500, 1_000] }
        )
        .toBe(true)

      // Drive a command and assert its output streams back into the buffer.
      // Retry the write: the remote pty.spawn reply (pid) and the shell's first
      // prompt can lag the local session registration, and an early write can be
      // dropped by the shell before its line discipline is ready.
      await expect
        .poll(
          async () => {
            await page.evaluate(
              ({ sId, cmd }) =>
                window
                  .getTrpcVanillaClient()
                  .pty.write.mutate({ sessionId: sId, data: `echo ${cmd}\r` }),
              { sId: sessionId, cmd: marker }
            )
            const buffer = await page.evaluate(
              (sId) => window.getTrpcVanillaClient().pty.getBuffer.query({ sessionId: sId }),
              sessionId
            )
            // The echoed COMMAND line always contains the literal `echo <marker>`;
            // require the marker to appear on a line that is NOT the `echo …`
            // command echo, i.e. the command's OUTPUT — proof of round-trip exec.
            return bufferHasCommandOutput(buffer ?? '', marker)
          },
          { timeout: 45_000, intervals: [1_000, 1_500, 2_000] }
        )
        .toBe(true)
    } finally {
      if (runner) await runner.stop()
      await launched.close()
    }
  })

  base('in-app supervisor auto-enrolls a local runner with zero manual token (D3)', async () => {
    base.setTimeout(180_000)
    ensureRunnerBuilt()

    // The in-app supervisor (index.ts, runs in local mode + SLAYZONE_E2E_ALLOW_RUNNER
    // under Playwright) waits for the sidecar ready, mints a join token over
    // loopback REST, and spawns + auto-enrolls the co-located runner — no manual
    // mint/spawn here.
    const launched = await launchIsolatedElectron({
      name: 'runner-auto-enroll',
      seedUserData: (userDataDir) => {
        fs.writeFileSync(
          path.join(userDataDir, 'boot-config.json'),
          JSON.stringify({ server_mode: 'local' }, null, 2)
        )
      },
      extraEnv: (userDataDir) => ({
        SLAYZONE_STORE_DIR: userDataDir,
        // Opt the runner supervisor back in despite PLAYWRIGHT (default skips it).
        SLAYZONE_E2E_ALLOW_RUNNER: '1',
        // Keep the auto-spawned runner's node-pty ABI matching + roots/creds
        // confined to the isolated dir (main defaults roots to $HOME otherwise).
        SLAYZONE_RUNNER_NAME: 'auto-enroll-runner',
        SLAYZONE_RUNNER_ALLOWED_ROOTS: userDataDir,
        SLAYZONE_RUNNER_CREDENTIALS_DIR: path.join(userDataDir, 'auto-runner-creds')
      })
    })

    try {
      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })

      // The whole chain is automatic: sidecar ready → main mints over loopback
      // REST → runner spawns → dials wss → enrolls. Poll runners.list until the
      // auto-spawned runner reports connected. Generous budget: it waits on the
      // async runner init (createHubAuth migrations) + listener bind + a mint
      // retry cycle + the runner build/spawn/dial.
      let connectedRunnerId: string | null = null
      await expect
        .poll(
          async () => {
            const rows = await listRunners(page)
            const mine = rows.find((r) => r.name === 'auto-enroll-runner' && r.connected)
            connectedRunnerId = mine?.id ?? null
            return connectedRunnerId !== null
          },
          { timeout: 120_000, intervals: [1_000, 2_000, 3_000] }
        )
        .toBe(true)
      expect(connectedRunnerId).not.toBeNull()
    } finally {
      await launched.close()
    }
  })

  base('a hub always accepts runners: mintJoinToken works with no flag, no supervisor', async () => {
    base.setTimeout(120_000)

    // DEFAULT boot: just `server_mode: local`, no runner flag, and (deliberately)
    // NO SLAYZONE_E2E_ALLOW_RUNNER — so the in-app supervisor does NOT auto-spawn a
    // local runner. This proves the always-on contract: the hub still builds the
    // gateway + binds the /runners listener at boot, so mintJoinToken succeeds and
    // a runner COULD connect — there just isn't one spawned in this test.
    const launched = await launchIsolatedElectron({
      name: 'runner-always-on',
      seedUserData: (userDataDir) => {
        fs.writeFileSync(
          path.join(userDataDir, 'boot-config.json'),
          JSON.stringify({ server_mode: 'local' }, null, 2)
        )
      },
      extraEnv: (userDataDir) => ({
        SLAYZONE_STORE_DIR: userDataDir
      })
    })

    try {
      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })

      // No supervisor opt-in → no runner auto-spawns, so nothing is connected.
      await page.waitForTimeout(3_000)
      const rows = await listRunners(page)
      expect(rows.filter((r) => r.connected).length).toBe(0)

      // But the runner listener IS bound (always-on) → mintJoinToken succeeds and
      // returns a decodable szjt1 token embedding the wss runner URL. Poll: the
      // async runner init (createHubAuth migrations + listener bind) resolves
      // shortly after boot.
      await expect
        .poll(
          () =>
            page.evaluate(async () => {
              try {
                const res = (await window
                  .getTrpcVanillaClient()
                  .runners.mintJoinToken.mutate({ label: 'always-on' })) as { token?: string }
                return typeof res.token === 'string' && res.token.startsWith('szjt1.')
              } catch {
                return false
              }
            }),
          { timeout: 60_000, intervals: [1_000, 2_000] }
        )
        .toBe(true)
    } finally {
      await launched.close()
    }
  })
})

/** True when `marker` appears in the buffer on a line that is not the `echo
 *  <marker>` command echo — i.e. the command's actual stdout came back over the
 *  runner link. */
function bufferHasCommandOutput(buffer: string, marker: string): boolean {
  const lines = buffer.split(/\r?\n/)
  return lines.some((line) => line.includes(marker) && !line.includes(`echo ${marker}`))
}
