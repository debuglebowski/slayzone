/**
 * Boot restore: the hub restarts the chat agents that were running at shutdown.
 *
 * Restoring used to be the desktop's job, per tab: a chat restarted from inside
 * its task page, which mounts only when its pane hydrates — hidden panes one per
 * idle slice, behind ~5 hub round trips each. On 2026-11-11 the first agent of a
 * 67-tab workspace was ready 98 s after boot and the 90th percentile at 260 s;
 * the agents themselves start in ~1 s once launched. A renderer reload started it
 * all over. Here the hub starts them as soon as their computer is connected,
 * whatever any client is doing; a client opening the tab only attaches.
 *
 * - Which: `listAutoRestoreChatTabs` (the same rules as the reopened tabs).
 *   Terminal (pty) agents are still started by the tab: a pty start from here
 *   could race the tab's own `pty.create` while it waits for a start slot.
 * - Order: the client's active tab first (foreground lane), then the open tabs
 *   in tab-bar order, then the rest (restore lane: after anything foreground).
 * - Pace: a few starts in flight from here; the computer's admission queue does
 *   the real pacing (`computer/spawn-admission.ts`) — this only keeps its queue
 *   ordered and fed.
 * - Idempotent: a live agent is answered, never replaced (`startMainAgent`,
 *   `chat.start`); a client starting the same tab meanwhile joins the same start.
 * - Isolated: one tab that cannot start is recorded and the others go on.
 */
import type { SlayzoneDb } from '@slayzone/platform'
import type { Task } from '@slayzone/task-contracts'
import { recordDiagnosticEvent } from '@slayzone/diagnostics/server'
import { listAutoRestoreChatTabs, type AutoRestoreChatTab } from '@slayzone/task-terminals/server'
import { getChatDeps, getPtyDeps } from '@slayzone/terminal/hub'
import { resolveChatAgentLaunch, startMainAgent } from './main-agent'

/** Starts in flight from the pass at once: enough to keep the computer's queue fed. */
export const RESTORE_PASS_CONCURRENCY = 8

export interface AgentRestorePassOptions {
  getTask: (taskId: string) => Promise<Task | null>
  /** Restore only tasks this says run on the computer being restored. */
  belongsHere: (taskId: string) => Promise<boolean>
  concurrency?: number
  now?: () => number
}

export interface AgentRestorePassResult {
  /** Tabs the pass looked at. */
  tabs: number
  /** Agents this pass started. */
  started: number
  /** Already running (or started by someone else meanwhile). */
  alreadyLive: number
  /** Tabs whose task runs on another computer. */
  elsewhere: number
  failed: number
  /** ms from the pass start until each started agent was up, ascending. */
  readyMs: number[]
  totalMs: number
}

interface SavedTab {
  type?: unknown
  taskId?: unknown
  hubId?: unknown
}

/**
 * The open task tabs of the last saved client view (`viewState`): ids in tab-bar
 * order, and the active one. Only this hub's tabs (`hubId` unset or `local`).
 */
export function openTasksFromViewState(raw: string | null | undefined): {
  order: string[]
  active: string | null
} {
  if (!raw) return { order: [], active: null }
  let parsed: { tabs?: unknown; activeTabIndex?: unknown }
  try {
    parsed = JSON.parse(raw) as typeof parsed
  } catch {
    return { order: [], active: null }
  }
  const tabs = Array.isArray(parsed.tabs) ? (parsed.tabs as SavedTab[]) : []
  const isOwnTask = (t: SavedTab | undefined): t is SavedTab & { taskId: string } =>
    !!t &&
    t.type === 'task' &&
    typeof t.taskId === 'string' &&
    (t.hubId === undefined || t.hubId === 'local')
  const order = tabs.filter(isOwnTask).map((t) => t.taskId)
  const activeTab =
    typeof parsed.activeTabIndex === 'number' ? tabs[parsed.activeTabIndex] : undefined
  return { order, active: isOwnTask(activeTab) ? activeTab.taskId : null }
}

/** The pass's order: the active task's tabs, then tab-bar order, then the rest. */
export function orderRestoreTabs(
  tabs: readonly AutoRestoreChatTab[],
  view: { order: readonly string[]; active: string | null }
): AutoRestoreChatTab[] {
  const rank = (taskId: string): number => {
    if (taskId === view.active) return -1
    const i = view.order.indexOf(taskId)
    return i === -1 ? view.order.length : i
  }
  return [...tabs]
    .map((tab, i) => ({ tab, i }))
    .sort((a, b) => rank(a.tab.taskId) - rank(b.tab.taskId) || a.i - b.i)
    .map(({ tab }) => tab)
}

async function liveChat(sessionId: string): Promise<boolean> {
  const chat = (await getPtyDeps().ops.chatList()).find((c) => c.sessionId === sessionId)
  return !!chat && chat.state !== 'dead'
}

type TabOutcome = 'started' | 'live' | 'elsewhere'

async function restoreTab(
  db: SlayzoneDb,
  tab: AutoRestoreChatTab,
  foreground: boolean,
  opts: AgentRestorePassOptions
): Promise<TabOutcome> {
  if (!(await opts.belongsHere(tab.taskId))) return 'elsewhere'
  const admission = foreground ? 'foreground' : 'restore'
  if (tab.isMain) {
    const result = await startMainAgent(
      db,
      { taskId: tab.taskId, admission, kind: 'chat' },
      opts.getTask
    )
    return result.started ? 'started' : 'live'
  }
  if (await liveChat(`${tab.taskId}:${tab.tabId}`)) return 'live'
  const launch = await resolveChatAgentLaunch(
    db,
    { taskId: tab.taskId, tabId: tab.tabId },
    opts.getTask
  )
  await getChatDeps().ops.start({ ...launch, reason: foreground ? 'user' : 'restore' })
  return 'started'
}

/** Restart the chat agents that ran at shutdown. Never throws; see the module doc. */
export async function restoreRunningChatAgents(
  db: SlayzoneDb,
  opts: AgentRestorePassOptions
): Promise<AgentRestorePassResult> {
  const now = opts.now ?? Date.now
  const startedAt = now()
  const result: AgentRestorePassResult = {
    tabs: 0,
    started: 0,
    alreadyLive: 0,
    elsewhere: 0,
    failed: 0,
    readyMs: [],
    totalMs: 0
  }
  let queue: AutoRestoreChatTab[]
  let active: string | null
  try {
    const saved = await db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [
      'viewState'
    ])
    const view = openTasksFromViewState(saved?.value)
    active = view.active
    queue = orderRestoreTabs(await listAutoRestoreChatTabs(db, new Set(view.order)), view)
  } catch (error) {
    recordDiagnosticEvent({
      level: 'warn',
      source: 'task',
      event: 'agent.restore_pass_failed',
      message: error instanceof Error ? error.message : String(error)
    })
    return result
  }
  result.tabs = queue.length
  const worker = async (): Promise<void> => {
    for (let tab = queue.shift(); tab; tab = queue.shift()) {
      try {
        const outcome = await restoreTab(db, tab, tab.taskId === active, opts)
        if (outcome === 'started') {
          result.started++
          result.readyMs.push(now() - startedAt)
        } else if (outcome === 'live') result.alreadyLive++
        else result.elsewhere++
      } catch (error) {
        result.failed++
        recordDiagnosticEvent({
          level: 'warn',
          source: 'task',
          event: 'agent.restore_failed',
          taskId: tab.taskId,
          message: error instanceof Error ? error.message : String(error),
          payload: { tabId: tab.tabId, isMain: tab.isMain }
        })
      }
    }
  }
  const width = Math.max(1, opts.concurrency ?? RESTORE_PASS_CONCURRENCY)
  await Promise.all(Array.from({ length: width }, worker))
  result.readyMs.sort((a, b) => a - b)
  result.totalMs = now() - startedAt
  const pct = (p: number): number | null =>
    result.readyMs.length
      ? result.readyMs[Math.min(result.readyMs.length - 1, Math.floor(result.readyMs.length * p))]
      : null
  recordDiagnosticEvent({
    level: 'info',
    source: 'task',
    event: 'agent.restore_pass',
    message: `restored ${result.started} of ${result.tabs} chat agents in ${result.totalMs}ms`,
    payload: {
      tabs: result.tabs,
      started: result.started,
      alreadyLive: result.alreadyLive,
      elsewhere: result.elsewhere,
      failed: result.failed,
      firstReadyMs: pct(0),
      p50ReadyMs: pct(0.5),
      p90ReadyMs: pct(0.9),
      lastReadyMs: result.readyMs.at(-1) ?? null,
      totalMs: result.totalMs
    }
  })
  return result
}
