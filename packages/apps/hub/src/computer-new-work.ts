/**
 * What counts as NEW WORK on a computer, and how much work runs on one right now —
 * the two questions behind disabling a computer (`computers.setDisabled`).
 *
 * A disabled computer stays enrolled and connected: the hub keeps reading from it,
 * keeps its maintenance loops, and may still stop what runs there. It refuses only
 * requests that START something — a terminal, an agent, a process, a worktree, a chat
 * turn. {@link startsNewWork} is that classification, applied in the gateway's
 * `beforeRequest` (composition), the single choke point every hub → computer request
 * passes, so an explicit binding, a resumed conversation's owner, or a spawn spec that
 * arrived some other way is refused just the same.
 *
 * Chat is classified FAIL-CLOSED: a chat command is new work unless it is a read or
 * one that stops or clears something, so an operation added later is refused on a
 * disabled computer until someone decides otherwise. `bootstrap` (sync of a tab's
 * settings) and every non-`invoke` request (backups, inventory, archives, …) pass.
 *
 * @module hub/computer-new-work
 */
import { HubToComputerMethods } from '@slayzone/computer-transport/shared'
import type { HubComputerGateway } from '@slayzone/computer-transport/server'
import { CHAT_READ_OPERATIONS, type ChatOperation } from '@slayzone/chat-runtime/shared'

/** Methods that start something on the computer, whatever their params. */
const NEW_WORK_METHODS: ReadonlySet<string> = new Set([
  HubToComputerMethods.ptySpawn,
  HubToComputerMethods.ptyWarmSpawn,
  HubToComputerMethods.ptyWarmAdopt,
  HubToComputerMethods.procSpawn,
  HubToComputerMethods.gitCreateWorktree,
  HubToComputerMethods.gitRunWorktreeSetupScript,
  HubToComputerMethods.gitCopyIgnoredFiles,
  HubToComputerMethods.slaySetup,
  HubToComputerMethods.ghExec
])

/** Chat commands that only stop, release or restore — never start — something. */
const CHAT_STOP_OPERATIONS: ReadonlySet<string> = new Set<string>([
  'interrupt',
  'abortAndPop',
  'stopCommandTask',
  'stopSubAgent',
  'cancelSideQuestion',
  'releaseConversation',
  'refuseStart',
  'hydrate',
  'kill'
])

/** Queue commands that only read or shrink the queue. */
const CHAT_QUEUE_STOP_OPERATIONS: ReadonlySet<string> = new Set([
  'list',
  'remove',
  'clear',
  'hold',
  'cancelReservation'
])

function chatStartsNewWork(params: unknown): boolean {
  if (!params || typeof params !== 'object') return false
  const body = params as { kind?: unknown; value?: unknown }
  if (body.kind !== 'invoke') return false
  const call = body.value as { target?: unknown; method?: unknown } | null | undefined
  const method = typeof call?.method === 'string' ? call.method : ''
  if (call?.target === 'queue') return !CHAT_QUEUE_STOP_OPERATIONS.has(method)
  return !(CHAT_READ_OPERATIONS.has(method as ChatOperation) || CHAT_STOP_OPERATIONS.has(method))
}

/** Whether a hub → computer request starts new work (refused on a disabled computer). */
export function startsNewWork(method: string, params: unknown): boolean {
  if (NEW_WORK_METHODS.has(method)) return true
  if (method === HubToComputerMethods.chatRequest) return chatStartsNewWork(params)
  return false
}

/** Chat session states in which nothing runs. */
const IDLE_CHAT_STATES = new Set(['not-spawned', 'dead', 'error'])

/**
 * How many terminals and agents run on a computer right now: its live ptys, less the
 * pre-warmed agents nobody has adopted (the hub's pool, not anyone's work), plus its
 * chat sessions that are not idle. 0 for a computer that is not connected — nothing
 * can run there. Asks the computer itself, which owns every process; a failed
 * question throws rather than reading as "nothing runs".
 */
export async function countRunningWork(
  gateway: {
    listComputers(): ReadonlyArray<{ computerId: string }>
    request: HubComputerGateway['request']
  },
  computerId: string
): Promise<number> {
  if (!gateway.listComputers().some((c) => c.computerId === computerId)) return 0
  const [ptys, warms, chats] = await Promise.all([
    gateway.request<{ sessions: Array<{ sessionId: string }> }>(
      computerId,
      HubToComputerMethods.ptyList,
      {}
    ),
    gateway.request<{ warms: Array<{ warmId: string }> }>(
      computerId,
      HubToComputerMethods.ptyWarmList,
      {}
    ),
    gateway.request<Array<{ state: string }>>(computerId, HubToComputerMethods.chatRequest, {
      kind: 'sessions'
    })
  ])
  const warm = new Set(warms.warms.map((w) => w.warmId))
  const terminals = ptys.sessions.filter((s) => !warm.has(s.sessionId)).length
  const agents = chats.filter((s) => !IDLE_CHAT_STATES.has(s.state)).length
  return terminals + agents
}
