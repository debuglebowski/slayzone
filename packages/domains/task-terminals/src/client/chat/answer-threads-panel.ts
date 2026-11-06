/**
 * The answer-threads panel a chat tab has open: which answer's threads, and the
 * selected one (`activeId` null = "New thread"). View state, so it is kept per
 * window in localStorage (like the sessions sidebar's open state) — reloading
 * or restarting the app reopens the panel where it was; closing it forgets it.
 */
export interface AnswerThreadsPanel {
  conversationId: string
  answerId: string
  sourceMessageId: string
  activeId: string | null
}

const PREFIX = 'slayzone:chat-threads-panel:'

export function answerThreadsPanelKey(hubId: string, tabId: string): string {
  return `${PREFIX}${JSON.stringify([hubId, tabId])}`
}

const nonEmpty = (v: unknown): v is string => typeof v === 'string' && v.length > 0

export function readAnswerThreadsPanel(key: string): AnswerThreadsPanel | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<AnswerThreadsPanel> | null
    if (
      !p ||
      !nonEmpty(p.conversationId) ||
      !nonEmpty(p.answerId) ||
      !nonEmpty(p.sourceMessageId) ||
      (p.activeId !== null && !nonEmpty(p.activeId))
    )
      return null
    return {
      conversationId: p.conversationId,
      answerId: p.answerId,
      sourceMessageId: p.sourceMessageId,
      activeId: p.activeId
    }
  } catch {
    return null
  }
}

export function writeAnswerThreadsPanel(key: string, panel: AnswerThreadsPanel | null): void {
  try {
    if (panel) localStorage.setItem(key, JSON.stringify(panel))
    else localStorage.removeItem(key)
  } catch {
    // Storage full / unavailable: the panel still works, it just isn't remembered.
  }
}
