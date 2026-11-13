import type { useTRPCClient } from '../trpc'

type TRPCClient = ReturnType<typeof useTRPCClient>

/**
 * One `chat.getInfo` request for every reader of the same tab that asks in the
 * same turn.
 *
 * A chat panel's five setting pills (mode, model, effort, collaboration, fast
 * mode) each hydrate from `chat.getInfo` — on mount, and again whenever the
 * task's saved settings change (`useChatSettingsGeneration`). Their effects run
 * in one commit, so each hydration used to be five identical hub → computer
 * reads. Restoring ~36 chat tabs at boot (2026-11-11) sent ~2,100 of them,
 * queued on the computer in front of the reads that start the agents.
 *
 * A read is shared only by callers in the same synchronous turn (one commit's
 * effects) and the same settings generation. A later caller — a remount, a
 * retry, a re-read after a settings change — always sends its own request, so
 * it can never join a stale or stuck one.
 */
const sharedThisTurn = new WeakMap<TRPCClient, Map<string, Promise<unknown>>>()

export function readChatInfo(
  client: TRPCClient,
  tabId: string,
  mode: string,
  generation: number
): Promise<unknown> {
  let reads = sharedThisTurn.get(client)
  if (!reads) {
    reads = new Map()
    sharedThisTurn.set(client, reads)
  }
  const key = JSON.stringify([tabId, mode, generation])
  const existing = reads.get(key)
  if (existing) return existing
  const read: Promise<unknown> = client.chat.getInfo.query({ tabId, mode })
  reads.set(key, read)
  const turn = reads
  queueMicrotask(() => {
    if (turn.get(key) === read) turn.delete(key)
  })
  return read
}
