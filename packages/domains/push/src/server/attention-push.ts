import type { SlayzoneDb } from '@slayzone/platform'
import type { AttentionPushData, PushKind } from '../index'
import { forgetToken, markDelivered, pushRecipients } from './device-store'
import type { ExpoPushClient, ExpoPushMessage } from './expo-client'

/**
 * Phone notifications for the hub's one "needs attention" edge: `@slayzone/task`
 * attention.ts sets `needs_attention` when a turn the user started ends (`→ idle`)
 * or fails (`→ error`), and the hub calls {@link AttentionPush.onAttentionSet} right
 * then. The 🔔 sheet, desktop's dots and the phone are therefore told by one fact.
 *
 * WHO: the person whose agent it is — the tab's owner (`terminal_tabs.owner_user_id`;
 * a computer-resident session is one user's, T-100), else the project owner (the main
 * tab's row is created lazily). Plus phones registered without login (user ''), which
 * exist only on a hub with one person.
 *
 * At most one notification per task per `debounceMs`, so a chatty agent does not
 * buzz the phone. Never throws: a push failure must not disturb the state-change
 * chain it runs in; it is recorded instead.
 */

export interface AttentionPush {
  onAttentionSet(sessionId: string, state: 'idle' | 'error'): Promise<void>
}

export interface PushDiagnosticEvent {
  level: 'info' | 'warn' | 'error'
  event: 'push.sent' | 'push.failed' | 'push.device_forgotten'
  taskId?: string
  message: string
  payload?: Record<string, unknown>
}

/** Expo has receipts ready within ~15 minutes. */
const RECEIPT_DELAY_MS = 15 * 60_000

const LABEL: Record<PushKind, string> = { ready: 'Ready for review', error: 'Error' }

export function createAttentionPush(deps: {
  db: SlayzoneDb
  client: ExpoPushClient
  /** `SLAYZONE_HUB_ENABLE_PUSH`, read per call. */
  enabled: () => boolean
  now?: () => number
  debounceMs?: number
  schedule?: (fn: () => void, ms: number) => void
  record?: (event: PushDiagnosticEvent) => void
}): AttentionPush {
  const now = deps.now ?? Date.now
  const debounceMs = deps.debounceMs ?? 30_000
  const schedule =
    deps.schedule ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref?.()
    })
  const record = deps.record ?? ((): void => undefined)
  const lastSent = new Map<string, number>()

  async function recipientsOf(taskId: string, tabId: string): Promise<string[]> {
    const tab = await deps.db.get<{ owner_user_id: string | null }>(
      'SELECT owner_user_id FROM terminal_tabs WHERE id = ? AND task_id = ?',
      [tabId, taskId]
    )
    const project = await deps.db.get<{ owner_user_id: string | null }>(
      'SELECT p.owner_user_id FROM tasks t JOIN projects p ON p.id = t.project_id WHERE t.id = ?',
      [taskId]
    )
    const owner = tab?.owner_user_id ?? project?.owner_user_id ?? null
    return owner ? [owner, ''] : ['']
  }

  async function checkReceipts(byTicket: Map<string, string>, taskId: string): Promise<void> {
    try {
      const receipts = await deps.client.receipts([...byTicket.keys()])
      for (const [id, receipt] of Object.entries(receipts)) {
        if (receipt.status === 'error' && receipt.details?.error === 'DeviceNotRegistered') {
          await forgetToken(deps.db, byTicket.get(id)!)
          record({
            level: 'info',
            event: 'push.device_forgotten',
            taskId,
            message: 'receipt: device not registered'
          })
        }
      }
    } catch (err) {
      record({
        level: 'warn',
        event: 'push.failed',
        taskId,
        message: `receipts: ${(err as Error).message}`
      })
    }
  }

  return {
    async onAttentionSet(sessionId, state) {
      const at = sessionId.indexOf(':')
      const taskId = at === -1 ? sessionId : sessionId.slice(0, at)
      const tabId = at === -1 ? sessionId : sessionId.slice(at + 1)
      if (!taskId || !deps.enabled()) return
      const t = now()
      const last = lastSent.get(taskId)
      if (last !== undefined && t - last < debounceMs) return

      try {
        const task = await deps.db.get<{
          title: string
          project_id: string
          project_name: string | null
        }>(
          `SELECT t.title, t.project_id, p.name AS project_name
             FROM tasks t LEFT JOIN projects p ON p.id = t.project_id WHERE t.id = ?`,
          [taskId]
        )
        if (!task) return
        const kind: PushKind = state === 'error' ? 'error' : 'ready'
        const recipients = await pushRecipients(deps.db, await recipientsOf(taskId, tabId), kind)
        if (recipients.length === 0) return
        lastSent.set(taskId, t)

        const messages: ExpoPushMessage[] = recipients.map((r) => ({
          to: r.token,
          title: task.title,
          body: `${task.project_name ?? 'Unknown project'} · ${LABEL[kind]}`,
          sound: 'default',
          mutableContent: true,
          data: {
            kind: 'attention',
            state: kind,
            taskId,
            projectId: task.project_id,
            hubRef: r.hubRef
          } satisfies AttentionPushData
        }))
        const tickets = await deps.client.send(messages)

        const delivered: string[] = []
        const byTicket = new Map<string, string>()
        for (const [i, ticket] of tickets.entries()) {
          const to = messages[i].to
          if (ticket.status === 'ok') {
            delivered.push(to)
            byTicket.set(ticket.id, to)
          } else if (ticket.details?.error === 'DeviceNotRegistered') {
            await forgetToken(deps.db, to)
            record({
              level: 'info',
              event: 'push.device_forgotten',
              taskId,
              message: ticket.message
            })
          } else {
            record({ level: 'warn', event: 'push.failed', taskId, message: ticket.message })
          }
        }
        await markDelivered(deps.db, delivered)
        record({
          level: 'info',
          event: 'push.sent',
          taskId,
          message: `${kind}: ${delivered.length}/${messages.length} accepted`,
          payload: { kind, phones: messages.length, accepted: delivered.length }
        })
        if (byTicket.size > 0) {
          schedule(() => void checkReceipts(byTicket, taskId), RECEIPT_DELAY_MS)
        }
      } catch (err) {
        record({ level: 'error', event: 'push.failed', taskId, message: (err as Error).message })
      }
    }
  }
}
