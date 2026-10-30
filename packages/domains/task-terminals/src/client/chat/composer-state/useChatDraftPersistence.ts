import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { ChatAttachment, ChatDraft, ChatTabState } from '@slayzone/terminal-contracts'
import { useTRPC, useTRPCClient } from '../../trpc'

/**
 * Keeps a chat tab's draft (text + attached files) across remounts and reloads
 * (plan item 4.2): saved server-side per tab (`chat.tabState`), so it also
 * follows the tab to another window, and is gone with the tab.
 *
 * A save waits for a short pause in typing. So that a reload or a renderer
 * crash inside that pause loses nothing, every change is first written to a
 * local journal (localStorage), removed once the server confirmed that exact
 * draft. On load the journal wins only if it was based on the revision the
 * server still has — otherwise another window saved later and its draft wins.
 */

const SAVE_DELAY_MS = 300
const JOURNAL_PREFIX = 'slayzone:chat-draft:'
const JOURNAL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function draftJournalKey(tabId: string): string {
  return `${JOURNAL_PREFIX}${tabId}`
}

interface Journal extends ChatDraft {
  /** The server revision this edit was made on top of. */
  baseRev: number
  savedAt: number
}

function readJournal(tabId: string): Journal | null {
  try {
    const raw = localStorage.getItem(draftJournalKey(tabId))
    if (!raw) return null
    const j = JSON.parse(raw) as Partial<Journal>
    if (
      typeof j.text !== 'string' ||
      !Array.isArray(j.attachments) ||
      typeof j.baseRev !== 'number'
    ) {
      return null
    }
    return j as Journal
  } catch {
    return null
  }
}

function writeJournal(tabId: string, journal: Journal | null): void {
  try {
    if (journal) localStorage.setItem(draftJournalKey(tabId), JSON.stringify(journal))
    else localStorage.removeItem(draftJournalKey(tabId))
  } catch {
    /* storage unavailable (private window, quota): the server save still runs */
  }
}

let journalsSwept = false
/** Once per app session: journals of tabs long gone. */
function sweepOldJournals(now: number): void {
  if (journalsSwept) return
  journalsSwept = true
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key?.startsWith(JOURNAL_PREFIX)) continue
      const j = readJournal(key.slice(JOURNAL_PREFIX.length))
      if (!j || now - j.savedAt > JOURNAL_MAX_AGE_MS) localStorage.removeItem(key)
    }
  } catch {
    /* storage unavailable */
  }
}

function sameDraft(a: ChatDraft, b: ChatDraft): boolean {
  return (
    a.text === b.text &&
    a.attachments.length === b.attachments.length &&
    a.attachments.every((x, i) => x.artifactId === b.attachments[i].artifactId)
  )
}

const EMPTY: ChatDraft = { text: '', attachments: [] }

interface Resolved {
  draft: ChatDraft | null
  rev: number
  /** A journal was there but the server moved on: drop it. */
  stale: boolean
}

function resolveSaved(tabId: string, server: ChatTabState | null): Resolved {
  const rev = server?.draft.rev ?? 0
  const journal = readJournal(tabId)
  if (journal && journal.baseRev === rev) {
    return { draft: { text: journal.text, attachments: journal.attachments }, rev, stale: false }
  }
  const fromServer = server
    ? { text: server.draft.text, attachments: server.draft.attachments }
    : null
  const draft = fromServer && (fromServer.text || fromServer.attachments.length) ? fromServer : null
  return { draft, rev, stale: journal !== null }
}

export interface ChatDraftPersistence {
  /** The saved draft has been read (or there is none / persistence is off). */
  loaded: boolean
  /** The draft to restore on mount (journal or server), or null. */
  saved: ChatDraft | null
}

export function useChatDraftPersistence({
  tabId,
  enabled,
  text,
  attachments,
  paused
}: {
  tabId: string
  /** The mode's `restoreComposerState` capability. */
  enabled: boolean
  text: string
  attachments: ChatAttachment[]
  /** E.g. while ↑/↓ shows an older prompt in the composer: not the user's draft. */
  paused: boolean
}): ChatDraftPersistence {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const queryOptions = trpc.chat.tabState.get.queryOptions({ tabId }, { enabled })
  const { data, isSuccess } = useQuery(queryOptions)
  const loaded = enabled && isSuccess

  // Journal vs server, decided ONCE per mount (later cache updates — our own
  // saves — must not re-decide it). Adjusted during render: no extra frame.
  const [resolved, setResolved] = useState<Resolved | null>(null)
  if (!resolved && loaded) {
    setResolved(resolveSaved(tabId, (data as ChatTabState | null | undefined) ?? null))
  }

  // Written in effects only (React Compiler): the last revision the server
  // confirmed, the draft it holds, and the save waiting for the typing pause.
  const revRef = useRef(0)
  const persistedRef = useRef<ChatDraft>(EMPTY)
  const pendingRef = useRef<ChatDraft | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef<(draft: ChatDraft) => void>(() => undefined)

  // The draft as it was when the saved one arrived: until it changes, nothing
  // is saved — an untouched (empty) composer must never overwrite a saved draft.
  const baselineRef = useRef<ChatDraft>(EMPTY)
  const dirtyRef = useRef(false)
  const handledRef = useRef<Resolved | null>(null)

  useEffect(() => {
    if (!resolved || handledRef.current === resolved) return
    handledRef.current = resolved
    sweepOldJournals(Date.now())
    revRef.current = resolved.rev
    // What the composer restores is what the server (or the journal) holds.
    persistedRef.current = resolved.draft ?? EMPTY
    if (resolved.stale) writeJournal(tabId, null)
    const atLoad = { text, attachments }
    baselineRef.current = atLoad
    // Typed before the saved draft arrived (the composer then keeps it): save it.
    dirtyRef.current = !sameDraft(atLoad, EMPTY) && !sameDraft(atLoad, persistedRef.current)
  }, [resolved, tabId, text, attachments])

  useEffect(() => {
    saveRef.current = (draft) => {
      pendingRef.current = null
      trpcClient.chat.tabState.saveDraft.mutate({ tabId, draft }).then(
        (res) => {
          if (!res) return // the tab is gone
          revRef.current = res.rev
          persistedRef.current = draft
          const journal = readJournal(tabId)
          if (journal && sameDraft(journal, draft)) writeJournal(tabId, null)
          else if (journal) writeJournal(tabId, { ...journal, baseRev: res.rev })
          queryClient.setQueryData(
            queryOptions.queryKey,
            (old: ChatTabState | null | undefined) => ({
              draft: { ...draft, rev: res.rev },
              scroll: old?.scroll ?? null
            })
          )
        },
        (err: unknown) => {
          // The journal keeps the text; the next change (or load) saves it.
          console.error('[chat] saving the draft failed:', err)
        }
      )
    }
  })

  useEffect(() => {
    if (!enabled || !resolved || paused) return
    const draft = { text, attachments }
    if (!dirtyRef.current) {
      if (sameDraft(draft, baselineRef.current)) return
      dirtyRef.current = true
    }
    if (sameDraft(draft, persistedRef.current) && pendingRef.current === null) return
    writeJournal(tabId, { ...draft, baseRev: revRef.current, savedAt: Date.now() })
    pendingRef.current = draft
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (pendingRef.current) saveRef.current(pendingRef.current)
    }, SAVE_DELAY_MS)
  }, [enabled, resolved, paused, text, attachments, tabId])

  // Leaving (remount, tab closed, page unload): save what is waiting now.
  useEffect(() => {
    const flush = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = null
      if (pendingRef.current) saveRef.current(pendingRef.current)
    }
    window.addEventListener('pagehide', flush)
    return () => {
      window.removeEventListener('pagehide', flush)
      flush()
    }
  }, [])

  // `loaded` waits for `resolved`, not the query: in the render pass that sets
  // `resolved` (re-run at once), a caller that restores during render would
  // otherwise see "loaded, nothing saved" and settle on an empty draft.
  return { loaded: !enabled || resolved !== null, saved: resolved?.draft ?? null }
}
