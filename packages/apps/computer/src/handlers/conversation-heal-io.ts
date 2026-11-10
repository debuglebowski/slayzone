/**
 * What the session ledger's conversation heal reads on this computer (robustness
 * plan §9, P0): Claude's transcripts, the checkout's branch, Claude's retention
 * setting. Every folder the hub names is jailed to the allowed roots, exactly as
 * for `claudeSession.locate`; a folder outside them answers "unknown" (the heal
 * then keeps the id), never a read.
 *
 * @module computer/handlers/conversation-heal-io
 */
import type { ConversationHealIo } from '@slayzone/chat-runtime/server'
import {
  claudeTranscriptPath,
  claudeTranscriptRetentionMs,
  listClaudeTranscriptIds,
  locateClaudeTranscript,
  readClaudeTranscriptMeta
} from '@slayzone/terminal/claude-transcripts'
import { judgePath } from '../path-jail'
import { execGit } from './exec'
import type { HandlerContext } from './types'

export function createConversationHealIo(
  ctx: HandlerContext,
  getProjectPaths: () => { get(projectId: string): { path: string } | null } | null
): ConversationHealIo {
  // Read the jail through `ctx` on every call: `computer.setAllowedRoots` edits it live.
  const jail = (dir: string): string => judgePath(dir, ctx.config.allowedRoots)
  const isAllowedDir = (dir: string): boolean => {
    try {
      jail(dir)
      return true
    } catch {
      return false
    }
  }
  return {
    async locate({ cwd, projectId, sessionIds }) {
      const hint = cwd || (projectId ? getProjectPaths()?.get(projectId)?.path : undefined)
      let folder = ''
      if (hint) {
        try {
          folder = jail(hint)
        } catch {
          return null
        }
      }
      const out = new Map<string, { found: boolean }>()
      for (const id of sessionIds)
        out.set(id, { found: (await locateClaudeTranscript(id, folder, { isAllowedDir })) != null })
      return out
    },
    listTranscriptIds: async (cwd) => listClaudeTranscriptIds(jail(cwd)),
    readTranscriptMeta: async (cwd, id) =>
      readClaudeTranscriptMeta(claudeTranscriptPath(jail(cwd), id)),
    async currentBranch(cwd) {
      try {
        return (await execGit(['branch', '--show-current'], jail(cwd))).trim() || null
      } catch {
        return null
      }
    },
    retentionMs: claudeTranscriptRetentionMs
  }
}
