/**
 * This computer's Needs-attention faults (P3), for its hub: the chat store's
 * fault ledger (`item_faults`) plus quarantined files. Two quarantine roots:
 *
 * - the hub's chat store dir (unreadable archives, artifact journals), and
 * - the computer runtime dir (hook journals, startup files). That dir is shared by
 *   every hub this computer serves, so a hub sees only machine-wide startup files
 *   and its OWN hook journal's entries — never another hub's.
 *
 * Retry runs an item again now; Discard permanently deletes it (the client asks
 * for confirmation first).
 */
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import type { createComputerChatRuntime } from '@slayzone/chat-runtime/server'
import type { ComputerFaultSnapshot, ItemFaultRef } from '@slayzone/computers/shared'
import {
  discardQuarantine,
  listQuarantine,
  restoreQuarantine,
  type QuarantineEntry
} from '@slayzone/platform/quarantine'
import { existsSync } from 'node:fs'
import { hookJournalPath, legacyHookJournalPath } from './hook-journal'

type Runtime = ReturnType<typeof createComputerChatRuntime>

/** Startup files of the whole machine (session host), visible to every hub. */
const MACHINE_PASSES = new Set(['computer-generations', 'computer-host-config'])
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Ledger passes whose item can be discarded, and how (permanent delete). */
function ledgerDiscard(r: Runtime, pass: string, key: string): boolean {
  if (pass === 'chat-archive-index' || pass === 'chat-archive-erasure') {
    if (!UUID.test(key)) return false
    rmSync(join(r.backups.archiveDir, key), { recursive: true, force: true })
    return true
  }
  return false
}

/** Ledger passes that can be re-run right away (others run on their next pass). */
function kick(r: Runtime, pass: string): void {
  if (pass === 'computer.task-file-cleanup') r.artifacts.cleanupDeletedTasks()
  else if (pass === 'computer.chat-retention')
    void r.retention.runNow().catch((error: unknown) => {
      console.error('[chat-retention] retry failed:', error)
    })
}

export function createComputerFaults(opts: {
  runtime: () => Runtime
  runtimeDir: string
  hubUrl: string
}) {
  const ownJournals = new Set([
    hookJournalPath(opts.runtimeDir, opts.hubUrl),
    legacyHookJournalPath(opts.runtimeDir, opts.hubUrl)
  ])
  const roots = () => [
    { tag: 'store', dir: opts.runtime().storage.dir, visible: (_e: QuarantineEntry) => true },
    {
      tag: 'runtime',
      dir: opts.runtimeDir,
      visible: (e: QuarantineEntry) =>
        MACHINE_PASSES.has(e.pass) || (!!e.meta && ownJournals.has(e.meta.originalPath))
    }
  ]
  function root(key: string) {
    const [tag, id] = key.split(':', 2)
    const found = roots().find((r) => r.tag === tag)
    if (!found || !id) throw new Error('No such quarantined item')
    const entry = listQuarantine(found.dir).find((e) => e.id === id)
    if (!entry || !found.visible(entry)) throw new Error('No such quarantined item')
    return { dir: found.dir, entry }
  }
  return {
    list(): ComputerFaultSnapshot {
      const r = opts.runtime()
      const ledger = r.storage.listFaults().map((row) => ({
        source: 'ledger' as const,
        pass: row.pass,
        key: row.item_key,
        taskId: row.task_id,
        kind: row.kind,
        message: row.message,
        attempts: row.attempts,
        firstAt: row.first_at,
        lastAt: row.last_at,
        retryable: true,
        discardable: row.pass === 'chat-archive-index' || row.pass === 'chat-archive-erasure'
      }))
      const quarantined = roots().flatMap(({ tag, dir, visible }) =>
        listQuarantine(dir)
          .filter(visible)
          .map((entry) => ({
            source: 'quarantine' as const,
            pass: entry.pass,
            key: `${tag}:${entry.id}`,
            taskId: entry.meta?.taskId ?? null,
            kind: 'structural' as const,
            message: entry.meta?.reason ?? 'Unreadable item set aside',
            attempts: 1,
            firstAt: entry.meta?.at ?? 0,
            lastAt: entry.meta?.at ?? 0,
            retryable: !!entry.meta && !existsSync(entry.meta.originalPath),
            discardable: true
          }))
      )
      return { faults: [...quarantined, ...ledger] }
    },
    retry(ref: Pick<ItemFaultRef, 'source' | 'pass' | 'key'>): void {
      if (ref.source === 'quarantine') {
        const { dir, entry } = root(ref.key)
        if (!restoreQuarantine(dir, entry.pass, entry.id))
          throw new Error('Something new already exists where this item came from')
        return
      }
      const r = opts.runtime()
      if (!r.storage.retryFault(ref.pass, ref.key)) throw new Error('No such fault')
      kick(r, ref.pass)
    },
    discard(ref: Pick<ItemFaultRef, 'source' | 'pass' | 'key'>): void {
      if (ref.source === 'quarantine') {
        const { dir, entry } = root(ref.key)
        discardQuarantine(dir, entry.pass, entry.id)
        return
      }
      const r = opts.runtime()
      if (!ledgerDiscard(r, ref.pass, ref.key))
        throw new Error('This item cannot be discarded; use Retry')
      r.storage.deleteFault(ref.pass, ref.key)
    }
  }
}
