/**
 * The CLI's own session files (`<CLAUDE_CONFIG_DIR>/projects/<encoded cwd>/<id>.jsonl`)
 * as tests need them: seed a conversation a resume / import / hand-off starts
 * from, read one back, hash one to prove nothing wrote it. Not to be confused
 * with transcript.ts — those are RECORDINGS of a CLI's stdio.
 *
 * The fake writes session files only when `CLAUDE_CONFIG_DIR` is set (never into
 * the real ~/.claude); so must every test.
 *
 * @module test-utils/fake-claude/session-file
 */
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** The CLI's project-dir name for a cwd: every non-alphanumeric char → `-`. */
export function encodeSessionProjectDir(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, '-')
}

export function sessionFilePath(configDir: string, cwd: string, sessionId: string): string {
  return path.join(configDir, 'projects', encodeSessionProjectDir(cwd), `${sessionId}.jsonl`)
}

/** One turn of a seeded conversation. */
export interface SessionTurn {
  /** The user message (`uuid` defaults to a fresh one). */
  user: string
  userUuid?: string
  /** The assistant's text answer. */
  assistant: string
  assistantUuid?: string
  /** A tool call + its result between the message and the answer. */
  tool?: { id: string; name: string; input: Record<string, unknown>; result: string }
}

/**
 * Write a session file holding `turns` (one main chain, the way the CLI writes
 * one: `parentUuid` links, a non-chain record or two in between). Returns the
 * file and every uuid it used, in order.
 */
export function writeSessionFile(opts: {
  configDir: string
  cwd: string
  sessionId: string
  turns: SessionTurn[]
}): { file: string; userUuids: string[]; assistantUuids: string[] } {
  const file = sessionFilePath(opts.configDir, opts.cwd, opts.sessionId)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lines: string[] = []
  const userUuids: string[] = []
  const assistantUuids: string[] = []
  let parent: string | null = null
  let t = Date.parse('2026-10-01T10:00:00.000Z')
  const push = (record: Record<string, unknown>): void => {
    lines.push(JSON.stringify(record))
  }
  const chained = (record: Record<string, unknown>): void => {
    const uuid = (record.uuid as string | undefined) ?? randomUUID()
    t += 1000
    push({
      parentUuid: parent,
      isSidechain: false,
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      timestamp: new Date(t).toISOString(),
      ...record,
      uuid
    })
    parent = uuid
  }
  // Records the CLI writes that are not part of the conversation.
  push({ type: 'mode', mode: 'default' })
  for (const turn of opts.turns) {
    push({ type: 'queue-operation', operation: 'enqueue' })
    const userUuid = turn.userUuid ?? randomUUID()
    userUuids.push(userUuid)
    chained({ type: 'user', uuid: userUuid, message: { role: 'user', content: turn.user } })
    chained({ type: 'attachment', attachment: { type: 'context' } })
    if (turn.tool) {
      chained({
        type: 'assistant',
        message: {
          id: `msg_seed_${userUuids.length}_tool`,
          role: 'assistant',
          model: 'claude-haiku-5-5',
          content: [
            { type: 'tool_use', id: turn.tool.id, name: turn.tool.name, input: turn.tool.input }
          ]
        }
      })
      chained({
        type: 'user',
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: turn.tool.id, content: turn.tool.result }]
        }
      })
    }
    const assistantUuid = turn.assistantUuid ?? randomUUID()
    assistantUuids.push(assistantUuid)
    chained({
      type: 'assistant',
      uuid: assistantUuid,
      message: {
        id: `msg_seed_${userUuids.length}`,
        role: 'assistant',
        model: 'claude-haiku-5-5',
        content: [{ type: 'text', text: turn.assistant }]
      }
    })
    push({ type: 'last-prompt', lastPrompt: turn.user })
  }
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  return { file, userUuids, assistantUuids }
}

/** Every record of a session file (empty when it does not exist). */
export function readSessionFile(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

/** sha256 of a file, or null when it does not exist. */
export function fileSha256(file: string): string | null {
  if (!fs.existsSync(file)) return null
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}
