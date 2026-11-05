/**
 * Read a Claude Code conversation's history from its session file — here, on the
 * computer the agent runs on, where the file and the agent's cwd are.
 *
 * The chat shows a conversation it resumes (Sessions picker, "Continue in chat"
 * from the terminal) from the CLI's own record, the session file
 * `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<encoded cwd>/<sessionId>.jsonl` —
 * or another project dir when the session moved folders (EnterWorktree keeps the
 * file only under the worktree's). Only a `<uuid>.jsonl` under the CLI's projects
 * dir can be read; the hint cwd is jailed.
 *
 * `claudeSession.locate` answers, for the hub's conversation healer and resume,
 * whether a session's file exists here and which folder to resume it from.
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

import { createReadStream } from 'node:fs'
import { createInterface } from 'node:readline'
import {
  claudeSessionLocateParamsSchema,
  claudeSessionReadParamsSchema,
  HubToComputerMethods,
  type ClaudeSessionLocateResult,
  type ClaudeSessionReadResult
} from '@slayzone/computer-transport/shared'
import { locateClaudeTranscript } from '@slayzone/terminal/claude-transcripts'
import { judgePath } from '../path-jail'
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
  const hintFolder = (params: { cwd?: string; projectId?: string }): string | undefined =>
    params.cwd ?? (params.projectId ? getProjectPaths()?.get(params.projectId)?.path : undefined)
  const isAllowedDir = (dir: string): boolean => {
    try {
      judgePath(dir, ctx.config.allowedRoots)
      return true
    } catch {
      return false
    }
  }

  async function locate(rawParams: unknown): Promise<ClaudeSessionLocateResult> {
    const params = claudeSessionLocateParamsSchema.parse(rawParams)
    const resolved = hintFolder(params)
    // No folder known is fine: ids are unique, so they are still found.
    const cwd = resolved ? judgePath(resolved, ctx.config.allowedRoots) : ''
    const sessions: ClaudeSessionLocateResult['sessions'] = []
    for (const sessionId of params.sessionIds) {
      const found = await locateClaudeTranscript(sessionId, cwd, { isAllowedDir })
      sessions.push({ sessionId, found: found != null, resumeCwd: found?.resumeCwd ?? null })
    }
    return { sessions }
  }

  async function read(rawParams: unknown): Promise<ClaudeSessionReadResult> {
    const params = claudeSessionReadParamsSchema.parse(rawParams)
    const resolved = hintFolder(params)
    if (!resolved) throw new Error('claudeSession.read: no cwd for this session')
    const cwd = judgePath(resolved, ctx.config.allowedRoots)
    const file = (await locateClaudeTranscript(params.sessionId, cwd))?.path
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

  return {
    [HubToComputerMethods.claudeSessionRead]: read,
    [HubToComputerMethods.claudeSessionLocate]: locate
  }
}
