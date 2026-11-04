import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useHubId } from '@slayzone/transport/client'
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
 * draft. Edits before the first remote read retain an unknown revision. A
 * conflicting saved copy stays authoritative until the user explicitly keeps
 * both or dismisses it (keeping only the current draft); neither local content
 * nor another provider's draft is overwritten.
 *
 * A saved draft this composer itself sent, whose reply has not arrived yet, is
 * not a conflict: re-reading the server (reconnect, remount, reload) while a
 * save is on its way finds a newer revision that is our own write. Those sends
 * are recorded (`<journal key>:sent`) until acknowledged, so a re-read can tell
 * "ours, reply pending" from "changed elsewhere".
 */

const SAVE_DELAY_MS = 300
const JOURNAL_PREFIX = 'slayzone:chat-draft:'

export function draftJournalKey(tabId: string, hubId = 'local', mode?: string): string {
  return `${JOURNAL_PREFIX}${JSON.stringify(mode ? [hubId, tabId, mode] : [hubId, tabId])}`
}
type Ownership = { id: string; epoch: number }
const sameOwnership = (left: Ownership | undefined, right: Ownership | undefined) =>
  left?.id === right?.id && left?.epoch === right?.epoch

interface Journal extends ChatDraft {
  /** The server revision this edit was made on top of. */
  baseRev: number | null
  savedAt: number
  ownership?: Ownership
}
function validDraft(value: unknown): value is ChatDraft {
  if (!value || typeof value !== 'object') return false
  const draft = value as ChatDraft
  return (
    typeof draft.text === 'string' &&
    Array.isArray(draft.attachments) &&
    draft.attachments.every(
      (file) =>
        file &&
        typeof file === 'object' &&
        typeof file.artifactId === 'string' &&
        typeof file.name === 'string' &&
        ['image', 'pdf', 'text'].includes(file.kind) &&
        [
          'image/png',
          'image/jpeg',
          'image/gif',
          'image/webp',
          'application/pdf',
          'text/plain'
        ].includes(file.mediaType) &&
        Number.isSafeInteger(file.size) &&
        file.size >= 0 &&
        (file.contentHash === undefined || typeof file.contentHash === 'string')
    )
  )
}

function readJournal(key: string): Journal | null {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return null
    const j = JSON.parse(raw) as Partial<Journal>
    if (
      (j.ownership !== undefined &&
        (!j.ownership ||
          typeof j.ownership.id !== 'string' ||
          !Number.isSafeInteger(j.ownership.epoch) ||
          j.ownership.epoch < 1)) ||
      (j.baseRev !== null && !Number.isSafeInteger(j.baseRev)) ||
      typeof j.savedAt !== 'number' ||
      !Number.isFinite(j.savedAt) ||
      !validDraft(j)
    ) {
      return null
    }
    return j as Journal
  } catch {
    return null
  }
}

function writeJournal(key: string, journal: Journal | null): boolean {
  try {
    if (journal) localStorage.setItem(key, JSON.stringify(journal))
    else localStorage.removeItem(key)
    return true
  } catch {
    /* storage unavailable (private window, quota): the server save still runs */
    return false
  }
}

let journalsSwept = false
/** Age cannot prove an offline draft was acknowledged or its tab was deleted. */
function sweepInvalidJournals(): void {
  if (journalsSwept) return
  journalsSwept = true
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (!key?.startsWith(JOURNAL_PREFIX) || key.endsWith(':conflicts') || key.endsWith(':sent'))
        continue
      const j = readJournal(key)
      if (!j) localStorage.removeItem(key)
    }
  } catch {
    /* storage unavailable */
  }
}

function sameDraft(a: ChatDraft, b: ChatDraft): boolean {
  return (
    a.text === b.text &&
    a.attachments.length === b.attachments.length &&
    a.attachments.every((x, i) => {
      const y = b.attachments[i]
      return (
        x.artifactId === y.artifactId &&
        x.contentHash === y.contentHash &&
        x.name === y.name &&
        x.kind === y.kind &&
        x.mediaType === y.mediaType &&
        x.size === y.size
      )
    })
  )
}

const EMPTY: ChatDraft = { text: '', attachments: [] }
function mergeDrafts(current: ChatDraft, saved: ChatDraft): ChatDraft {
  const attachments = [...current.attachments]
  for (const file of saved.attachments)
    if (
      !attachments.some(
        (existing) =>
          existing.artifactId === file.artifactId && existing.contentHash === file.contentHash
      )
    )
      attachments.push(file)
  return {
    text:
      !saved.text || current.text === saved.text
        ? current.text
        : !current.text
          ? saved.text
          : `${current.text}\n\n${saved.text}`,
    attachments
  }
}
function readConflicts(key: string): ChatDraft[] {
  try {
    const values = JSON.parse(localStorage.getItem(key) ?? '[]') as ChatDraft[]
    return Array.isArray(values) ? values.filter(validDraft) : []
  } catch {
    return []
  }
}
function preserveConflict(key: string, draft: ChatDraft): boolean {
  try {
    const values = readConflicts(key)
    if (values.some((value) => sameDraft(value, draft))) return true
    values.push(draft)
    localStorage.setItem(key, JSON.stringify(values))
    return true
  } catch {
    return false
  }
}

/** Drafts sent to the computer, in send order, whose reply has not arrived. */
interface Unacknowledged {
  ownership?: Ownership
  drafts: ChatDraft[]
}
const MAX_UNACKNOWLEDGED = 20
const sentKey = (key: string) => `${key}:sent`
function readUnacknowledged(key: string): Unacknowledged {
  try {
    const raw = localStorage.getItem(sentKey(key))
    const value = raw ? (JSON.parse(raw) as Partial<Unacknowledged>) : null
    if (!value || !Array.isArray(value.drafts)) return { drafts: [] }
    return { ownership: value.ownership, drafts: value.drafts.filter(validDraft) }
  } catch {
    return { drafts: [] }
  }
}
function writeUnacknowledged(key: string, value: Unacknowledged): void {
  try {
    if (value.drafts.length) localStorage.setItem(sentKey(key), JSON.stringify(value))
    else localStorage.removeItem(sentKey(key))
  } catch {
    /* storage unavailable: a re-read during this save may then report a conflict */
  }
}
/** Recorded just before the save request goes out (sends are serialized). */
function recordSent(key: string, draft: ChatDraft, ownership: Ownership | undefined): void {
  const sent = readUnacknowledged(key)
  const drafts = sameOwnership(sent.ownership, ownership) ? sent.drafts : []
  writeUnacknowledged(key, { ownership, drafts: [...drafts, draft].slice(-MAX_UNACKNOWLEDGED) })
}
/** The computer committed `draft`: it and every earlier send are settled. */
function acknowledgeSent(key: string, draft: ChatDraft, ownership: Ownership | undefined): void {
  const sent = readUnacknowledged(key)
  if (!sameOwnership(sent.ownership, ownership)) return
  const index = sent.drafts.findIndex((value) => sameDraft(value, draft))
  if (index >= 0) writeUnacknowledged(key, { ownership, drafts: sent.drafts.slice(index + 1) })
}
/** The server's draft is one this composer sent and is still waiting to hear back about. */
function isOwnUnacknowledged(key: string, server: ChatTabState | null): boolean {
  if (!server) return false
  const sent = readUnacknowledged(key)
  return (
    sameOwnership(sent.ownership, server.ownership) &&
    sent.drafts.some((draft) => sameDraft(draft, server.draft))
  )
}

interface Resolved {
  draft: ChatDraft | null
  persisted: ChatDraft
  rev: number
  conflict: ChatDraft | null
  ownership?: Ownership
}

function resolveSaved(key: string, server: ChatTabState | null, current: ChatDraft): Resolved {
  const rev = server?.draft.rev ?? 0
  const persisted = server
    ? { text: server.draft.text, attachments: server.draft.attachments }
    : EMPTY
  const journal: Journal | null =
    readJournal(key) ??
    (!sameDraft(current, EMPTY) ? { ...current, baseRev: null, savedAt: Date.now() } : null)
  const ownership = server?.ownership
  const sameOwner =
    !ownership ||
    (journal?.ownership?.id === ownership.id && journal.ownership.epoch === ownership.epoch)
  if (
    journal &&
    ((sameOwner && journal.baseRev === rev) ||
      // Typed before the first read (computer starting, offline): an empty saved
      // draft holds nothing to lose, whatever its revision. A used tab's draft is
      // empty at rev > 0 once its last message was sent.
      (!journal.ownership && journal.baseRev === null && sameDraft(persisted, EMPTY)) ||
      sameDraft(journal, persisted) ||
      // The newer revision is our own save whose reply never arrived (reload,
      // remount): the journal holds the typing made on top of it.
      (sameOwner && isOwnUnacknowledged(key, server)))
  ) {
    return {
      draft: { text: journal.text, attachments: journal.attachments },
      persisted,
      rev,
      conflict: null,
      ownership
    }
  }
  const fromServer = server
    ? { text: server.draft.text, attachments: server.draft.attachments }
    : null
  const draft = fromServer && (fromServer.text || fromServer.attachments.length) ? fromServer : null
  return { draft, persisted, rev, conflict: journal, ownership }
}

export interface ChatDraftPersistence {
  /** A local journal is available, or the saved draft has been read. */
  loaded: boolean
  /** The draft to restore on mount (journal or server), or null. */
  saved: ChatDraft | null
  /** Retry saving the current draft after its computer reconnects. Never sends a message. */
  retry: () => Promise<void>
  legacyAvailable: boolean
  /** Explicitly import a journal whose original hub is unknown, keeping current text/files. */
  recoverLegacy: (current: ChatDraft) => ChatDraft | null
  conflictAvailable: boolean
  /** Keep both copies after an unresolved/stale journal meets a different saved draft. */
  recoverConflict: (current: ChatDraft) => ChatDraft | null
  /** Keep only the current draft: discard the other retained copies and resume saving. */
  dismissConflict: (current: ChatDraft) => boolean
}

export function useChatDraftPersistence({
  tabId,
  mode,
  enabled,
  text,
  attachments,
  paused
}: {
  tabId: string
  mode?: string
  /** The mode's `restoreComposerState` capability. */
  enabled: boolean
  text: string
  attachments: ChatAttachment[]
  /** E.g. while ↑/↓ shows an older prompt in the composer: not the user's draft. */
  paused: boolean
}): ChatDraftPersistence {
  const trpc = useTRPC()
  const hubId = useHubId() ?? 'local'
  const key = draftJournalKey(tabId, hubId, mode)
  const legacyKeys = useMemo(
    () => [...(mode ? [draftJournalKey(tabId, hubId)] : []), `${JOURNAL_PREFIX}${tabId}`],
    [mode, hubId, tabId]
  )
  const conflictKey = `${key}:conflicts`
  const [initialJournal] = useState(() => (enabled ? readJournal(key) : null))
  const trpcClient = useTRPCClient()
  const queryClient = useQueryClient()
  const queryOptions = trpc.chat.tabState.get.queryOptions(
    { tabId, ...(mode ? { expectedMode: mode } : {}) },
    { enabled }
  )
  const { data, isSuccess, isFetchedAfterMount, refetch } = useQuery({
    ...queryOptions,
    staleTime: 0,
    refetchOnMount: 'always'
  })
  const loaded = enabled && isSuccess && (!mode || isFetchedAfterMount)

  // Journal vs server, decided ONCE per mount (later cache updates — our own
  // saves — must not re-decide it). Adjusted during render: no extra frame.
  const [resolved, setResolved] = useState<Resolved | null>(null)
  const [legacyAvailable, setLegacyAvailable] = useState(false)
  const [conflictAvailable, setConflictAvailable] = useState(
    () => enabled && readConflicts(conflictKey).length > 0
  )
  const [retryEpoch, setRetryEpoch] = useState(0)
  if (!resolved && loaded) {
    const next = resolveSaved(key, (data as ChatTabState | null | undefined) ?? null, {
      text,
      attachments
    })
    setResolved(next)
    setConflictAvailable(!!next.conflict || readConflicts(conflictKey).length > 0)
  }

  // Written in effects only (React Compiler): the last revision the server
  // confirmed, the draft it holds, and the save waiting for the typing pause.
  const revRef = useRef<number | null>(initialJournal?.baseRev ?? null)
  const ownershipRef = useRef<Ownership | undefined>(initialJournal?.ownership)
  const persistedRef = useRef<ChatDraft>(EMPTY)
  const pendingRef = useRef<ChatDraft | null>(null)
  const writeQueueRef = useRef<Promise<void>>(Promise.resolve())
  const savingRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRef = useRef<(draft: ChatDraft) => void>(() => undefined)

  // The draft as it was when the saved one arrived: until it changes, nothing
  // is saved — an untouched (empty) composer must never overwrite a saved draft.
  const baselineRef = useRef<ChatDraft>(EMPTY)
  const dirtyRef = useRef(false)
  const awaitingRestoreRef = useRef(false)
  const handledRef = useRef<Resolved | null>(null)
  const authorityRef = useRef<Resolved | null>(null)
  const unresolvedBaseline = useRef<ChatDraft>({ text, attachments })
  const unresolvedEdited = useRef(false)
  const conflictBlocked = useRef(false)
  const conflictPreserved = useRef(true)
  const refreshGeneration = useRef(0)
  const retry = useCallback(() => {
    if (!enabled) return Promise.resolve()
    const generation = ++refreshGeneration.current
    return refetch()
      .then((result) => {
        if (result.error || generation !== refreshGeneration.current) return
        const state = (result.data as ChatTabState | null | undefined) ?? null
        const remoteDraft = state
          ? { text: state.draft.text, attachments: state.draft.attachments }
          : EMPTY
        const remoteChanged =
          (state?.draft.rev ?? 0) !== revRef.current &&
          !sameDraft(remoteDraft, persistedRef.current) &&
          // Our own save, read back before its reply arrived.
          !isOwnUnacknowledged(key, state)
        if (!resolved || !sameOwnership(resolved.ownership, state?.ownership) || remoteChanged) {
          // The mode may have switched away and back without this mounted view
          // observing it. Do not flush old pending work into the replacement owner.
          if (timerRef.current) clearTimeout(timerRef.current)
          timerRef.current = null
          pendingRef.current = null
          ownershipRef.current = state?.ownership
          const next = resolveSaved(key, state, { text, attachments })
          authorityRef.current = next
          setResolved(next)
          setConflictAvailable(!!next.conflict || readConflicts(conflictKey).length > 0)
        }
        setRetryEpoch((epoch) => epoch + 1)
      })
      .catch(() => {
        /* Keep the local journal; a later recovery retries the read. */
      })
  }, [enabled, resolved, refetch, key, conflictKey, text, attachments])
  const recoverConflict = useCallback(
    (current: ChatDraft) => {
      if (!resolved) return null
      const copies = readConflicts(conflictKey)
      // The primary journal may be the only surviving copy after a quota failure.
      if (resolved.conflict && !copies.some((draft) => sameDraft(draft, resolved.conflict!)))
        copies.push(resolved.conflict)
      if (!copies.some((draft) => sameDraft(draft, resolved.persisted)))
        copies.push(resolved.persisted)
      const unique = [current]
      for (const draft of copies)
        if (!unique.some((copy) => sameDraft(copy, draft))) unique.push(draft)
      let merged = unique[0]
      for (const draft of unique.slice(1)) merged = mergeDrafts(merged, draft)
      if (
        !writeJournal(key, {
          ...merged,
          baseRev: resolved.rev,
          ownership: resolved.ownership,
          savedAt: Date.now()
        })
      )
        return null
      try {
        localStorage.removeItem(conflictKey)
      } catch {
        /* The combined journal is durable. */
      }
      conflictBlocked.current = false
      dirtyRef.current = true
      awaitingRestoreRef.current = false
      setConflictAvailable(false)
      setRetryEpoch((epoch) => epoch + 1)
      return merged
    },
    [resolved, conflictKey, key]
  )
  const dismissConflict = useCallback(
    (current: ChatDraft) => {
      if (!resolved) return false
      // The current draft must be durable before the other copies are dropped.
      if (
        !writeJournal(key, {
          ...current,
          baseRev: resolved.rev,
          ownership: resolved.ownership,
          savedAt: Date.now()
        })
      )
        return false
      try {
        localStorage.removeItem(conflictKey)
      } catch {
        return false
      }
      conflictBlocked.current = false
      dirtyRef.current = true
      awaitingRestoreRef.current = false
      setConflictAvailable(false)
      setRetryEpoch((epoch) => epoch + 1)
      return true
    },
    [resolved, conflictKey, key]
  )
  const recoverLegacy = useCallback(
    (current: ChatDraft) => {
      if (!resolved) return null
      const legacyKey = legacyKeys.find((candidate) => readJournal(candidate))
      const journal = legacyKey ? readJournal(legacyKey) : null
      if (!journal) return null
      const recovered = {
        text:
          !current.text || current.text === journal.text
            ? journal.text
            : journal.text
              ? `${current.text}\n\n${journal.text}`
              : current.text,
        attachments: [...current.attachments]
      }
      for (const attachment of journal.attachments)
        if (
          !recovered.attachments.some(
            (a) =>
              a.artifactId === attachment.artifactId && a.contentHash === attachment.contentHash
          )
        )
          recovered.attachments.push(attachment)
      // Never discard the only copy if this browser cannot write the scoped journal.
      if (
        writeJournal(key, {
          ...recovered,
          baseRev: revRef.current,
          ownership: ownershipRef.current,
          savedAt: Date.now()
        }) &&
        legacyKey
      )
        writeJournal(legacyKey, null)
      dirtyRef.current = true
      awaitingRestoreRef.current = false
      setLegacyAvailable(legacyKeys.some((candidate) => readJournal(candidate) !== null))
      return recovered
    },
    [resolved, legacyKeys, key, setLegacyAvailable]
  )

  useEffect(() => {
    if (!resolved || handledRef.current === resolved) return
    handledRef.current = resolved
    authorityRef.current = resolved
    sweepInvalidJournals()
    revRef.current = resolved.rev
    ownershipRef.current = resolved.ownership
    // A journal is not an acknowledgement from the computer. Save it once restored.
    persistedRef.current = resolved.persisted
    const atLoad = { text, attachments }
    conflictBlocked.current = false
    conflictPreserved.current = true
    if (resolved.conflict) {
      // The editor may already show local typing (or an offline-restored journal).
      // Preserve the other copy before permitting any save over the authoritative revision.
      const other =
        sameDraft(atLoad, resolved.persisted) || sameDraft(atLoad, EMPTY)
          ? resolved.conflict
          : resolved.persisted
      conflictPreserved.current = preserveConflict(conflictKey, other)
      conflictBlocked.current = true
    } else if (readConflicts(conflictKey).length) {
      conflictBlocked.current = true
    }
    setLegacyAvailable(legacyKeys.some((candidate) => readJournal(candidate) !== null))
    baselineRef.current = atLoad
    awaitingRestoreRef.current =
      sameDraft(atLoad, EMPTY) && resolved.draft !== null && !sameDraft(atLoad, resolved.draft)
    // Typed before the saved draft arrived (the composer then keeps it): save it.
    dirtyRef.current =
      !sameDraft(atLoad, persistedRef.current) &&
      (!sameDraft(atLoad, EMPTY) || (resolved.draft !== null && sameDraft(atLoad, resolved.draft)))
  }, [resolved, key, legacyKeys, conflictKey, text, attachments])

  useEffect(() => {
    const ownership = resolved?.ownership
    saveRef.current = (draft) => {
      pendingRef.current = null
      savingRef.current += 1
      const persist = () => {
        if (authorityRef.current !== resolved) return Promise.resolve()
        recordSent(key, draft, ownership)
        return trpcClient.chat.tabState.saveDraft
          .mutate({
            tabId,
            draft,
            ...(mode ? { expectedMode: mode } : {}),
            ...(ownership ? { expectedOwnership: ownership } : {})
          })
          .then((res) => {
            if (res) acknowledgeSent(key, draft, ownership)
            if (!res || authorityRef.current !== resolved) return // gone or reconciled while waiting
            if (sameOwnership(ownershipRef.current, ownership)) {
              revRef.current = res.rev
              persistedRef.current = draft
            }
            const journal = readJournal(key)
            if (journal && sameOwnership(journal.ownership, ownership)) {
              if (sameDraft(journal, draft)) writeJournal(key, null)
              else writeJournal(key, { ...journal, baseRev: res.rev })
            }
            queryClient.setQueryData(
              queryOptions.queryKey,
              (old: ChatTabState | null | undefined) =>
                sameOwnership(old?.ownership, ownership)
                  ? { ...old, draft: { ...draft, rev: res.rev }, scroll: old?.scroll ?? null }
                  : old
            )
          })
      }
      // Attachment sealing may take longer than a subsequent text-only edit.
      // Preserve user edit order all the way to the owning computer.
      writeQueueRef.current = writeQueueRef.current
        .then(persist, persist)
        .catch(() => {
          // The journal keeps the text; reconnect or the next edit retries the save.
          console.error('[chat] saving the draft failed')
        })
        .finally(() => {
          savingRef.current -= 1
        })
    }
  })

  useEffect(() => {
    if (!enabled || paused) return
    const draft = { text, attachments }
    if (!resolved) {
      if (
        !unresolvedEdited.current &&
        sameDraft(draft, unresolvedBaseline.current) &&
        sameDraft(draft, EMPTY)
      )
        return
      // Preserve an existing journal until the caller restores it, rather than
      // replacing it with the empty first render of a remounted composer.
      if (!unresolvedEdited.current && initialJournal && sameDraft(draft, EMPTY)) return
      unresolvedEdited.current = true
      writeJournal(key, {
        ...draft,
        baseRev: initialJournal?.baseRev ?? null,
        ownership: initialJournal?.ownership,
        savedAt: Date.now()
      })
      return
    }
    if (conflictBlocked.current) {
      // Keep current typing durable, but never silently overwrite the computer's
      // different saved copy. Explicit recovery combines the retained copies.
      if (conflictPreserved.current && (!sameDraft(draft, EMPTY) || unresolvedEdited.current))
        writeJournal(key, {
          ...draft,
          baseRev: null,
          ownership: ownershipRef.current,
          savedAt: Date.now()
        })
      return
    }
    if (awaitingRestoreRef.current) {
      if (sameDraft(draft, baselineRef.current)) return
      awaitingRestoreRef.current = false
      dirtyRef.current = true
    }
    if (!dirtyRef.current) {
      if (sameDraft(draft, baselineRef.current)) return
      dirtyRef.current = true
    }
    if (
      sameDraft(draft, persistedRef.current) &&
      pendingRef.current === null &&
      savingRef.current === 0
    )
      return
    writeJournal(key, {
      ...draft,
      baseRev: revRef.current,
      ownership: ownershipRef.current,
      savedAt: Date.now()
    })
    pendingRef.current = draft
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => {
      timerRef.current = null
      if (pendingRef.current) saveRef.current(pendingRef.current)
    }, SAVE_DELAY_MS)
  }, [enabled, resolved, paused, text, attachments, key, retryEpoch, initialJournal])

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
  return {
    loaded: !enabled || resolved !== null || initialJournal !== null,
    saved: resolved
      ? resolved.draft
      : initialJournal
        ? { text: initialJournal.text, attachments: initialJournal.attachments }
        : null,
    retry,
    legacyAvailable,
    recoverLegacy,
    conflictAvailable,
    recoverConflict,
    dismissConflict
  }
}
