/**
 * Side-car supervisor parent-death tests against the REAL built hub (rebuilt on
 * demand) under a fake app: a supervised hub never outlives its app — not when the
 * app is SIGKILLed, not when it quits without waiting, not when a client connection
 * keeps the hub's stop from finishing, not when its stdin is held open elsewhere —
 * while a standalone hub ignores its parent entirely; and the real built side-car
 * self-exits when its stdin closes.
 *
 * Split from sidecar-server-supervisor.test.ts (the supervisor against a fake
 * side-car) so these real deadlines run on their own worker.
 */
import { afterAll, expect, test } from 'vitest'
import { spawn } from 'node:child_process'
import { HUB_PROCESS_ENV } from '@slayzone/platform/hub-switches'
import {
  assertStoppedByItsDeadline,
  cleanupTmpDirs,
  delay,
  ensureHubBuilt,
  HUB_BIN,
  mkTmp,
  pidGone,
  REAL_EXIT_BUDGET_MS,
  startRealHub,
  waitFor,
  waitForExit,
  waitForRun
} from './sidecar-server-supervisor-harness.js'

afterAll(cleanupTmpDirs)

test('parent-death: a SIGKILLed app takes its supervised hub with it, cleanly', async () => {
  const run = await startRealHub({ parent: 'supervisor', supervised: true })
  try {
    // No false positive while the app lives: longer than one parent poll.
    await delay(1_500)
    expect(pidGone(run.hubPid), 'the hub runs while its app is alive').toBe(false)
    run.parent.kill('SIGKILL')
    await waitForRun(
      run,
      () => pidGone(run.hubPid),
      REAL_EXIT_BUDGET_MS,
      'hub outlived its SIGKILLed app'
    )
    // 0, not 1: a clean stop, not a crash on the first write to the dead app's
    // stdout pipe (nor a forced exit).
    expect(run.exitCode(), `the hub stopped cleanly — log:\n${run.log()}`).toBe('0')
    expect(run.log(), `the hub said why it stopped — log:\n${run.log()}`).toMatch(
      /shutting down \(parent-(pipe-closed|output-closed|reparented|exited)\)/
    )
  } finally {
    run.cleanup()
  }
})

test('parent-death: a SIGKILLed app cannot orphan a hub whose stop hangs on a client', async () => {
  // A client the app's death does not end (a `slay` subscription, a web-shell tab)
  // keeps the hub's HTTP server — and so its stop — from ever finishing. Nothing
  // is left to SIGKILL it: it must end itself.
  const run = await startRealHub({ parent: 'supervisor', supervised: true })
  try {
    await run.holdConnection()
    run.parent.kill('SIGKILL')
    await waitForRun(
      run,
      () => pidGone(run.hubPid),
      REAL_EXIT_BUDGET_MS,
      'a stuck hub outlived its SIGKILLed app'
    )
    assertStoppedByItsDeadline(run)
  } finally {
    run.cleanup()
  }
})

test('parent-death: an app that quits without waiting cannot orphan a hub whose stop hangs', async () => {
  // The reported orphan, end to end: the app SIGTERMs its hub and exits before the
  // supervisor's SIGKILL escalation; a held client keeps the hub's stop from finishing.
  const run = await startRealHub({ parent: 'supervisor', supervised: true, quit: 'forget' })
  try {
    await run.holdConnection()
    run.parent.kill('SIGTERM')
    await waitForRun(
      run,
      () => run.log().includes('shutting down (SIGTERM)'),
      10_000,
      "the hub never got the app's SIGTERM"
    )
    await waitForRun(
      run,
      () => pidGone(run.hubPid),
      REAL_EXIT_BUDGET_MS,
      'a stuck hub outlived the app that quit on it'
    )
    assertStoppedByItsDeadline(run)
  } finally {
    run.cleanup()
  }
})

test('parent-death: a SIGKILLed app is noticed even when stdin is held open elsewhere', async () => {
  // Only the ppid/liveness poll can see this one: the stdin pipe outlives the app.
  const run = await startRealHub({ parent: 'stdin-held-elsewhere', supervised: true })
  try {
    run.parent.kill('SIGKILL')
    await waitForRun(
      run,
      () => pidGone(run.hubPid),
      REAL_EXIT_BUDGET_MS,
      'hub outlived its app with stdin still open'
    )
    expect(run.log(), `the parent poll noticed — log:\n${run.log()}`).toMatch(
      /shutting down \(parent-(reparented|exited)\)/
    )
  } finally {
    run.cleanup()
  }
})

test('parent-death: a standalone hub ignores its parent dying', async () => {
  // `slay hub`, a launchd/systemd unit, a server: no app owns it, and a closed stdin
  // or a reparent means nothing. It must keep serving.
  const run = await startRealHub({ parent: 'standalone', supervised: false })
  try {
    run.parent.kill('SIGKILL')
    await delay(4_000) // several parent polls (1s each)
    expect(pidGone(run.hubPid), `a standalone hub stopped — log:\n${run.log()}`).toBe(false)
    expect(run.log(), 'it never watched its parent').not.toContain('shutting down')
  } finally {
    run.cleanup()
  }
})

test('parent-death: the real built side-car self-exits when stdin closes', async () => {
  ensureHubBuilt()
  const binJs = HUB_BIN
  const dir = mkTmp()
  // Single ROOT for BOTH the seeder and the supervised child: the DB path is
  // DERIVED (`<ROOT>/storage/slayzone.data.sqlite`) and there is no path-pointing env
  // var to hand over, so both processes must point at the SAME ROOT to open the
  // same file.
  //
  // Migrate the DB before the supervised spawn. This seeding is now belt-and-
  // braces: `openServerDatabase()` bootstraps the schema in EVERY mode, so a
  // supervised child migrates itself. It is kept because this test spawns the
  // BUILT bin, which may predate that change, and because an unmigrated DB would
  // make the sidecar's compose-time initializers (automations catchup, etc.) throw
  // "no such table" and exit before printing "listening" — a test artifact, not the
  // parent-death behaviour under test.
  //
  // Seed by booting the SAME bin in STANDALONE mode (no SLAYZONE_SUPERVISED), which
  // runs the real schema bootstrap at `<dir>/slayzone.data.sqlite`, then killing it once
  // it reports listening. We can't `import { runMigrations }` in-process:
  // migrations.ts pulls `@slayzone/ai-config/shared` → `@dagrejs/dagre` (ESM) and
  // this test runs with NO loader (run_test_electron_strict), so the import hits
  // ERR_REQUIRE_CYCLE_MODULE. The bundled bin has migrations inlined + native ABI
  // matched — the closest thing to what the host actually does.
  await new Promise<void>((resolve, reject) => {
    // Scrub inherited SLAYZONE_* so the seeder boots genuinely STANDALONE. When
    // this test runs inside a supervised session the parent leaks
    // SLAYZONE_SUPERVISED=1 (+ SLAYZONE_ROOT → the real dev install), which would
    // point the seeder at the REAL store. Stripping SLAYZONE_ROOT is the load-
    // bearing half; strip the whole prefix, then set only the knobs below.
    const seedEnv: Record<string, string> = {}
    for (const [k, v] of Object.entries(process.env)) {
      if (v == null) continue
      if (k === 'ELECTRON_RUN_AS_NODE' || /^SLAYZONE_/.test(k)) continue
      seedEnv[k] = v
    }
    const seeder = spawn(process.execPath, [binJs], {
      env: {
        ...seedEnv,
        ELECTRON_RUN_AS_NODE: '1',
        // openServerDatabase bootstraps schema at the DERIVED
        // <ROOT>/storage/slayzone.data.sqlite (same dir the child opens).
        SLAYZONE_HUB_LISTEN_ADDRESS: '127.0.0.1:0',
        SLAYZONE_ROOT: dir,
        SLAYZONE_HUB_AUTH_SECRET: 'seed-only-secret-at-least-32-chars-long'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let seedOut = ''
    const onData = (c: Buffer): void => {
      seedOut += c.toString()
      if (seedOut.includes('listening on http')) {
        seeder.kill('SIGKILL')
        resolve()
      }
    }
    seeder.stdout?.on('data', onData)
    seeder.stderr?.on('data', onData)
    const to = setTimeout(() => {
      seeder.kill('SIGKILL')
      reject(new Error(`schema seed never reported listening — output: ${seedOut}`))
    }, 15_000)
    seeder.on('exit', () => clearTimeout(to))
  })
  // What this process inherited about ANOTHER hub (a dial-side SLAYZONE_HUB_ADDRESS
  // from a task terminal, a stray switch) must not reach this one — the supervisor
  // strips the same list.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
    SLAYZONE_SUPERVISED: '1',
    // DB path DERIVES from ROOT (there is no path handoff var); the seeder
    // above bootstrapped <dir>/storage/slayzone.data.sqlite, which this child opens.
    SLAYZONE_ROOT: dir
  }
  for (const name of HUB_PROCESS_ENV) delete childEnv[name]
  childEnv.SLAYZONE_HUB_LISTEN_ADDRESS = '127.0.0.1:0'
  childEnv.SLAYZONE_HUB_REQUIRE_LOGIN = '0'
  const child = spawn(process.execPath, [binJs], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let out = ''
  child.stdout?.on('data', (c: Buffer) => {
    out += c.toString()
  })
  child.stderr?.on('data', (c: Buffer) => {
    out += c.toString()
  })
  try {
    await waitFor(
      () => out.includes('listening on http'),
      10_000,
      `real side-car never reported listening — output: ${out}`
    )
    // Close the parent→child stdin pipe: this is exactly what happens when the
    // Electron parent dies. The supervised side-car must self-exit.
    child.stdin?.end()
    const exited = await waitForExit(child, 6_000)
    expect(exited, `side-car did not self-exit within 6s of stdin close — output: ${out}`).toBe(
      true
    )
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})
