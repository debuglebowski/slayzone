/**
 * `@slayzone/usage-analytics/collect`: parse the agents' usage logs on THIS machine
 * (`~/.claude`, `~/.codex`, OpenCode, Qwen) from the given cursors — only what is
 * new since each file's last offset. The computer runs it for the hub
 * (`usage.collect`); the hub runs it itself only with no computer routing.
 *
 * Lean: fs + readline only — no DB.
 */
import { parseClaudeFiles, type ParseResult } from './parsers/claude'
import { parseCodexFiles } from './parsers/codex'
import { parseOpenCodeFiles } from './parsers/opencode'
import { parseQwenFiles } from './parsers/qwen'

export type { ParseResult }

/** Per log file: where the last parse stopped, and the mtime it saw then. */
export type UsageCursors = Record<string, { offset: number; modifiedMs: number }>

export async function collectUsage(cursors: UsageCursors): Promise<ParseResult[]> {
  const getOffset = (filePath: string) => cursors[filePath]
  const all = await Promise.all([
    parseClaudeFiles(getOffset),
    parseCodexFiles(getOffset),
    parseOpenCodeFiles(getOffset),
    parseQwenFiles(getOffset)
  ])
  return all.flat()
}
