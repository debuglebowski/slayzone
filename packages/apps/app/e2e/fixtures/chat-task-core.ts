/**
 * The provider-neutral core of the chat e2e harnesses (fixtures/chat.ts for
 * Claude, fixtures/chat-codex.ts for Codex): the hub-database helpers, opening a
 * chat task in its own repo, the task handle's UI + event accessors, and the
 * watchdog seam. Each harness adds its fake (scenario, spawn runs, drift guard)
 * and its provider's extras around it.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { createIsolatedGitRepo, expect, openTaskById, seed } from './electron'
import { seedChatEvents, readChatEvents } from './chat-seed'

export type ChatMode = 'claude-chat' | 'codex-chat'

/** A `chat_events` row, parsed. */
export interface ChatEventRow {
  seq: number
  event: { kind: string } & Record<string, unknown>
}

/** The hub's database, through the app's E2E-gated `__db` forwarder. */
export interface ChatDb {
  all<T>(sql: string, params?: unknown[]): Promise<T[]>
  run(sql: string, params?: unknown[]): Promise<void>
}

export function chatDb(electronApp: ElectronApplication): ChatDb {
  return {
    all: <T>(sql: string, params: unknown[] = []) =>
      electronApp.evaluate(
        async ({}, { q, p }) => {
          const d = (globalThis as Record<string, unknown>).__db as {
            all: (sql: string, params?: unknown[]) => Promise<unknown[]>
          }
          return d.all(q, p)
        },
        { q: sql, p: params }
      ) as Promise<T[]>,
    run: (sql: string, params: unknown[] = []) =>
      electronApp.evaluate(
        async ({}, { q, p }) => {
          const d = (globalThis as Record<string, unknown>).__db as {
            run: (sql: string, params?: unknown[]) => Promise<unknown>
          }
          await d.run(q, p)
        },
        { q: sql, p: params }
      )
  }
}

/** What both harnesses' task handles share. */
export interface ChatTaskCore<M extends ChatMode> {
  taskId: string
  tabId: string
  /** The task's repo (the agent's cwd). */
  cwd: string
  page: Page
  /** The visible chat panel of this task. */
  panel: Locator
  composer: Locator
  stopButton: Locator
  sendButton: Locator
  /** Type into the composer and press Enter. */
  send(text: string): Promise<void>
  /** The tab's persisted chat events, ordered by seq. */
  events(): Promise<ChatEventRow[]>
  /** Reload the renderer (the hub and the agent keep running) and reopen this task. */
  reload(): Promise<void>
  /** `chat.<op>` input naming this tab (`{tabId, taskId, mode, cwd}`). */
  opts(): { tabId: string; taskId: string; mode: M; cwd: string }
}

export interface OpenChatTaskCoreOpts<M extends ChatMode> {
  page: Page
  electronApp: ElectronApplication
  db: ChatDb
  mode: M
  /** The repo's name (unique per task) and the project that holds it. */
  repoName: string
  project: { name: string; color: string }
  title: string
  /** Task description (markdown), e.g. for the inject-description shortcut. */
  description?: string
  /** Seeds `provider_config[mode].chatConversationId` → the first spawn resumes it. */
  conversationId?: string
  /** Seeds `chat_events` rows (seq = index), as a previous session would have left them. */
  seedEvents?: Array<Record<string, unknown>>
  /** Files written into the task's repo before the task opens (repo-relative path → content). */
  repoFiles?: Record<string, string>
  /** `on-open` (default): spawned the way the Restart button does. `on-send`: lazily. */
  spawn?: 'on-open' | 'on-send'
  /** Create it as a temporary (scratch) task. */
  isTemporary?: boolean
  /** Resolves once the fake's first spawn exists (`epoch.waitForRun(0)`). */
  waitForFirstRun: () => Promise<unknown>
}

/**
 * Create a chat task of `mode` in its own repo, seed it, open it, and (by default)
 * spawn its agent. The caller has closed every task tab and set the fake's scenario.
 */
export async function openChatTaskCore<M extends ChatMode>(
  o: OpenChatTaskCoreOpts<M>
): Promise<ChatTaskCore<M>> {
  const { page, db, mode } = o
  const repo = createIsolatedGitRepo(o.repoName)
  for (const [rel, content] of Object.entries(o.repoFiles ?? {})) {
    const file = path.join(repo, rel)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const s = seed(page)
  const project = await s.createProject({
    name: o.project.name,
    color: o.project.color,
    path: repo
  })
  const task = await s.createTask({
    projectId: project.id,
    title: o.title,
    ...(o.description ? { description: o.description } : {}),
    status: 'todo',
    agentId: mode,
    ...(o.isTemporary ? { isTemporary: true } : {})
  })
  const tabId = await page.evaluate(
    async ({ id, m }) => {
      const tab = await window
        .getTrpcVanillaClient()
        .taskTerminals.ensureMain.mutate({ taskId: id, mode: m })
      return tab.id
    },
    { id: task.id, m: mode }
  )
  if (o.conversationId) {
    await db.run(
      `UPDATE tasks SET provider_config =
         json_set(COALESCE(provider_config, '{}'), '$."${mode}".chatConversationId', ?)
       WHERE id = ?`,
      [o.conversationId, task.id]
    )
  }
  await seedChatEvents(page, tabId, o.seedEvents ?? [])
  await s.refreshData()
  await openTaskById(page, task.id)
  const panel = page.locator('[data-chat-panel]:visible')
  await expect(panel).toBeVisible({ timeout: 10_000 })
  const composer = panel.locator('textarea')
  if ((o.spawn ?? 'on-open') === 'on-open') {
    // Pre-spawn the way the Restart button does. Once `chat.start` has
    // returned, the driver is live for any later request: the routed handle
    // starts it one tick after the spawn call (exec-proxies.ts onSpawn
    // setImmediate), before this response even leaves the hub. A send that
    // itself spawns the agent races that tick and is dropped today (140's
    // lazy-spawn known bug) — so this is how a test relies on its first
    // message arriving.
    await page.evaluate((input) => window.getTrpcVanillaClient().chat.start.mutate(input), {
      tabId,
      taskId: task.id,
      mode,
      cwd: repo
    })
    await o.waitForFirstRun()
  }
  return {
    taskId: task.id,
    tabId,
    cwd: repo,
    page,
    panel,
    composer,
    stopButton: panel.getByRole('button', { name: 'Stop generation' }),
    // Exact: a user message's "Edit & resend" button contains the word too.
    sendButton: panel.getByRole('button', { name: 'Send', exact: true }),
    async send(text) {
      await expect(composer).toBeEnabled()
      await composer.fill(text)
      await composer.press('Enter')
    },
    async events() {
      return readChatEvents(page, tabId)
    },
    async reload() {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await openTaskById(page, task.id)
      await expect(panel).toBeVisible({ timeout: 10_000 })
    },
    opts: () => ({ tabId, taskId: task.id, mode, cwd: repo })
  }
}

/** Shorten the chat watchdog (test-only tRPC seam); `null` restores the defaults. */
export async function setChatWatchdogTimings(
  page: Page,
  timings: { startingBoundMs: number; runningStallMs: number; killGraceMs: number } | null
): Promise<void> {
  await page.evaluate(
    (t) => window.getTrpcVanillaClient().chat.testSetWatchdogTimings.mutate({ timings: t }),
    timings
  )
}
