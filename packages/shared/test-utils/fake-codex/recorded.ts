/**
 * What a recorded `codex app-server` transcript carried, decoded for client-side
 * tests: the items (as `item/started` / `item/completed` sent them), the server
 * requests (approvals) and any other notification. Cards and prompt views are
 * tested on these exact shapes instead of hand-written ones.
 *
 * @module test-utils/fake-codex/recorded
 */
import { readTranscript } from '../fake-cli/transcript'
import { codexTranscriptPath } from './transcript'

export interface RecordedCodexItem {
  type: string
  id: string
  [key: string]: unknown
}

export interface RecordedCodexMessage {
  method: string
  /** Set on server requests (approvals). */
  id?: number | string
  params: Record<string, unknown>
}

/** Every JSON-RPC message the CLI printed that has a `method`, in order. */
export function recordedCodexMessages(recipe: string): RecordedCodexMessage[] {
  const out: RecordedCodexMessage[] = []
  for (const rec of readTranscript(codexTranscriptPath(recipe))) {
    if (rec.kind !== 'stdout') continue
    let msg: unknown
    try {
      msg = JSON.parse(rec.line)
    } catch {
      continue
    }
    if (!msg || typeof msg !== 'object') continue
    const m = msg as { method?: unknown; id?: number | string; params?: unknown }
    if (typeof m.method !== 'string') continue
    out.push({
      method: m.method,
      ...(m.id !== undefined ? { id: m.id } : {}),
      params: (m.params && typeof m.params === 'object' ? m.params : {}) as Record<string, unknown>
    })
  }
  return out
}

/** The items of one phase (`started` / `completed`), optionally of one `type`. */
export function recordedCodexItems(
  recipe: string,
  phase: 'started' | 'completed',
  type?: string
): RecordedCodexItem[] {
  return recordedCodexMessages(recipe)
    .filter((m) => m.method === `item/${phase}`)
    .map((m) => m.params.item as RecordedCodexItem)
    .filter((it) => it && (type === undefined || it.type === type))
}

/** The server requests (approvals) the CLI sent, in order. */
export function recordedCodexRequests(recipe: string): RecordedCodexMessage[] {
  return recordedCodexMessages(recipe).filter((m) => m.id !== undefined)
}
