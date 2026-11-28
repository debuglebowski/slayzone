import { hubUrlFromAddr } from '@slayzone/platform/hub-addr'

/**
 * The Expo Push Service's HTTP API (https://docs.expo.dev/push-notifications/sending-notifications/):
 * `send` hands messages over and gets one ticket each; `receipts` later tells whether
 * Apple took them. No access token: the hub holds only the phones' Expo tokens.
 *
 * `address` is an authority (`exp.host`, or a fake on loopback in tests): the scheme
 * follows from the host (env rule 5).
 */

export interface ExpoPushMessage {
  to: string
  title?: string
  body?: string
  data?: object
  sound?: 'default' | null
  /** Lets the phone's notification service extension rewrite it (the summary style). */
  mutableContent?: boolean
  badge?: number
}

export type ExpoPushTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message: string; details?: { error?: string } }

export type ExpoPushReceipt =
  | { status: 'ok' }
  | { status: 'error'; message: string; details?: { error?: string } }

export interface ExpoPushClient {
  /** One ticket per message, in order. Throws when the request itself fails. */
  send(messages: readonly ExpoPushMessage[]): Promise<ExpoPushTicket[]>
  /** Receipts of these tickets; a ticket not ready yet is absent. */
  receipts(ids: readonly string[]): Promise<Record<string, ExpoPushReceipt>>
}

/** Expo's limit per request. */
const BATCH = 100

export function createExpoPushClient(opts: {
  address: string
  fetch?: typeof fetch
}): ExpoPushClient {
  const doFetch = opts.fetch ?? fetch

  async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await doFetch(hubUrlFromAddr(opts.address, 'http', path), {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) throw new Error(`push service answered ${res.status}`)
    const json = (await res.json()) as { data?: T; errors?: { message?: string }[] }
    if (json.errors?.length) {
      throw new Error(`push service refused: ${json.errors.map((e) => e.message).join('; ')}`)
    }
    if (json.data === undefined) throw new Error('push service answered without data')
    return json.data
  }

  return {
    async send(messages) {
      const tickets: ExpoPushTicket[] = []
      for (let i = 0; i < messages.length; i += BATCH) {
        const batch = messages.slice(i, i + BATCH)
        const out = await post<ExpoPushTicket[]>('/--/api/v2/push/send', batch)
        if (out.length !== batch.length) throw new Error('push service lost tickets')
        tickets.push(...out)
      }
      return tickets
    },
    async receipts(ids) {
      const out: Record<string, ExpoPushReceipt> = {}
      for (let i = 0; i < ids.length; i += 1000) {
        Object.assign(
          out,
          await post<Record<string, ExpoPushReceipt>>('/--/api/v2/push/getReceipts', {
            ids: ids.slice(i, i + 1000)
          })
        )
      }
      return out
    }
  }
}
