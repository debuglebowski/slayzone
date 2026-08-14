import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { test as base, expect, type Page } from '@playwright/test'
import type { AnyTRPCRouter } from '@trpc/server'
import {
  launchIsolatedElectron,
  projectBlob,
  clickSettings,
  bootConfigPath
} from '../fixtures/electron'

/**
 * Phase 3a — multi-hub federation, 2-hub loopback end-to-end.
 *
 * The client connects to the co-located LOCAL hub PLUS a second full-data hub at
 * once and merges their projects into one flat rail. Proves:
 *   1. UNION — a project on the local hub AND a project on the remote hub both
 *      appear in the merged board (the rail's data source).
 *   2. ISOLATION — the local hub's OWN DB does not contain the remote project
 *      (the union is a client-side merge, not cross-hub data bleed).
 *   3. ROUTING — a routed task write (via the federated useTasksData path the UI
 *      uses) on a remote-hub task lands on the REMOTE hub's DB, not local.
 *   4. COMPUTER ENROLLMENT — the Computers tab merges every hub's computers into one
 *      table and mints a join token on the hub the operator PICKS (a computer belongs
 *      to exactly one hub, decided at mint time).
 *
 * The "second hub" is the sidecar bin run unsupervised on its own port + store
 * (a full hub owns a SQLite DB + all routers). Plain ws:// loopback — auth/TLS
 * pinning is Phase 6. Fully isolated: throwaway userdata + a temp store for hub2.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const APP_DIR = path.resolve(__dirname, '..', '..')
const HUB_BIN = path.resolve(APP_DIR, '..', 'hub', 'dist', 'bin.cjs')
/** Built by `ensureComputerBuilt()` in global-setup, so it exists before any spec. */
const COMPUTER_BIN = path.resolve(APP_DIR, '..', 'computer', 'dist', 'bin.cjs')

/**
 * The renderer test seams these specs drive from inside `page.evaluate`. Types are
 * erased before the closure is serialised, so naming them here is free at runtime.
 */
type FederationWindow = {
  __slayzone_refreshData?: () => Promise<unknown>
  __slayzone_dialogStore?: {
    getState: () => {
      openCreateTask: (draft?: { projectId: string }) => void
      openCreateProject: () => void
    }
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

interface SecondHub {
  proc: ChildProcess
  port: number
  url: string
  /** Bootstrap-owner bearer for this hub. Every non-supervised hub requires auth. */
  token: string
  /** The same owner's credentials, for the specs that sign in through the UI. */
  email: string
  password: string
  stop: () => Promise<void>
}

/**
 * Bearer token per hub url, registered at spawn and consumed by `withHubClient`.
 *
 * A registry rather than a parameter on each of the ~10 call sites: auth is not
 * what this spec is about, and a token that must be threaded by hand is a token
 * some future call site forgets — which fails as `hub requires authentication`
 * far from the cause. Urls absent from the map (the supervised LOCAL hub) send no
 * connectionParams at all, exactly as before.
 */
const hubTokens = new Map<string, string>()

/**
 * Read the bootstrap owner a standalone hub provisions on first boot.
 *
 * The file appears during boot, before the health server is constructed, so by
 * the time `/health` answers it is already there — polled anyway so a slow first
 * boot degrades into a wait rather than a confusing auth failure.
 */
async function readOwner(
  storeDir: string,
  timeoutMs = 30_000
): Promise<{ token: string; email: string; password: string }> {
  const file = path.join(storeDir, 'hub.owner.json')
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as {
        token?: string
        email?: string
        password?: string
      }
      if (parsed.token && parsed.email && parsed.password) {
        return { token: parsed.token, email: parsed.email, password: parsed.password }
      }
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`hub owner file not usable within ${timeoutMs}ms: ${file}`)
}

/** Spawn the sidecar bin as a second, standalone hub on its own port + store. */
async function spawnSecondHub(storeDir: string): Promise<SecondHub> {
  if (!fs.existsSync(HUB_BIN)) throw new Error(`hub bin missing: ${HUB_BIN} (run pnpm build)`)
  fs.mkdirSync(storeDir, { recursive: true })
  const port = await freePort()
  const electronPath = require('electron') as unknown as string
  // CRITICAL: strip inherited SLAYZONE_*/ELECTRON_* first. When e2e runs from a
  // supervised SlayZone terminal, the parent leaks SLAYZONE_ROOT (the real dev
  // install) → the second hub would scribble into the real dev store. Re-add only
  // what this hub needs, ROOT included, so its DB derives inside `storeDir`.
  const cleanEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v == null) continue
    if (/^(ELECTRON_|SLAYZONE_)/.test(k)) continue
    cleanEnv[k] = v
  }
  const proc = spawn(electronPath, [HUB_BIN], {
    env: {
      ...cleanEnv,
      ELECTRON_RUN_AS_NODE: '1',
      // The bind address of this second hub: one var, `host:port`.
      SLAYZONE_HUB_ADDRESS: `127.0.0.1:${port}`,
      SLAYZONE_ROOT: storeDir
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', () => undefined)
  proc.stderr?.on('data', () => undefined)
  const url = `ws://127.0.0.1:${port}/trpc`
  // A standalone hub gates its client API on a bearer (supervised is the only
  // exemption), so every caller below — this spec's raw clients AND the app —
  // has to carry one. The hub provisions its own first user on first boot
  // precisely so this needs no human; that file is the credential.
  const owner = await readOwner(storeDir)
  hubTokens.set(url, owner.token)
  return {
    proc,
    port,
    url,
    token: owner.token,
    email: owner.email,
    password: owner.password,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
        const t = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* gone */
          }
        }, 3_000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
        try {
          proc.kill('SIGTERM')
        } catch {
          clearTimeout(t)
          resolve()
        }
      })
  }
}

/** Poll the second hub's GET /health until it answers {ok:true}. */
async function waitForHubHealth(port: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  const healthUrl = `http://127.0.0.1:${port}/health`
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl)
      if (res.ok) {
        const body = (await res.json()) as { ok?: boolean }
        if (body.ok) return
      }
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error(`second hub /health not ready on :${port} within ${timeoutMs}ms`)
}

/**
 * Give the running app a bearer for a remote hub, the way a Settings sign-in does.
 *
 * Goes through the product's own IPC (`app:set-hub-token` → safeStorage →
 * `<clientState>/hub-tokens.json`) rather than seeding a file, because the store
 * is encrypted with a key only the app has.
 *
 * The reload is load-bearing, not caution: `getOrCreateHubClient` caches one WS
 * client per hub id and ignores the token on every later call, so a token stored
 * after that hub's client exists would never reach a socket. A fresh renderer
 * context re-reads the token map at boot and connects authed.
 */
async function authorizeHubInApp(page: Page, hubId: string, token: string): Promise<void> {
  const stored = await page.evaluate(
    async ({ hubId, token }) => {
      const api = (
        window as unknown as {
          api: {
            app: {
              setHubToken: (p: { hubId: string; token: string }) => Promise<unknown>
              getHubTokens: () => Promise<Record<string, string>>
            }
          }
        }
      ).api
      try {
        await api.app.setHubToken({ hubId, token })
        return { ok: (await api.app.getHubTokens())[hubId] === token }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    },
    { hubId, token }
  )
  if (!stored.ok) {
    throw new Error(
      `could not store hub token for ${hubId}: ${stored.error ?? 'not readable back'}`
    )
  }
  await page.reload()
  await page.waitForSelector('#root', { timeout: 30_000 })
}

interface HubComputer {
  proc: ChildProcess
  computerId: string
  stop: () => Promise<void>
}

/**
 * Enroll + spawn a computer against a hub, and wait until that hub reports it
 * USABLE.
 *
 * Needed because agents, terminals and git work run ONLY on computers — a hub with
 * none refuses `pty.create` with an actionable error instead of quietly spawning
 * the process itself. `spawnSecondHub` starts a bare hub, so a PTY test against it
 * has to bring its own computer; without this the spawn correctly fails.
 *
 * Mirrors `110-computer-loopback`'s loopback computer: mint a join token from the hub
 * that will own the computer, hand the computer its `<ROOT>/computer.config.json` (display name
 * + FS path-jail) and dial the url encoded in the token.
 */
async function attachComputerToHub(opts: {
  hubUrl: string
  rootDir: string
  credentialsDir: string
  allowedRoots: string
  name: string
}): Promise<HubComputer> {
  const minted = (await withHubClient(opts.hubUrl, (c) =>
    c.computers.mintJoinToken.mutate({ label: opts.name })
  )) as { token: string }
  const payload = JSON.parse(
    Buffer.from(minted.token.slice(minted.token.indexOf('.') + 1), 'base64url').toString('utf8')
  ) as { hubUrl: string }

  fs.mkdirSync(opts.rootDir, { recursive: true })
  fs.writeFileSync(
    path.join(opts.rootDir, 'computer.config.json'),
    JSON.stringify({ computerName: opts.name, allowedRoots: [opts.allowedRoots] })
  )

  const electronPath = require('electron') as unknown as string
  // ELECTRON_RUN_AS_NODE: the computer's node-pty native addon must share the app's
  // ABI — same way the app supervisor spawns it.
  const proc = spawn(electronPath, [COMPUTER_BIN], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      // Standalone computer: clear any leaked SUPERVISED so it reads <ROOT>/computer.config.json.
      SLAYZONE_SUPERVISED: '',
      SLAYZONE_ROOT: opts.rootDir,
      SLAYZONE_HUB_ADDRESS: new URL(payload.hubUrl).host,
      SLAYZONE_HUB_JOIN_TOKEN: minted.token,
      SLAYZONE_COMPUTER_CREDENTIALS_DIR: opts.credentialsDir
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', () => undefined)
  proc.stderr?.on('data', () => undefined)

  // Gate on `usable`, NOT `connected`: usable means authenticated AND heard from
  // inside the heartbeat window. A spawn dispatched to an open-but-silent socket
  // would hang until the watchdog reaped it.
  let computerId: string | null = null
  await expect
    .poll(
      async () => {
        const rows = (await withHubClient(opts.hubUrl, (c) => c.computers.list.query())) as Array<{
          id: string
          usable: boolean
        }>
        computerId = rows.find((r) => r.usable)?.id ?? null
        return computerId !== null
      },
      { timeout: 60_000, intervals: [500, 1_000, 2_000] }
    )
    .toBe(true)

  return {
    proc,
    computerId: computerId!,
    stop: () =>
      new Promise<void>((resolve) => {
        if (proc.exitCode !== null || proc.signalCode !== null) return resolve()
        const t = setTimeout(() => {
          try {
            proc.kill('SIGKILL')
          } catch {
            /* gone */
          }
          resolve()
        }, 3_000)
        proc.once('exit', () => {
          clearTimeout(t)
          resolve()
        })
        try {
          proc.kill('SIGTERM')
        } catch {
          clearTimeout(t)
          resolve()
        }
      })
  }
}

/**
 * Give a second hub a computer of its own.
 *
 * `projects.create` REFUSES on a hub with no usable computer — a project's files
 * live on a machine, so a hub with none has nowhere to put them and no way to run
 * an agent. A bare second hub therefore cannot hold the fixture data these specs
 * federate over, whether it is seeded over a raw client or created through the
 * app's own picker. The jail admits `storeDir`, which is where every path these
 * specs hand a project lives.
 */
function attachDefaultComputer(hub: SecondHub, storeDir: string): Promise<HubComputer> {
  return attachComputerToHub({
    hubUrl: hub.url,
    rootDir: path.join(storeDir, 'computer-root'),
    credentialsDir: path.join(storeDir, 'computer-creds'),
    allowedRoots: storeDir,
    name: 'e2e-remote-hub-computer'
  })
}

base.describe('Multi-hub federation (2 hubs)', () => {
  base('rail unions both hubs; local DB stays isolated; writes route to owner', async () => {
    base.setTimeout(180_000)

    const secondStore = fs.mkdtempSync(path.join(APP_DIR, 'e2e-second-hub-'))
    let hub: SecondHub | null = null
    let hubComputer: HubComputer | null = null
    let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
    try {
      hub = await spawnSecondHub(secondStore)
      await waitForHubHealth(hub.port)
      const remoteHubUrl = hub.url
      hubComputer = await attachDefaultComputer(hub, secondStore)

      // Seed a project + task on the REMOTE hub before launch (union picks it up
      // on first federated fetch).
      const { remoteProjectId, remoteTaskId } = await withHubClient(remoteHubUrl, async (c) => {
        const project = (await c.projects.create.mutate({
          name: 'Remote-P',
          color: '#22c55e',
          path: '/tmp'
        })) as { id: string }
        const task = (await c.task.create.mutate({
          projectId: project.id,
          title: 'remote task',
          status: 'todo'
        })) as { id: string }
        return { remoteProjectId: project.id, remoteTaskId: task.id }
      })

      launched = await launchIsolatedElectron({
        name: 'multi-hub-federation',
        seedUserData: (userDataDir) => {
          fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
          fs.writeFileSync(
            bootConfigPath(userDataDir),
            JSON.stringify(
              {
                server_mode: 'local',
                multi_hub: true,
                hubs: [{ id: 'remote-b', kind: 'remote', label: 'B', url: remoteHubUrl }],
                default_hub_id: 'local'
              },
              null,
              2
            )
          )
        },
        extraEnv: (userDataDir) => ({ SLAYZONE_ROOT: userDataDir })
      })

      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })
      await authorizeHubInApp(page, 'remote-b', hub.token)

      // Seed a LOCAL-hub project so the union has one project from each hub.
      const localProjectId = await page.evaluate(async () => {
        const c = window.getTrpcVanillaClient()
        const project = await c.projects.create.mutate({
          name: 'Local-P',
          color: '#3b82f6',
          path: '/tmp'
        })
        await c.task.create.mutate({ projectId: project.id, title: 'local task', status: 'todo' })
        return project.id as string
      })
      await page.evaluate(() => (window as unknown as FederationWindow).__slayzone_refreshData?.())

      // (1) UNION — the flat rail renders a tile for BOTH hubs' projects. The
      // rail is fed by useTasksData's merged (federated) arrays, so both the
      // local "LO" and the remote "RE" blobs must appear.
      await expect(projectBlob(page, 'LO')).toBeVisible({ timeout: 30_000 })
      await expect(projectBlob(page, 'RE')).toBeVisible({ timeout: 30_000 })

      // (2) ISOLATION — the LOCAL hub's OWN DB holds Local-P but NOT Remote-P.
      // The window vanilla client IS the local hub (the merge lives only in the
      // renderer hook), so its projects.list is the local DB's raw truth.
      const localOnlyProjectIds = await page.evaluate(
        () =>
          window
            .getTrpcVanillaClient()
            .projects.list.query()
            .then((ps: Array<{ id: string }>) => ps.map((p) => p.id)) as Promise<string[]>
      )
      expect(localOnlyProjectIds).toContain(localProjectId)
      expect(localOnlyProjectIds).not.toContain(remoteProjectId)

      // (3) ROUTING — move the REMOTE task via the app's OWN board move handler
      // (`__slayzone_moveTaskForTest` → handleTaskMove → useTasksData.moveTask →
      // clientForTask → the remote hub). The federated hook must route the write
      // to the owning (remote) hub. The UNION assertion above already awaited the
      // merged board, so the remote task's origin-map entry exists.
      await page.evaluate(
        (tid) =>
          (
            window as {
              __slayzone_moveTaskForTest?: (t: string, col: string, i: number) => void
            }
          ).__slayzone_moveTaskForTest?.(tid, 'in_progress', 0),
        remoteTaskId
      )

      // Assert the routed write landed on the REMOTE hub's DB.
      await expect
        .poll(
          () =>
            withHubClient(remoteHubUrl, async (c) => {
              const board = (await c.task.loadBoardData.query()) as {
                tasks: Array<{ id: string; status: string }>
              }
              return board.tasks.find((t) => t.id === remoteTaskId)?.status ?? null
            }),
          { timeout: 15_000, intervals: [500, 1_000] }
        )
        .toBe('in_progress')

      // ISOLATION — the remote task must NEVER appear on the LOCAL hub's own DB
      // (the window client is the local hub; merge happens only in the hook).
      const localTaskIds = await page.evaluate(
        () =>
          window
            .getTrpcVanillaClient()
            .task.loadBoardData.query()
            .then((b: { tasks: Array<{ id: string }> }) => b.tasks.map((t) => t.id)) as Promise<
            string[]
          >
      )
      expect(localTaskIds).not.toContain(remoteTaskId)

      // (4) REMOTE BOARD INTERACTIVITY (Phase 3b) — open the REMOTE task's tab.
      // The tab content is wrapped in <HubScope hubId={task's hub}>, so the
      // hub-keyed taskDetailCache fetches the detail from the REMOTE hub (the
      // local hub has no such task). Proof: the title input shows the remote
      // task's title — data that only exists on the remote hub.
      await page.evaluate(
        (tid) =>
          (window as { __slayzone_openTask?: (taskId: string) => void }).__slayzone_openTask?.(tid),
        remoteTaskId
      )
      // The title input's live value reflects the loaded detail. React sets it as
      // a property (not attribute), so poll each input's inputValue for a match.
      await expect
        .poll(
          async () => {
            const inputs = await page.locator('input').all()
            for (const el of inputs) {
              const v = await el.inputValue().catch(() => '')
              if (v === 'remote task') return true
            }
            return false
          },
          { timeout: 20_000, intervals: [500, 1_000] }
        )
        .toBe(true)
    } finally {
      if (launched) await launched.close()
      // Computer before hub: it re-dials on disconnect, so killing the hub first
      // leaves it reconnecting against a dead port for the whole teardown.
      if (hubComputer) await hubComputer.stop()
      if (hub) await hub.stop()
      fs.rmSync(secondStore, { recursive: true, force: true })
    }
  })

  base('creating a task on a remote-hub project writes to THAT hub and opens there', async () => {
    base.setTimeout(180_000)

    // A task row is FK-bound to its project (`tasks.project_id REFERENCES
    // projects(id)`), and the project exists in exactly ONE hub's DB. The
    // create-task dialog is mounted in the app shell — under the DEFAULT hub's
    // scope — so before it routed by project, this create hit the LOCAL hub and
    // came back as "FOREIGN KEY constraint failed".
    const TITLE = 'created on the remote hub'
    const secondStore = fs.mkdtempSync(path.join(APP_DIR, 'e2e-second-hub-'))
    let hub: SecondHub | null = null
    let hubComputer: HubComputer | null = null
    let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
    try {
      hub = await spawnSecondHub(secondStore)
      await waitForHubHealth(hub.port)
      const remoteHubUrl = hub.url
      hubComputer = await attachDefaultComputer(hub, secondStore)

      const remoteProjectId = await withHubClient(remoteHubUrl, async (c) => {
        const project = (await c.projects.create.mutate({
          name: 'Remote-P',
          color: '#22c55e',
          path: '/tmp'
        })) as { id: string }
        return project.id
      })

      launched = await launchIsolatedElectron({
        name: 'multi-hub-create-task',
        seedUserData: (userDataDir) => {
          fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
          fs.writeFileSync(
            bootConfigPath(userDataDir),
            JSON.stringify(
              {
                server_mode: 'local',
                multi_hub: true,
                hubs: [{ id: 'remote-b', kind: 'remote', label: 'B', url: remoteHubUrl }],
                default_hub_id: 'local'
              },
              null,
              2
            )
          )
        },
        extraEnv: (userDataDir) => ({ SLAYZONE_ROOT: userDataDir })
      })

      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })
      await authorizeHubInApp(page, 'remote-b', hub.token)

      // The remote project's rail tile proves the federated board landed — and
      // with it the project→hub ownership the create routes on.
      await expect(projectBlob(page, 'RE')).toBeVisible({ timeout: 30_000 })

      // Open the create-task dialog already aimed at the REMOTE project, exactly
      // as the sidebar "+" and a board column's add button do (they pass a draft
      // carrying the project id, which may belong to any hub in the union).
      await page.evaluate(
        (pid) =>
          (window as unknown as FederationWindow).__slayzone_dialogStore
            ?.getState()
            .openCreateTask({ projectId: pid }),
        remoteProjectId
      )
      await page.locator('input[name="title"]').fill(TITLE)
      await page.locator('button').filter({ hasText: 'Create + open' }).first().click()

      // (1) The row exists on the REMOTE hub.
      await expect
        .poll(
          () =>
            withHubClient(remoteHubUrl, async (c) => {
              const board = (await c.task.loadBoardData.query()) as {
                tasks: Array<{ title: string }>
              }
              return board.tasks.some((t) => t.title === TITLE)
            }),
          { timeout: 20_000, intervals: [500, 1_000] }
        )
        .toBe(true)

      // (2) …and never on the LOCAL hub, which has no such project. The window
      // client IS the local hub, so this is its raw DB truth.
      const localTitles = await page.evaluate(
        () =>
          window
            .getTrpcVanillaClient()
            .task.loadBoardData.query()
            .then((b: { tasks: Array<{ title: string }> }) =>
              b.tasks.map((t) => t.title)
            ) as Promise<string[]>
      )
      expect(localTitles).not.toContain(TITLE)

      // (3) "Create + open" opened the tab. Its detail only loads if the tab
      // resolved to the REMOTE hub — which requires the new id's hub to be known
      // BEFORE that hub's board reload lands (the create records it).
      await expect
        .poll(
          async () => {
            const inputs = await page.locator('input').all()
            for (const el of inputs) {
              const v = await el.inputValue().catch(() => '')
              if (v === TITLE) return true
            }
            return false
          },
          { timeout: 20_000, intervals: [500, 1_000] }
        )
        .toBe(true)
    } finally {
      if (launched) await launched.close()
      if (hubComputer) await hubComputer.stop()
      if (hub) await hub.stop()
      fs.rmSync(secondStore, { recursive: true, force: true })
    }
  })

  base('Hubs settings lists both hubs; new-project picker routes to the chosen hub', async () => {
    base.setTimeout(180_000)

    const secondStore = fs.mkdtempSync(path.join(APP_DIR, 'e2e-second-hub-'))
    let hub: SecondHub | null = null
    let hubComputer: HubComputer | null = null
    let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
    try {
      hub = await spawnSecondHub(secondStore)
      await waitForHubHealth(hub.port)
      const remoteHubUrl = hub.url
      hubComputer = await attachDefaultComputer(hub, secondStore)

      launched = await launchIsolatedElectron({
        name: 'multi-hub-settings',
        seedUserData: (userDataDir) => {
          fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
          fs.writeFileSync(
            bootConfigPath(userDataDir),
            JSON.stringify(
              {
                server_mode: 'local',
                multi_hub: true,
                hubs: [{ id: 'remote-b', kind: 'remote', label: 'Hub B', url: remoteHubUrl }],
                default_hub_id: 'local'
              },
              null,
              2
            )
          )
        },
        extraEnv: (userDataDir) => ({ SLAYZONE_ROOT: userDataDir })
      })

      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })
      await authorizeHubInApp(page, 'remote-b', hub.token)

      // Open Settings → click the Hubs nav item; assert both hub rows.
      await clickSettings(page)
      const dialog = page.locator('[role="dialog"][aria-label="Settings"]').first()
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await dialog.locator('aside button').filter({ hasText: 'Connections' }).first().click()
      await expect(page.locator('[data-testid="hub-row-local"]')).toBeVisible({ timeout: 10_000 })
      await expect(page.locator('[data-testid="hub-row-remote"]')).toBeVisible({ timeout: 10_000 })

      // Close settings, then create a project targeting the REMOTE hub via the
      // dialog's hub picker, and assert it lands on the remote hub's DB.
      await page.keyboard.press('Escape')
      await page.evaluate(() =>
        (window as unknown as FederationWindow).__slayzone_dialogStore
          ?.getState()
          .openCreateProject()
      )
      await page.getByPlaceholder('Project name').fill('Routed-P')
      // Pick the remote hub in the picker (radix Select).
      await page.locator('[data-testid="create-project-hub"]').click()
      await page.getByRole('option', { name: /Hub B/ }).click()
      await page.getByRole('button', { name: 'Create', exact: true }).click()

      await expect
        .poll(
          () =>
            withHubClient(remoteHubUrl, async (c) => {
              const ps = (await c.projects.list.query()) as Array<{ name: string }>
              return ps.some((p) => p.name === 'Routed-P')
            }),
          { timeout: 20_000, intervals: [500, 1_000] }
        )
        .toBe(true)

      // And NOT on the local hub.
      const onLocal = await page.evaluate(
        () =>
          window
            .getTrpcVanillaClient()
            .projects.list.query()
            .then((ps: Array<{ name: string }>) =>
              ps.some((p) => p.name === 'Routed-P')
            ) as Promise<boolean>
      )
      expect(onLocal).toBe(false)
    } finally {
      if (launched) await launched.close()
      if (hubComputer) await hubComputer.stop()
      if (hub) await hub.stop()
      fs.rmSync(secondStore, { recursive: true, force: true })
    }
  })

  base('Connections tab nests computers per hub and mints on the hub they sit under', async () => {
    base.setTimeout(180_000)

    // A computer belongs to exactly ONE hub, and which hub is decided when the token is
    // MINTED (it embeds that hub's dial url + cert fingerprint). Listing computers
    // inside their hub makes the enrollment control's POSITION the hub choice, so a
    // federated client can enroll against a remote hub with no picker to get wrong —
    // which is what this asserts end-to-end.
    const secondStore = fs.mkdtempSync(path.join(APP_DIR, 'e2e-second-hub-'))
    let hub: SecondHub | null = null
    let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
    try {
      hub = await spawnSecondHub(secondStore)
      await waitForHubHealth(hub.port)
      const remotePort = hub.port
      const remoteHubUrl = hub.url

      launched = await launchIsolatedElectron({
        name: 'multi-hub-computers',
        seedUserData: (userDataDir) => {
          fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
          fs.writeFileSync(
            bootConfigPath(userDataDir),
            JSON.stringify(
              {
                server_mode: 'local',
                multi_hub: true,
                hubs: [{ id: 'remote-b', kind: 'remote', label: 'Hub B', url: remoteHubUrl }],
                default_hub_id: 'local'
              },
              null,
              2
            )
          )
        },
        extraEnv: (userDataDir) => ({ SLAYZONE_ROOT: userDataDir })
      })

      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })
      await authorizeHubInApp(page, 'remote-b', hub.token)

      await clickSettings(page)
      const dialog = page.locator('[role="dialog"][aria-label="Settings"]').first()
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await dialog.locator('aside button').filter({ hasText: 'Connections' }).first().click()

      // Computers are listed INSIDE their hub — one block per connected hub, since a
      // computer belongs to exactly one. Both hubs are connected here.
      await expect(page.locator('[data-testid="computers-table"]')).toHaveCount(2, {
        timeout: 10_000
      })

      // Enrolling from within Hub B's group IS the hub choice — there is no picker
      // to get wrong. That absence is the federated affordance under test.
      const remoteGroup = page.locator('[data-testid="hub-group-remote-b"]')
      await expect(remoteGroup).toBeVisible({ timeout: 10_000 })
      await remoteGroup.locator('[data-testid="computer-add-open"]').click()
      await expect(page.locator('[data-testid="computer-add-hub"]')).toHaveCount(0)
      await remoteGroup.locator('[data-testid="computer-add"]').click()

      // The dialog must name the hub the token belongs to: with several connected, a
      // token pasted onto the wrong machine is indistinguishable from a broken one.
      const mintedHub = page.locator('[data-testid="computer-minted-hub"]')
      await expect(mintedHub).toBeVisible({ timeout: 20_000 })
      await expect(mintedHub).toContainText('Hub B')
      // The dial target must be the REMOTE hub's own port — the proof the mint was
      // routed rather than served by the default hub.
      await expect(mintedHub).toContainText(`:${remotePort}/computers`)

      // A mint creates a join_tokens row, NOT a computer row, so the remote hub's
      // computer list is still empty — assert the token instead, via the hub that
      // issued it.
      const tokenText = await page.locator('[data-testid="computer-minted-token"] code').innerText()
      expect(tokenText.startsWith('szjt1.')).toBe(true)
      const payload = JSON.parse(
        Buffer.from(tokenText.slice('szjt1.'.length), 'base64url').toString('utf8')
      ) as { hubUrl: string }
      expect(payload.hubUrl).toBe(`ws://127.0.0.1:${remotePort}/computers`)
    } finally {
      if (launched) await launched.close()
      if (hub) await hub.stop()
      fs.rmSync(secondStore, { recursive: true, force: true })
    }
  })

  base(
    'a remote-hub task PTY spawns on the remote hub and streams output back (Phase 4)',
    async () => {
      base.setTimeout(180_000)

      const secondStore = fs.mkdtempSync(path.join(APP_DIR, 'e2e-second-hub-'))
      let hub: SecondHub | null = null
      let hubComputer: HubComputer | null = null
      let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
      try {
        hub = await spawnSecondHub(secondStore)
        await waitForHubHealth(hub.port)
        const remoteHubUrl = hub.url

        // Here the computer is not just the create-guard's precondition (see
        // `attachDefaultComputer`) but the subject: terminals run ONLY on
        // computers, so this is what makes the assertion below meaningful — the
        // PTY genuinely runs on the remote hub's machine rather than inside the
        // hub process itself. The jail admits the pty cwd used below.
        hubComputer = await attachDefaultComputer(hub, secondStore)

        // Remote hub: create a project (path = the remote store dir, a real dir) +
        // a task to run a terminal in.
        const { remoteTaskId } = await withHubClient(remoteHubUrl, async (c) => {
          const project = (await c.projects.create.mutate({
            name: 'Remote-Term',
            color: '#22c55e',
            path: secondStore
          })) as { id: string }
          const task = (await c.task.create.mutate({
            projectId: project.id,
            title: 'remote term task',
            status: 'in_progress'
          })) as { id: string }
          return { remoteTaskId: task.id }
        })

        launched = await launchIsolatedElectron({
          name: 'multi-hub-pty',
          seedUserData: (userDataDir) => {
            fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
            fs.writeFileSync(
              bootConfigPath(userDataDir),
              JSON.stringify(
                {
                  server_mode: 'local',
                  multi_hub: true,
                  hubs: [{ id: 'remote-b', kind: 'remote', label: 'B', url: remoteHubUrl }],
                  default_hub_id: 'local'
                },
                null,
                2
              )
            )
          },
          extraEnv: (userDataDir) => ({ SLAYZONE_ROOT: userDataDir })
        })

        const page = launched.page
        await page.waitForSelector('#root', { timeout: 20_000 })
        await authorizeHubInApp(page, 'remote-b', hub.token)

        // Spawn a raw-shell PTY for the remote task via the app's federated client
        // registry (the remote hub's client), then drive a command and assert the
        // output streams back — proving the per-hub PtyEventStreams fans onData from
        // the REMOTE hub. sessionId matches the app's convention `${taskId}:${taskId}`.
        const sessionId = `${remoteTaskId}:${remoteTaskId}`
        const marker = `MULTIHUB_PTY_OK_${remoteTaskId.slice(0, 8)}`

        // Create on the remote hub directly (deterministic — no UI timing), then
        // assert the app observes its live output through the federated stream.
        await withHubClient(remoteHubUrl, (c) =>
          c.pty.create.mutate({ sessionId, cwd: secondStore, mode: 'terminal' })
        )
        await expect
          .poll(() => withHubClient(remoteHubUrl, (c) => c.pty.exists.query({ sessionId })), {
            timeout: 30_000,
            intervals: [500, 1_000]
          })
          .toBe(true)

        // Drive a command on the remote hub's pty and confirm its stdout came back
        // (proof the pty runs on the remote hub + streams round-trip).
        await expect
          .poll(
            async () => {
              await withHubClient(remoteHubUrl, (c) =>
                c.pty.write.mutate({ sessionId, data: `echo ${marker}\r` })
              )
              const buffer = await withHubClient(remoteHubUrl, (c) =>
                c.pty.getBuffer.query({ sessionId })
              )
              return bufferHasCommandOutput((buffer as string) ?? '', marker)
            },
            { timeout: 45_000, intervals: [1_000, 1_500, 2_000] }
          )
          .toBe(true)

        // And the APP's federated terminal-state store sees this remote session as
        // ALIVE (running/idle), not the 'starting' default — proving the per-hub
        // PtyEventStreams + cross-hub reconcile surface remote liveness. Nudge a
        // reconcile via window focus, then poll the store.
        await page.evaluate(() => window.dispatchEvent(new Event('focus')))
        await expect
          .poll(
            () =>
              page.evaluate((sid) => {
                const store = (
                  window as unknown as {
                    __slayzone_terminalStateStore?: {
                      getState: () => { getSessionState?: (id: string) => string }
                    }
                  }
                ).__slayzone_terminalStateStore
                if (!store?.getState().getSessionState) return null
                return store.getState().getSessionState!(sid)
              }, sessionId),
            { timeout: 30_000, intervals: [1_000, 2_000] }
          )
          .toMatch(/running|idle/)
      } finally {
        if (launched) await launched.close()
        // Computer before hub: it re-dials on disconnect, so killing the hub first
        // leaves it reconnecting against a dead port for the whole teardown.
        if (hubComputer) await hubComputer.stop()
        if (hub) await hub.stop()
        fs.rmSync(secondStore, { recursive: true, force: true })
      }
    }
  )

  base('adding a hub via Settings goes live without a reload', async () => {
    base.setTimeout(180_000)

    // Boots SINGLE-hub (no remotes in boot-config, mirroring a user who has
    // never touched multi-hub federation) — the app-level "add a hub" flow is
    // the whole point of this test, not just the settings-tab UI in isolation.
    const secondStore = fs.mkdtempSync(path.join(APP_DIR, 'e2e-second-hub-'))
    let hub: SecondHub | null = null
    let hubComputer: HubComputer | null = null
    let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
    try {
      hub = await spawnSecondHub(secondStore)
      await waitForHubHealth(hub.port)
      const remoteHubUrl = hub.url
      hubComputer = await attachDefaultComputer(hub, secondStore)

      // Seed a project on the hub-to-be-added BEFORE it's added — proves the
      // rail picks up pre-existing remote data on first live connect, not just
      // data created after.
      await withHubClient(remoteHubUrl, (c) =>
        c.projects.create.mutate({ name: 'LiveAdd-P', color: '#f97316', path: '/tmp' })
      )

      launched = await launchIsolatedElectron({
        name: 'multi-hub-live-add',
        seedUserData: (userDataDir) => {
          fs.mkdirSync(path.dirname(bootConfigPath(userDataDir)), { recursive: true })
          fs.writeFileSync(
            bootConfigPath(userDataDir),
            JSON.stringify(
              { server_mode: 'local', multi_hub: false, hubs: [], default_hub_id: 'local' },
              null,
              2
            )
          )
        },
        extraEnv: (userDataDir) => ({ SLAYZONE_ROOT: userDataDir })
      })

      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })

      // Before adding: the rail has no way to see the remote hub's project.
      await expect(projectBlob(page, 'LI')).not.toBeVisible({ timeout: 2_000 })

      await clickSettings(page)
      const dialog = page.locator('[role="dialog"][aria-label="Settings"]').first()
      await expect(dialog).toBeVisible({ timeout: 10_000 })
      await dialog.locator('aside button').filter({ hasText: 'Connections' }).first().click()

      await page.locator('[data-testid="hub-add-open"]').click()
      await page.locator('[data-testid="hub-add-url"]').fill(remoteHubUrl)
      await page.locator('[data-testid="hub-probe"]').click()
      await expect(page.locator('[data-testid="hub-probe-result"]')).toContainText('reachable', {
        timeout: 10_000
      })
      await page.locator('[data-testid="hub-add"]').click()
      await page.locator('[data-testid="hubs-save-relaunch"]').click()

      // The save button clears once the (live) save resolves — confirms the
      // add-only path completed without waiting on a relaunch/reload.
      await expect(page.locator('[data-testid="hubs-save-relaunch"]')).toBeHidden({
        timeout: 10_000
      })

      // The hub is standalone, so it gates every request on a signed-in account.
      // Signing in HERE — through the product's own dialog, not a seeded token —
      // is what makes the live path complete: `signIn()` pushes the fresh token
      // into the hub registry, and this hub's WS client has not been created yet,
      // so it opens authed on the first federated fetch. Still no reload.
      await page.locator('[data-testid="hub-signin-open"]').first().click()
      await expect(page.locator('[data-testid="hub-signin-dialog"]')).toBeVisible({
        timeout: 10_000
      })
      await page.locator('[data-testid="hub-signin-email"]').fill(hub.email)
      await page.locator('[data-testid="hub-signin-password"]').fill(hub.password)
      await page.locator('[data-testid="hub-signin"]').click()
      await expect(page.locator('[data-testid="hub-signin-result"]')).toContainText('signed in', {
        timeout: 15_000
      })
      await page.keyboard.press('Escape')
      await page.keyboard.press('Escape')

      // The live path in question: the remote hub's project appears in the
      // rail with NO page.reload() anywhere in this test.
      await expect(projectBlob(page, 'LI')).toBeVisible({ timeout: 20_000 })
    } finally {
      if (launched) await launched.close()
      if (hubComputer) await hubComputer.stop()
      if (hub) await hub.stop()
      fs.rmSync(secondStore, { recursive: true, force: true })
    }
  })
})

/** True when `marker` appears on a line that is NOT the `echo <marker>` command
 *  echo — i.e. the command's actual stdout streamed back. */
function bufferHasCommandOutput(buffer: string, marker: string): boolean {
  const lines = buffer.split(/\r?\n/)
  return lines.some((line) => line.includes(marker) && !line.includes(`echo ${marker}`))
}

/** Structural stand-in for the tRPC proxy client. These specs drive a SECOND hub
 *  over a raw socket and cast every result at its own call site, so binding the
 *  real `AppRouter` here would only couple the e2e build to the router's shape.
 *
 *  Both halves are `interface`, not `type`: an interface is resolved lazily, so the
 *  self-reference in the index signature still resolves for the call sites ABOVE
 *  this declaration. As a circular type alias it collapsed to `HubProcedure` there,
 *  and every `c.<router>.<proc>` in the file reported TS2339. */
interface HubProcedure {
  query: (input?: unknown) => Promise<unknown>
  mutate: (input?: unknown) => Promise<unknown>
}
interface HubClient {
  [key: string]: HubClient & HubProcedure
}

/**
 * Run `fn` with a raw tRPC WS client to a hub, closing the socket after.
 *
 * Sends the hub's registered bearer as `connectionParams` — the same channel the
 * app's own client uses. Unregistered urls (the supervised local hub) send no
 * params frame, which is byte-identical to the untokened path.
 */
async function withHubClient<T>(url: string, fn: (client: HubClient) => Promise<T>): Promise<T> {
  const { createTRPCClient, createWSClient, wsLink } = await import('@trpc/client')
  const superjson = (await import('superjson')).default
  const token = hubTokens.get(url)
  const ws = createWSClient({
    url,
    ...(token ? { connectionParams: async () => ({ token }) } : {})
  })
  const client = createTRPCClient<AnyTRPCRouter>({
    links: [wsLink({ client: ws, transformer: superjson })]
  }) as unknown as HubClient
  try {
    return await fn(client)
  } finally {
    ws.close()
  }
}
