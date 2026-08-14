import { spawn, execFileSync, type ChildProcess } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { test as base, expect, type Page } from '@playwright/test'
import { launchIsolatedElectron, bootConfigPath } from '../fixtures/electron'

/**
 * Wave 3 — computer-ON loopback end-to-end.
 *
 * Validates the WHOLE hub/computer chain over a real computer link, in-process:
 *   1. Boot a fully isolated app with boot-config `{ server_mode:'local' }`. A hub
 *      always accepts computers, so the sidecar comes up with the gateway + hub-auth
 *      + identity live, and binds the TLS `/computers` wss listener on its own port
 *      (separate https server from the shared http /trpc; see server.ts).
 *   2. Mint a real join token via the `computers.mintJoinToken` tRPC mutation
 *      (embeds the hub's bound `wss://…/computers` URL + cert fingerprint to pin).
 *   3. Spawn the bundled @slayzone/computer as a loopback child process, pointed
 *      at that token → it dials the hub, enrolls, and appears connected in
 *      `computers.list`.
 *   4. Bind a seeded task to that computerId (`setTaskComputer`), open a `terminal`
 *      PTY for it, and drive a command. The routing pty backend forwards the
 *      spawn → computer node-pty → `pty.data` → hub → renderer buffer, so the
 *      command's output streams back into `pty.getBuffer`.
 *
 * Two tests share this computer-ON boot:
 *   (b) MANUAL computer — mint a token via the tRPC proc, spawn the bundled computer
 *       DIRECTLY as a loopback child, assert enroll + a pty round-trips output.
 *       The deterministic full-loop baseline.
 *   (a) AUTO-ENROLL computer (Wave3.5-D3) — set `SLAYZONE_E2E_ALLOW_COMPUTER=1` so
 *       the in-app supervisor spawns the computer itself: main waits for the
 *       sidecar ready, mints a token over loopback REST (`POST
 *       /api/computers/join-token`), injects it + the wss url into the computer env,
 *       and the computer auto-enrolls with ZERO manual token/spawn. Asserts the
 *       local computer reaches "connected" in `computers.list`. (The full pty-exec
 *       round-trip stays on the manual test (b) — auto-enroll timing to a live
 *       pty is the flaky part; connected is the D3 contract.)
 *
 * Isolation: `launchIsolatedElectron` gives a throwaway userdata dir, and the
 * spec pins `SLAYZONE_ROOT` to it (via the fixture's extraEnv) so the computer
 * boot's identity/*.pem + hub-auth.sqlite land under the app's channel-scoped
 * hub root inside it, NOT the real dev store. The computer's credential store +
 * config also live under the temp dir.
 *
 * Uses the raw Playwright base (like 103): the shared worker fixture assumes a
 * plain non-computer server, which is exactly what this spec must boot without.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const APP_DIR = path.resolve(__dirname, '..', '..')
const COMPUTER_DIR = path.resolve(APP_DIR, '..', 'computer')
const COMPUTER_BIN = path.join(COMPUTER_DIR, 'dist', 'bin.cjs')

/** Build the computer bundle on demand — it is not part of the app build pipeline
 *  (see packages/apps/computer/build.mjs). Idempotent: skip when the bundle is
 *  present AND newer than every computer source file, else (re)build. */
function ensureComputerBuilt(): void {
  let needsBuild = !fs.existsSync(COMPUTER_BIN)
  if (!needsBuild) {
    const binMtime = fs.statSync(COMPUTER_BIN).mtimeMs
    const srcDir = path.join(COMPUTER_DIR, 'src')
    const newest = newestMtime(srcDir)
    if (newest > binMtime) needsBuild = true
  }
  if (!needsBuild) return
  execFileSync('node', ['build.mjs'], { cwd: COMPUTER_DIR, stdio: 'inherit' })
  if (!fs.existsSync(COMPUTER_BIN)) {
    throw new Error(`computer build did not produce ${COMPUTER_BIN}`)
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

interface SpawnedComputer {
  proc: ChildProcess
  logs: string[]
  stop: () => Promise<void>
}

/** Spawn the bundled computer as a loopback child, dialing `hubUrl` with `token`.
 *  node-pty (used by the pty handler) loads under plain node here — the repo's
 *  prebuilt binary is ABI-compatible with the e2e node runtime (verified). */
function spawnLoopbackComputer(opts: {
  hubUrl: string
  joinToken: string
  rootDir: string
  credentialsDir: string
  allowedRoots: string
}): SpawnedComputer {
  const electronPath = require('electron') as unknown as string
  const logs: string[] = []
  // The display name + FS path-jail now come from <ROOT>/computer.config.json (the
  // SLAYZONE_COMPUTER_NAME / SLAYZONE_COMPUTER_ALLOWED_ROOTS env channels are gone).
  // Write them before spawn so the STANDALONE computer reads them.
  fs.mkdirSync(opts.rootDir, { recursive: true })
  fs.writeFileSync(
    path.join(opts.rootDir, 'computer.config.json'),
    JSON.stringify({ computerName: 'e2e-loopback-computer', allowedRoots: [opts.allowedRoots] })
  )
  // ELECTRON_RUN_AS_NODE runs the Electron binary as plain Node so the computer's
  // node-pty native addon shares the app's ABI — mirrors how the app supervisor
  // spawns it (local-computer-supervisor.ts).
  const proc = spawn(electronPath, [COMPUTER_BIN], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // Standalone computer: clear any leaked SUPERVISED so loadComputerConfig reads
      // <ROOT>/computer.config.json (it skips the shared file when SUPERVISED=1).
      SLAYZONE_SUPERVISED: '',
      SLAYZONE_ROOT: opts.rootDir,
      // Authority only — the computer composes ws(s)://<addr>/computers from
      // SLAYZONE_MODE (local here → ws, matching the loopback hub).
      SLAYZONE_HUB_ADDRESS: new URL(opts.hubUrl).host,
      SLAYZONE_HUB_JOIN_TOKEN: opts.joinToken,
      SLAYZONE_COMPUTER_CREDENTIALS_DIR: opts.credentialsDir
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

/** All computers the hub currently knows about (store rows + live status). */
function listComputers(
  page: Page
): Promise<Array<{ id: string; name: string; connected: boolean }>> {
  return page.evaluate(
    () =>
      window.getTrpcVanillaClient().computers.list.query() as Promise<
        Array<{ id: string; name: string; connected: boolean }>
      >
  )
}

base.describe('Computer loopback (computer ON)', () => {
  base('computer enrolls over the computer link and runs a pty that streams back', async () => {
    base.setTimeout(180_000)
    ensureComputerBuilt()

    const launched = await launchIsolatedElectron({
      name: 'computer-loopback',
      seedUserData: (userDataDir) => {
        // Local mode — a hub always builds the gateway + binds the /computers
        // listener, so no flag is needed.
        fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
        fs.writeFileSync(
          bootConfigPath(userDataDir),
          JSON.stringify({ server_mode: 'local' }, null, 2)
        )
      },
      // Pin the sidecar store to the isolated dir (identity + hub-auth.sqlite land
      // here, NOT the real dev store).
      //
      // e2e is computer-ON by default, so the in-app supervisor ALSO auto-enrolls a
      // 'local-computer' here. Harmless: every assertion below resolves our own
      // computer BY NAME ('e2e-loopback-computer') and binds the task to that id
      // explicitly, so a second connected computer is never mistaken for ours.
      extraEnv: (userDataDir) => ({
        SLAYZONE_ROOT: userDataDir
      })
    })

    let computer: SpawnedComputer | null = null
    try {
      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })

      // The sidecar's computer init (createHubAuth migrations) + listener bind are
      // async and happen after boot. mintJoinToken throws until the listener has
      // fed its URL/fingerprint into the computers registry, so poll it.
      let minted: { token: string } | null = null
      await expect
        .poll(
          async () => {
            try {
              minted = await page.evaluate(
                () =>
                  window
                    .getTrpcVanillaClient()
                    .computers.mintJoinToken.mutate({ label: 'e2e-loopback' }) as Promise<{
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
      // `/computers` rides the ONE hub listener, demuxed by path, and its scheme
      // follows SLAYZONE_MODE: local (this test) → plaintext `ws://` loopback on the
      // hub's own port; only remote terminates TLS and mints `wss://` (from
      // SLAYZONE_HUB_PUBLIC_ADDRESS). The computer extracts this url from the token.
      expect(hubUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/computers$/)

      // Spawn the loopback computer against the freshly minted token. Its creds +
      // allowedRoots live under the isolated userdata dir (nothing leaks).
      const credentialsDir = path.join(launched.userDataDir, 'computer-creds')
      computer = spawnLoopbackComputer({
        hubUrl,
        joinToken: token,
        rootDir: path.join(launched.userDataDir, 'computer-root'),
        credentialsDir,
        allowedRoots: launched.userDataDir
      })

      // ── Enroll handshake: the computer appears connected in computers.list. ──
      let computerId: string | null = null
      await expect
        .poll(
          async () => {
            const rows = await listComputers(page)
            const mine = rows.find((r) => r.name === 'e2e-loopback-computer' && r.connected)
            computerId = mine?.id ?? null
            return computerId !== null
          },
          { timeout: 60_000, intervals: [500, 1_000, 2_000] }
        )
        .toBe(true)
      expect(computerId).not.toBeNull()

      // ── PTY exec over the computer link. ──
      // Seed a project + task, bind the task to the computer, then create a
      // `terminal` (raw shell) PTY. The routing pty backend resolves the task's
      // computerId and forwards the spawn to the computer; its node-pty output
      // streams back through the gateway into the session buffer.
      const projectPath = launched.userDataDir // an existing, readable dir
      const taskId = await page.evaluate(async (dir) => {
        const c = window.getTrpcVanillaClient()
        const project = await c.projects.create.mutate({
          name: 'Computer Loopback',
          color: '#22c55e',
          path: dir
        })
        const task = await c.task.create.mutate({
          projectId: project.id,
          title: 'Computer loopback task',
          status: 'in_progress'
        })
        return task.id as string
      }, projectPath)

      await page.evaluate(
        ({ tId, rId }) =>
          window.getTrpcVanillaClient().computers.setTaskComputer.mutate({
            taskId: tId,
            computerId: rId
          }),
        { tId: taskId, rId: computerId! }
      )
      // Sanity: the binding resolves to our computer (routing reads this per-spawn).
      const resolved = await page.evaluate(
        (tId) => window.getTrpcVanillaClient().computers.resolveTaskComputer.query({ taskId: tId }),
        taskId
      )
      expect(resolved.computerId).toBe(computerId)

      const sessionId = `${taskId}:${taskId}`
      const marker = `COMPUTER_OK_${Date.now()}`

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
      if (computer) await computer.stop()
      await launched.close()
    }
  })

  base('in-app supervisor auto-enrolls a local computer with zero manual token (D3)', async () => {
    base.setTimeout(180_000)
    ensureComputerBuilt()

    // The in-app supervisor (index.ts, runs in local mode — and under Playwright by
    // default now) waits for the sidecar ready, mints a join token over loopback
    // REST, and spawns + auto-enrolls the co-located computer — no manual mint/spawn
    // here. This test asserts that chain explicitly rather than relying on the
    // suite-wide default, which is why it still pins the flag below.
    const launched = await launchIsolatedElectron({
      name: 'computer-auto-enroll',
      seedUserData: (userDataDir) => {
        fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
        fs.writeFileSync(
          bootConfigPath(userDataDir),
          JSON.stringify({ server_mode: 'local' }, null, 2)
        )
      },
      extraEnv: (userDataDir) => ({
        SLAYZONE_ROOT: userDataDir,
        // Documents intent: this spec's subject IS the auto-enroll chain, so it
        // must not silently depend on the suite-wide computer-ON default. The boot
        // gate no longer reads this key (only SLAYZONE_E2E_NO_COMPUTER changes
        // behavior); it stays as a declaration of what the test requires.
        SLAYZONE_E2E_ALLOW_COMPUTER: '1',
        // The supervised computer self-derives its path-jail to `[homedir()]` (no
        // env channel). userDataDir lives under `.e2e-runtime` → under the repo →
        // under $HOME, so it is inside the jail and the PTY exec below passes.
        // The computer enrolls as DEFAULT_LOCAL_COMPUTER_NAME ('local-computer').
        SLAYZONE_COMPUTER_CREDENTIALS_DIR: path.join(userDataDir, 'auto-computer-creds')
      })
    })

    try {
      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })

      // The whole chain is automatic: sidecar ready → main mints over loopback
      // REST → computer spawns → dials wss → enrolls. Poll computers.list until the
      // auto-spawned computer reports connected. Generous budget: it waits on the
      // async computer init (createHubAuth migrations) + listener bind + a mint
      // retry cycle + the computer build/spawn/dial.
      let connectedComputerId: string | null = null
      await expect
        .poll(
          async () => {
            const rows = await listComputers(page)
            const mine = rows.find((r) => r.name === 'local-computer' && r.connected)
            connectedComputerId = mine?.id ?? null
            return connectedComputerId !== null
          },
          { timeout: 120_000, intervals: [1_000, 2_000, 3_000] }
        )
        .toBe(true)
      expect(connectedComputerId).not.toBeNull()
    } finally {
      await launched.close()
    }
  })

  base(
    'a hub always accepts computers: mintJoinToken works with no flag, no supervisor',
    async () => {
      base.setTimeout(120_000)

      // Boot with the supervisor explicitly OPTED OUT (`SLAYZONE_E2E_NO_COMPUTER=1`)
      // — e2e is otherwise computer-ON by default, which would auto-spawn a local
      // computer and invalidate the zero-connected assertion below. This proves the
      // always-on contract: the hub still builds the gateway + binds the /computers
      // listener at boot, so mintJoinToken succeeds and a computer COULD connect —
      // there just isn't one spawned in this test.
      const launched = await launchIsolatedElectron({
        name: 'computer-always-on',
        seedUserData: (userDataDir) => {
          fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
          fs.writeFileSync(
            bootConfigPath(userDataDir),
            JSON.stringify({ server_mode: 'local' }, null, 2)
          )
        },
        extraEnv: (userDataDir) => ({
          SLAYZONE_ROOT: userDataDir,
          SLAYZONE_E2E_NO_COMPUTER: '1'
        })
      })

      try {
        const page = launched.page
        await page.waitForSelector('#root', { timeout: 20_000 })

        // Supervisor opted out → no computer auto-spawns, so nothing is connected.
        await page.waitForTimeout(3_000)
        const rows = await listComputers(page)
        expect(rows.filter((r) => r.connected).length).toBe(0)

        // But the computer listener IS bound (always-on) → mintJoinToken succeeds and
        // returns a decodable szjt1 token embedding the wss computer URL. Poll: the
        // async computer init (createHubAuth migrations + listener bind) resolves
        // shortly after boot.
        await expect
          .poll(
            () =>
              page.evaluate(async () => {
                try {
                  const res = (await window
                    .getTrpcVanillaClient()
                    .computers.mintJoinToken.mutate({ label: 'always-on' })) as { token?: string }
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
    }
  )
})

/** True when `marker` appears in the buffer on a line that is not the `echo
 *  <marker>` command echo — i.e. the command's actual stdout came back over the
 *  computer link. */
function bufferHasCommandOutput(buffer: string, marker: string): boolean {
  const lines = buffer.split(/\r?\n/)
  return lines.some((line) => line.includes(marker) && !line.includes(`echo ${marker}`))
}
