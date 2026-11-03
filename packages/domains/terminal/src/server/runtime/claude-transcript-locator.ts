import { locateClaudeTranscript } from '../claude-transcripts'

/**
 * "Is this Claude conversation's transcript on disk, and which folder do I resume
 * it from?" — answered on the machine that owns the disk.
 *
 * A session that used EnterWorktree keeps its transcript only under the
 * worktree's project dir, so a lookup in the task folder alone wrongly reads
 * "never written" and the healer started a fresh session over a live
 * conversation (2026-11-03, task 5c34ebb9). The lookup must also run on the
 * agent's COMPUTER, not the hub: the hub's disk is not where a remote agent's
 * transcripts are.
 *
 * Hub-local spawns (`computerId == null`) read this process's disk. Computer
 * spawns go through the locator the composition root wires
 * (`claudeSession.locate`). No locator, or a failed call (an older computer
 * without the method, a dropped socket), answers null = UNKNOWN. Callers must
 * treat unknown as "may exist": never start fresh on it.
 */

export interface ClaudeTranscriptLocateRequest {
  taskId: string
  computerId: string | null
  projectId: string | null
  /** The spawn folder ('' = none known; the computer resolves the project's). */
  cwd: string
  sessionIds: string[]
}

export interface ClaudeTranscriptLocated {
  found: boolean
  /** A different folder to resume from, or null = the spawn folder. */
  resumeCwd: string | null
}

export type ClaudeTranscriptLocator = (
  req: ClaudeTranscriptLocateRequest
) => Promise<Array<{ sessionId: string } & ClaudeTranscriptLocated>>

let locator: ClaudeTranscriptLocator | null = null

export function setClaudeTranscriptLocator(fn: ClaudeTranscriptLocator | null): void {
  locator = fn
}

/** Located ids (an id missing from the map is unknown), or null when unknown altogether. */
export async function locateClaudeTranscripts(
  req: ClaudeTranscriptLocateRequest
): Promise<Map<string, ClaudeTranscriptLocated> | null> {
  const out = new Map<string, ClaudeTranscriptLocated>()
  if (req.sessionIds.length === 0) return out
  try {
    if (req.computerId == null) {
      for (const id of req.sessionIds) {
        const found = await locateClaudeTranscript(id, req.cwd)
        out.set(id, { found: found != null, resumeCwd: found?.resumeCwd ?? null })
      }
      return out
    }
    if (!locator) return null
    for (const s of await locator(req)) {
      out.set(s.sessionId, { found: s.found, resumeCwd: s.resumeCwd })
    }
    return out
  } catch {
    return null
  }
}
