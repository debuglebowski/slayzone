import { useMemo, useState } from 'react'
import { useStableCallback } from '@slayzone/ui'
import { useAgentPrompts } from '../agent-prompts/useAgentPrompts'
import type { ChatAttachment } from '@slayzone/terminal-contracts'
import { buildPromptHistory, recordedAttachments, type HistoryRecord } from './prompt-history'

/**
 * The task's prompt history for the composer, newest first: every prompt stored
 * for the task (on its computer — chat sends and terminal-agent prompts, so it
 * survives a chat reset) plus what this composer recorded since mount: its sends
 * (exactly as typed, and visible before the stored copy arrives) and the drafts
 * Esc Esc cleared, with their files (`attachmentsOf`) — kept in memory only.
 * `enabled` = the mode's `promptHistory` capability; off → no query, no entries.
 */
export function usePromptHistory({ taskId, enabled }: { taskId: string; enabled: boolean }): {
  entries: string[]
  record: (text: string, attachments?: ChatAttachment[]) => void
  /** The files recorded with the newest entry of `text` (a cleared draft's); none → null. */
  attachmentsOf: (text: string) => ChatAttachment[] | null
} {
  const stored = useAgentPrompts(taskId, undefined, enabled)
  const [recorded, setRecorded] = useState<HistoryRecord[]>([])
  const entries = useMemo(
    () =>
      enabled
        ? buildPromptHistory(
            recorded.map((r) => r.text),
            stored.map((p) => p.text)
          )
        : [],
    [enabled, recorded, stored]
  )
  const record = useStableCallback((text: string, attachments: ChatAttachment[] = []) => {
    if (!enabled || !text.trim()) return
    setRecorded((prev) => [{ text, attachments }, ...prev])
  })
  const attachmentsOf = useStableCallback((text: string) => recordedAttachments(recorded, text))
  return { entries, record, attachmentsOf }
}
