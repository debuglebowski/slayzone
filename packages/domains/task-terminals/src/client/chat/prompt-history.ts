import { isSyntheticChatPrompt } from '@slayzone/terminal-contracts'

/**
 * Prompt history for the chat composer (↑/↓ recall, Ctrl+R search). Pure — the
 * composer owns the state; entries come from `usePromptHistory`.
 */

/**
 * The task's prompts, newest first: this composer's sends since mount, then the
 * stored prompts (`agent_prompts`, oldest first — chat + terminal agents). A
 * repeated prompt keeps only its most recent position; blank and synthetic
 * control texts are left out.
 */
export function buildPromptHistory(
  sentNewestFirst: string[],
  storedOldestFirst: string[]
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (text: string): void => {
    if (!text.trim() || isSyntheticChatPrompt(text) || seen.has(text)) return
    seen.add(text)
    out.push(text)
  }
  for (const text of sentNewestFirst) add(text)
  for (let i = storedOldestFirst.length - 1; i >= 0; i--) add(storedOldestFirst[i])
  return out
}

/** Position in the history while browsing it; `index` −1 = not browsing. */
export interface HistoryNav {
  index: number
  /** The draft that was in the composer when browsing started — restored by ↓ past the newest. */
  stash: string
}

export const HISTORY_IDLE: HistoryNav = { index: -1, stash: '' }

/** Browsing = the composer still shows the recalled entry, unedited. */
export function isBrowsingHistory(nav: HistoryNav, draft: string, entries: string[]): boolean {
  return nav.index >= 0 && nav.index < entries.length && entries[nav.index] === draft
}

/**
 * One ↑/↓ press. Returns the next navigation state + draft, or null when the
 * key should keep its native caret movement. Starts only from an empty composer
 * or a caret at the very start (autocomplete closed — the caller checks);
 * while browsing, keeps walking wherever the caret is.
 */
export function historyStep(args: {
  nav: HistoryNav
  key: 'up' | 'down'
  draft: string
  caretAtStart: boolean
  entries: string[]
}): { nav: HistoryNav; draft: string } | null {
  const { nav, key, draft, caretAtStart, entries } = args
  if (isBrowsingHistory(nav, draft, entries)) {
    if (key === 'up') {
      if (nav.index + 1 >= entries.length) return { nav, draft }
      const index = nav.index + 1
      return { nav: { ...nav, index }, draft: entries[index] }
    }
    if (nav.index === 0) return { nav: HISTORY_IDLE, draft: nav.stash }
    const index = nav.index - 1
    return { nav: { ...nav, index }, draft: entries[index] }
  }
  if (key === 'up' && entries.length > 0 && (draft === '' || caretAtStart)) {
    return { nav: { index: 0, stash: draft }, draft: entries[0] }
  }
  return null
}

/** Ctrl+R search: case-insensitive substring match, keeping newest-first order. */
export function searchPrompts(entries: string[], query: string): string[] {
  const q = query.trim().toLowerCase()
  if (!q) return entries
  return entries.filter((text) => text.toLowerCase().includes(q))
}
