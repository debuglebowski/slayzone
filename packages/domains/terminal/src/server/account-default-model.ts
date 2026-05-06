import { promises as fs } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import {
  DEFAULT_CHAT_MODEL,
  normalizeAccountModel,
  type ChatModel,
} from '../shared/chat-model'

/**
 * Resolve what model the chat subprocess should default to when nothing is
 * stored on the task. Reads `~/.claude/settings.json` `model` field so a
 * Pro-tier user gets sonnet, a Max-tier user gets opus, etc. Falls back to
 * `DEFAULT_CHAT_MODEL` ('opus') when the file is missing, unparseable, has
 * no `model` key, or names a model we don't recognize.
 *
 * Caches result for the lifetime of the process — settings.json only
 * changes via `claude config` or manual edits, so a restart picks up
 * changes. Mirrors `auto-mode-eligibility.ts` precedent.
 */
let cached: ChatModel | null = null

export async function resolveAccountDefaultModel(): Promise<ChatModel> {
  if (cached) return cached
  cached = await read()
  return cached
}

/** Test-only: drop the in-process cache. */
export function _resetAccountDefaultModelCache(): void {
  cached = null
}

async function read(): Promise<ChatModel> {
  const home = os.homedir()
  const raw = await safeRead(path.join(home, '.claude', 'settings.json'))
  const settings = parseJson(raw)
  const model = pickString(settings, ['model'])
  if (model == null) return DEFAULT_CHAT_MODEL
  return normalizeAccountModel(model)
}

async function safeRead(p: string): Promise<string | null> {
  try {
    return await fs.readFile(p, 'utf-8')
  } catch {
    return null
  }
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function pickString(obj: unknown, keyPath: string[]): string | null {
  let cur: unknown = obj
  for (const k of keyPath) {
    if (cur == null || typeof cur !== 'object') return null
    cur = (cur as Record<string, unknown>)[k]
  }
  return typeof cur === 'string' ? cur : null
}
