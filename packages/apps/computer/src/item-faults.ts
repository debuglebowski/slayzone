/** Machine journals remain on main; every store ledger/quarantine operation uses its owner. */
import { existsSync } from 'node:fs'
import type { OnlineComputerChatRuntime } from '@slayzone/chat-runtime/server'
import type { ItemFaultRef, ComputerFaultSnapshot } from '@slayzone/computers/shared'
import { listQuarantine, restoreQuarantine, discardQuarantine } from '@slayzone/platform/quarantine'
import { hookJournalPath, legacyHookJournalPath } from './hook-journal'
const MACHINE_PASSES = new Set(['computer-generations', 'computer-host-config'])
export function createComputerFaults(opts: {
  runtime(): OnlineComputerChatRuntime | Promise<OnlineComputerChatRuntime>
  runtimeDir: string
  hubUrl: string
}) {
  const own = new Set([
    hookJournalPath(opts.runtimeDir, opts.hubUrl),
    legacyHookJournalPath(opts.runtimeDir, opts.hubUrl)
  ])
  const visible = (entry: ReturnType<typeof listQuarantine>[number]) =>
    MACHINE_PASSES.has(entry.pass) || (!!entry.meta && own.has(entry.meta.originalPath))
  const root = (key: string) => {
    const [tag, id] = key.split(':', 2)
    const entry =
      tag === 'runtime' && id
        ? listQuarantine(opts.runtimeDir).find((e) => e.id === id && visible(e))
        : null
    if (!entry) throw new Error('No such quarantined item')
    return entry
  }
  return {
    async list(): Promise<ComputerFaultSnapshot> {
      const r = await opts.runtime(),
        stored = await r.faults.list()
      const machine = listQuarantine(opts.runtimeDir)
        .filter(visible)
        .map((entry) => ({
          source: 'quarantine' as const,
          pass: entry.pass,
          key: `runtime:${entry.id}`,
          taskId: entry.meta?.taskId ?? null,
          kind: 'structural' as const,
          message: entry.meta?.reason ?? 'Unreadable item set aside',
          attempts: 1,
          firstAt: entry.meta?.at ?? 0,
          lastAt: entry.meta?.at ?? 0,
          retryable: !!entry.meta && !existsSync(entry.meta.originalPath),
          discardable: true
        }))
      return { faults: [...machine, ...stored.faults] }
    },
    async retry(ref: Pick<ItemFaultRef, 'source' | 'pass' | 'key'>) {
      if (ref.source === 'quarantine' && ref.key.startsWith('runtime:')) {
        const entry = root(ref.key)
        if (!restoreQuarantine(opts.runtimeDir, entry.pass, entry.id))
          throw new Error('Something new already exists where this item came from')
        return
      }
      await (await opts.runtime()).faults.retry(ref)
    },
    async discard(ref: Pick<ItemFaultRef, 'source' | 'pass' | 'key'>) {
      if (ref.source === 'quarantine' && ref.key.startsWith('runtime:')) {
        const entry = root(ref.key)
        discardQuarantine(opts.runtimeDir, entry.pass, entry.id)
        return
      }
      await (await opts.runtime()).faults.discard(ref)
    }
  }
}
