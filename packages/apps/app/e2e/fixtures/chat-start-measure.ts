/**
 * Chat-start latency probes (e2e/perf/chat-start-latency*.spec.ts): wall-clock
 * timestamps of what the user sees, taken IN the renderer by a MutationObserver
 * (no Playwright poll interval in the numbers), plus the fake CLI's own spawn log
 * (same machine clock). Every value is ms since the send.
 *
 * @module e2e/fixtures/chat-start-measure
 */
import fs from 'node:fs'
import os from 'node:os'
import type { Locator, Page } from '@playwright/test'
import { expect, seed } from './electron'

/** Record when each of `texts` first appears inside the visible chat panel. */
export async function watchTexts(page: Page, texts: string[]): Promise<void> {
  await page.evaluate((wanted) => {
    const w = window as unknown as {
      __chatStartSeen?: Record<string, number>
      __chatStartObs?: MutationObserver
    }
    w.__chatStartObs?.disconnect()
    const seen: Record<string, number> = {}
    w.__chatStartSeen = seen
    const check = (): void => {
      const panel = document.querySelector('[data-chat-panel]:not([hidden])') as HTMLElement | null
      const text = panel?.innerText ?? ''
      for (const t of wanted) if (seen[t] === undefined && text.includes(t)) seen[t] = Date.now()
    }
    const obs = new MutationObserver(check)
    obs.observe(document.body, { subtree: true, childList: true, characterData: true })
    w.__chatStartObs = obs
    check()
  }, texts)
}

/**
 * When `text` first appeared (wall ms), waiting up to `timeoutMs`. Never shown: the
 * failure carries what the chat shows instead (e.g. why a message was not sent).
 */
export async function seenAt(page: Page, text: string, timeoutMs = 30_000): Promise<number> {
  let at: number | undefined
  await expect
    .poll(
      async () => {
        at = await page.evaluate(
          (t) =>
            (window as unknown as { __chatStartSeen?: Record<string, number> }).__chatStartSeen?.[
              t
            ],
          text
        )
        return at !== undefined
      },
      { timeout: timeoutMs, intervals: [50] }
    )
    .toBe(true)
    .catch(async (error: unknown) => {
      const shown = await page
        .evaluate(
          () =>
            (document.querySelector('[data-chat-panel]:not([hidden])') as HTMLElement | null)
              ?.innerText ?? '(no chat panel)'
        )
        .catch(() => '(page gone)')
      throw new Error(`"${text}" never shown; the chat shows: ${JSON.stringify(shown)}`, {
        cause: error
      })
    })
  return at as number
}

/** Type `text` into the composer, then press Enter; returns the wall ms of the press. */
export async function sendTimed(composer: Locator, text: string): Promise<number> {
  await expect(composer).toBeEnabled({ timeout: 15_000 })
  await composer.fill(text)
  const t0 = Date.now()
  await composer.press('Enter')
  return t0
}

/**
 * A workspace like a real one (CHAT_START_SKILLS=N, default 0 = none): a starred
 * project (so the tree sidebar lists it) with N library skills linked for Claude +
 * Codex, and the tree sidebar shown. The sidebar's stale-skill badge checks every
 * linked skill's file on the project's computer, as the dev app does.
 */
export async function seedBusyWorkspace(
  page: Page,
  db: { run(sql: string, params?: unknown[]): Promise<void> },
  repo: string,
  skills: number
): Promise<BusyProject | null> {
  if (skills <= 0) return null
  const s = seed(page)
  const project = await s.createProject({ name: 'Busy workspace', color: '#a3e635', path: repo })
  await db.run('UPDATE projects SET starred = 1 WHERE id = ?', [project.id])
  await page.evaluate(
    async ({ projectId, projectPath, n }) => {
      const c = window.getTrpcVanillaClient()
      await c.aiConfig.setProjectProviders.mutate({ projectId, providers: ['claude', 'codex'] })
      for (let i = 0; i < n; i++) {
        const slug = `busy-skill-${i}`
        const item = await c.aiConfig.createItem.mutate({
          type: 'skill',
          scope: 'library',
          slug,
          content: `---\nname: ${slug}\ndescription: Busy skill ${i}\n---\n\nSkill ${i} body.\n`
        })
        await c.aiConfig.loadLibraryItem.mutate({
          projectId,
          projectPath,
          itemId: item.id,
          providers: ['claude', 'codex']
        })
      }
    },
    { projectId: project.id, projectPath: repo, n: skills }
  )
  await s.refreshData()
  await page.evaluate(() => {
    ;(
      window as unknown as { __slayzone_tabStore: { setState(s: object): void } }
    ).__slayzone_tabStore.setState({ sidebarView: 'tree' })
  })
  return { projectId: project.id, projectPath: repo }
}

export interface BusyProject {
  projectId: string
  projectPath: string
}

/**
 * Artificial hub→computer RPC load (CHAT_START_RPC_LOAD=N): N stale-skill counts of
 * the busy project in flight at all times — each one RPC per linked skill file on its
 * computer — until the returned stop runs. What a busy workspace's sidebar did on
 * every task change before the stale-skill fix; keeps the chat's own computer calls
 * queued behind others, the condition that let a send overtake its tab's hydrate.
 */
export async function startRpcLoad(
  page: Page,
  project: BusyProject | null,
  concurrency: number
): Promise<() => Promise<void>> {
  if (!project || concurrency <= 0) return async () => undefined
  await page.evaluate(
    ({ project, concurrency }) => {
      const w = window as unknown as { __chatStartLoad?: { stop: boolean } }
      const load = { stop: false }
      w.__chatStartLoad = load
      const c = window.getTrpcVanillaClient()
      const loop = async (): Promise<void> => {
        while (!load.stop) {
          await c.aiConfig.getProjectsStaleSkillCounts.query([project]).catch(() => undefined)
        }
      }
      for (let i = 0; i < concurrency; i++) void loop()
    },
    { project, concurrency }
  )
  return async () => {
    await page.evaluate(() => {
      const w = window as unknown as { __chatStartLoad?: { stop: boolean } }
      if (w.__chatStartLoad) w.__chatStartLoad.stop = true
    })
  }
}

export interface ChatStartSample {
  provider: 'claude' | 'codex'
  path: 'cold' | 'warm'
  /** Opening the task's tab until its composer took input. */
  openMs: number
  /** Send → the user's own message shows. */
  userShownMs: number
  /** Send → the agent process started (fake's own clock). */
  spawnMs: number
  /** Send → the agent received the prompt. */
  promptMs: number
  /** Send → the first assistant output shows. */
  replyShownMs: number
  load1: number
  at: string
}

/** Print + append one sample (CHAT_START_OUT: a .jsonl file) so runs can be aggregated. */
export function record(sample: Omit<ChatStartSample, 'load1' | 'at'>): void {
  const full: ChatStartSample = {
    ...sample,
    load1: Number(os.loadavg()[0].toFixed(1)),
    at: new Date().toISOString()
  }
  console.log(`[chat-start] ${JSON.stringify(full)}`)
  const out = process.env.CHAT_START_OUT
  if (out) fs.appendFileSync(out, `${JSON.stringify(full)}\n`)
}
