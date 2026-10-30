/**
 * Read a Claude Code conversation's history from its session file — here, on the
 * computer the agent runs on, where the file and the agent's cwd are.
 *
 * The chat shows a conversation it resumes (Sessions picker, "Continue in chat"
 * from the terminal) from the CLI's own record, the session file
 * `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded cwd>/<sessionId>.jsonl`.
 * Only that file can be read: the path is built from a jailed cwd and a uuid.
 *
 * The file is append-only and holds a tree: a rewind does not rewrite it, the
 * next record just points its `parentUuid` at an earlier one. The conversation is
 * the ACTIVE branch — from the last main-chain user/assistant record back through
 * `parentUuid` (every record kind is a link; past a compaction through
 * `logicalParentUuid`). Two passes keep memory small: links first, then only the
 * records of the branch.
 *
 * @module computer/handlers/claude-session
 */

import { createReadStream, existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import {
  claudeSessionReadParamsSchema,
  HubToComputerMethods,
  type ClaudeSessionReadResult
} from '@slayzone/computer-transport/shared'
import { assertPathAllowed } from '../config'
import type { HandlerContext, HubMethodTable } from './types'

/** A record bigger than this has its tool-result text shortened. */
const LARGE_RECORD_BYTES = 32 * 1024
/** What a shortened tool-result text keeps. */
const KEEP_TOOL_TEXT = 8 * 1024

interface Link {
  parent: string | null
  /** A user / assistant / compaction record of the main chain: part of the conversation. */
  content: boolean
}

/** The CLI's project-dir name for a cwd: every non-alphanumeric char becomes `-`. */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
}

/** The session file: under the cwd's real path (what the CLI sees), else as given. */
function sessionFile(cwd: string, sessionId: string): string | null {
  const candidates = new Set<string>()
  try {
    candidates.add(realpathSync(cwd))
  } catch {
    // The cwd is gone; the CLI may still have recorded it as given.
  }
  candidates.add(cwd)
  for (const dir of candidates) {
    const file = join(claudeConfigDir(), 'projects', encodeProjectDir(dir), `${sessionId}.jsonl`)
    if (existsSync(file)) return file
  }
  return null
}

async function* records(file: string): AsyncGenerator<Record<string, unknown>> {
  const input = createReadStream(file, { encoding: 'utf8' })
  const rl = createInterface({ input, crlfDelay: Infinity })
  try {
    for await (const line of rl) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const rec = JSON.parse(trimmed) as unknown
        if (rec && typeof rec === 'object' && !Array.isArray(rec)) {
          yield rec as Record<string, unknown>
        }
      } catch {
        // A line the CLI is still writing.
      }
    }
  } finally {
    rl.close()
    input.destroy()
  }
}

function isContent(rec: Record<string, unknown>): boolean {
  if (rec.isSidechain === true) return false
  if (rec.type === 'user' || rec.type === 'assistant') return true
  return rec.type === 'system' && rec.subtype === 'compact_boundary'
}

/** A record with an oversized tool-result text, shortened (the reply still reads). */
function shortened(rec: Record<string, unknown>): Record<string, unknown> {
  if (JSON.stringify(rec).length <= LARGE_RECORD_BYTES) return rec
  const message = rec.message as { content?: unknown } | undefined
  if (!message || !Array.isArray(message.content)) return rec
  const cut = (text: string): string =>
    text.length > KEEP_TOOL_TEXT ? `${text.slice(0, KEEP_TOOL_TEXT)}\n… (shortened)` : text
  const content = message.content.map((block: unknown) => {
    const b = block as { type?: unknown; content?: unknown }
    if (b?.type !== 'tool_result') return block
    if (typeof b.content === 'string') return { ...b, content: cut(b.content) }
    if (Array.isArray(b.content)) {
      return {
        ...b,
        content: b.content.map((part: unknown) => {
          const p = part as { type?: unknown; text?: unknown }
          return p?.type === 'text' && typeof p.text === 'string'
            ? { ...p, text: cut(p.text) }
            : part
        })
      }
    }
    return block
  })
  // The structured copy of the same output would undo the shortening.
  const { toolUseResult: _structured, ...rest } = rec
  void _structured
  return { ...rest, message: { ...message, content } }
}

export function createClaudeSessionHandlers(
  ctx: HandlerContext,
  getProjectPaths: () => { get(projectId: string): { path: string } | null } | null
): HubMethodTable {
  async function read(rawParams: unknown): Promise<ClaudeSessionReadResult> {
    const params = claudeSessionReadParamsSchema.parse(rawParams)
    const resolved =
      params.cwd ?? (params.projectId ? getProjectPaths()?.get(params.projectId)?.path : undefined)
    if (!resolved) throw new Error('claudeSession.read: no cwd for this session')
    const cwd = assertPathAllowed(resolved, ctx.config.allowedRoots)
    const file = sessionFile(cwd, params.sessionId)
    if (!file) return { found: false, records: [], omitted: 0 }

    // Pass 1: the links, and the branch's leaf.
    const links = new Map<string, Link>()
    let leaf: string | null = null
    for await (const rec of records(file)) {
      if (typeof rec.uuid !== 'string') continue
      const parent =
        typeof rec.parentUuid === 'string'
          ? rec.parentUuid
          : typeof rec.logicalParentUuid === 'string'
            ? rec.logicalParentUuid
            : null
      const content = isContent(rec)
      links.set(rec.uuid, { parent, content })
      if (content && rec.type !== 'system') leaf = rec.uuid
    }
    const branch: string[] = []
    const seen = new Set<string>()
    for (let at = leaf; at && !seen.has(at); at = links.get(at)?.parent ?? null) {
      seen.add(at)
      if (links.get(at)?.content) branch.push(at)
    }
    branch.reverse()
    const wanted = new Set(branch.slice(-params.maxRecords))

    // Pass 2: those records.
    const byUuid = new Map<string, Record<string, unknown>>()
    for await (const rec of records(file)) {
      if (typeof rec.uuid === 'string' && wanted.has(rec.uuid)) byUuid.set(rec.uuid, shortened(rec))
    }
    const picked: Array<Record<string, unknown>> = []
    let bytes = 0
    for (let i = branch.length - 1; i >= 0 && picked.length < params.maxRecords; i--) {
      const rec = byUuid.get(branch[i])
      if (!rec) continue
      const size = JSON.stringify(rec).length
      if (bytes + size > params.maxBytes) break
      bytes += size
      picked.push(rec)
    }
    picked.reverse()
    return { found: true, records: picked, omitted: branch.length - picked.length }
  }

  return { [HubToComputerMethods.claudeSessionRead]: read }
}
