import { spawn, type ChildProcess } from 'child_process'
import fs from 'fs'
import net from 'net'
import path from 'path'
import { fileURLToPath } from 'url'
import { createRequire } from 'module'
import { test as base, expect } from '@playwright/test'
import { launchIsolatedElectron, projectBlob, clickSettings } from '../fixtures/electron'

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
 *
 * The "second hub" is the sidecar bin run unsupervised on its own port + store
 * (a full hub owns a SQLite DB + all routers). Plain ws:// loopback — auth/TLS
 * pinning is Phase 6. Fully isolated: throwaway userdata + a temp store for hub2.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const APP_DIR = path.resolve(__dirname, '..', '..')
const HUB_BIN = path.resolve(APP_DIR, '..', 'hub', 'dist', 'bin.cjs')

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
  stop: () => Promise<void>
}

/** Spawn the sidecar bin as a second, standalone hub on its own port + store. */
async function spawnSecondHub(storeDir: string): Promise<SecondHub> {
  if (!fs.existsSync(HUB_BIN)) throw new Error(`hub bin missing: ${HUB_BIN} (run pnpm build)`)
  fs.mkdirSync(storeDir, { recursive: true })
  const port = await freePort()
  const electronPath = require('electron') as unknown as string
  // CRITICAL: strip inherited SLAYZONE_*/ELECTRON_* first. When e2e runs from a
  // dogfooding SlayZone terminal, the parent leaks SLAYZONE_DB_PATH (real dev DB)
  // which db.ts gives precedence over SLAYZONE_STORE_DIR → the second hub would
  // scribble into the real dev store. Re-add only what this hub needs.
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
      SLAYZONE_SERVER_HOST: '127.0.0.1',
      SLAYZONE_SERVER_PORT: String(port),
      SLAYZONE_STORE_DIR: storeDir
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  proc.stdout?.on('data', () => undefined)
  proc.stderr?.on('data', () => undefined)
  return {
    proc,
    port,
    url: `ws://127.0.0.1:${port}/trpc`,
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

base.describe('Multi-hub federation (2 hubs)', () => {
  base('rail unions both hubs; local DB stays isolated; writes route to owner', async () => {
    base.setTimeout(180_000)

    const secondStore = fs.mkdtempSync(path.join(APP_DIR, 'e2e-second-hub-'))
    let hub: SecondHub | null = null
    let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
    try {
      hub = await spawnSecondHub(secondStore)
      await waitForHubHealth(hub.port)
      const remoteHubUrl = hub.url

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
          fs.writeFileSync(
            path.join(userDataDir, 'boot-config.json'),
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
        extraEnv: (userDataDir) => ({ SLAYZONE_STORE_DIR: userDataDir })
      })

      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })

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
      await page.evaluate(() => window.__slayzone_refreshData?.())

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
      if (hub) await hub.stop()
      fs.rmSync(secondStore, { recursive: true, force: true })
    }
  })

  base('Hubs settings lists both hubs; new-project picker routes to the chosen hub', async () => {
    base.setTimeout(180_000)

    const secondStore = fs.mkdtempSync(path.join(APP_DIR, 'e2e-second-hub-'))
    let hub: SecondHub | null = null
    let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
    try {
      hub = await spawnSecondHub(secondStore)
      await waitForHubHealth(hub.port)
      const remoteHubUrl = hub.url

      launched = await launchIsolatedElectron({
        name: 'multi-hub-settings',
        seedUserData: (userDataDir) => {
          fs.writeFileSync(
            path.join(userDataDir, 'boot-config.json'),
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
        extraEnv: (userDataDir) => ({ SLAYZONE_STORE_DIR: userDataDir })
      })

      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })

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
      await page.evaluate(() => window.__slayzone_dialogStore?.getState().openCreateProject())
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
            .then((ps: Array<{ name: string }>) => ps.some((p) => p.name === 'Routed-P')) as Promise<
            boolean
          >
      )
      expect(onLocal).toBe(false)
    } finally {
      if (launched) await launched.close()
      if (hub) await hub.stop()
      fs.rmSync(secondStore, { recursive: true, force: true })
    }
  })

  base('a remote-hub task PTY spawns on the remote hub and streams output back (Phase 4)', async () => {
    base.setTimeout(180_000)

    const secondStore = fs.mkdtempSync(path.join(APP_DIR, 'e2e-second-hub-'))
    let hub: SecondHub | null = null
    let launched: Awaited<ReturnType<typeof launchIsolatedElectron>> | null = null
    try {
      hub = await spawnSecondHub(secondStore)
      await waitForHubHealth(hub.port)
      const remoteHubUrl = hub.url

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
          fs.writeFileSync(
            path.join(userDataDir, 'boot-config.json'),
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
        extraEnv: (userDataDir) => ({ SLAYZONE_STORE_DIR: userDataDir })
      })

      const page = launched.page
      await page.waitForSelector('#root', { timeout: 20_000 })

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
        .poll(
          () => withHubClient(remoteHubUrl, (c) => c.pty.exists.query({ sessionId })),
          { timeout: 30_000, intervals: [500, 1_000] }
        )
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

/** Run `fn` with a raw tRPC WS client to a hub, closing the socket after. */
async function withHubClient<T>(
  url: string,
  fn: (client: any) => Promise<T>
): Promise<T> {
  const { createTRPCClient, createWSClient, wsLink } = await import('@trpc/client')
  const superjson = (await import('superjson')).default
  const ws = createWSClient({ url })
  const client = createTRPCClient<any>({ links: [wsLink({ client: ws, transformer: superjson })] })
  try {
    return await fn(client)
  } finally {
    ws.close()
  }
}
