import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTRPCClient } from '../../trpc'
import { useStableCallback } from '@slayzone/ui'
import type { AcceptCtx, AutocompleteSource, FetchCtx, TriggerMatch } from './types'
import { rankAcrossSources, type MergedEntry, type UsageLookup } from './ranking'
import { resolveEnter } from './resolve-enter'

/**
 * What Enter does on an open menu. `accept-selected`: accept the highlighted
 * entry (Codex chat, and every non-command trigger). `native-commands`: the
 * provider runs its own slash commands, so a `/command` match follows
 * `resolveEnter` and sends through `submit`.
 */
export type EnterPolicy = 'accept-selected' | 'native-commands'

export interface UseAutocompleteOptions {
  sources: AutocompleteSource[]
  draft: string
  setDraft: (v: string) => void
  cursorPos: number
  acceptCtx: Omit<AcceptCtx, 'draft' | 'setDraft' | 'tokenStart' | 'tokenEnd'>
  fetchCtx: FetchCtx
  enterPolicy?: EnterPolicy
  /** Send `text` through the composer's normal send path (required by `native-commands`). */
  submit?: (text: string) => void
  /** Hide the menu (e.g. while ↑/↓ browses prompt history). */
  suppressed?: boolean
}

type UsageMap = Record<string, Record<string, number>>

/**
 * Re-read the usage map after a bump. Plain function (not inline in the hook):
 * the React Compiler cannot lower value blocks inside try/catch.
 */
async function refreshUsage(
  trpcClient: ReturnType<typeof useTRPCClient>,
  setUsage: (m: UsageMap) => void
): Promise<void> {
  try {
    const m = await trpcClient.chat.getAutocompleteUsage.query()
    setUsage(m ?? {})
  } catch {
    /* best-effort */
  }
}

export interface ActiveMatch {
  match: TriggerMatch
  entries: MergedEntry[]
  /** Lead source — used for menu data attribute and Esc-dismiss tracking. */
  leadSourceId: string
}

export interface UseAutocompleteResult {
  show: boolean
  active: ActiveMatch | null
  selectedIndex: number
  setSelectedIndex: (i: number) => void
  accept: (index: number) => void
  close: () => void
  handleKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean
  /**
   * Called by the composer before sending. Walks sources in order, returning the first
   * source's transform result. Use to expand slash-command templates on Enter.
   */
  transformSubmit: (draft: string) => import('./types').SubmitTransform | null
  /**
   * Bump usage counters for all `/<name>` tokens in `text` that resolve to a known
   * autocomplete item (skill / agent / command / builtin). Call AFTER a successful
   * chat send. Refreshes the usage map afterwards so subsequent ranking sees the bump.
   * Resolution preference: items the user explicitly accepted from the menu during this
   * draft win over plain-typed matches; otherwise scans sources in registration order.
   */
  bumpUsageFromMessage: (text: string) => Promise<void>
}

/**
 * Composes N autocomplete sources into a single menu.
 * First source whose `detect()` returns non-null wins (priority = registration order).
 */
export function useAutocomplete(opts: UseAutocompleteOptions): UseAutocompleteResult {
  const {
    sources,
    draft,
    setDraft,
    cursorPos,
    acceptCtx,
    fetchCtx,
    enterPolicy = 'accept-selected',
    submit,
    suppressed = false
  } = opts
  const trpcClient = useTRPCClient()
  const [selectedIndex, setSelectedIndex] = useState(0)
  /** True once ↑/↓ moved the selection for the current match (Enter then takes it). */
  const [navigated, setNavigated] = useState(false)
  const [itemsBySource, setItemsBySource] = useState<Record<string, unknown[]>>({})
  const [dismissed, setDismissed] = useState<{ source: string; match: TriggerMatch } | null>(null)
  const [usage, setUsage] = useState<UsageMap>({})
  /** Names the user explicitly accepted from the menu during the current draft. */
  const pickedRef = useRef<Map<string, { sourceId: string; name: string }>>(new Map())

  // Load usage map once on mount (reads the latest trpcClient). Refreshed after
  // each bump.
  const loadUsage = useStableCallback((isCancelled: () => boolean) => {
    void trpcClient.chat.getAutocompleteUsage
      .query()
      .then((m) => {
        if (!isCancelled()) setUsage(m ?? {})
      })
      .catch(() => {
        /* ignore — usage is best-effort */
      })
  })
  useEffect(() => {
    let cancelled = false
    loadUsage(() => cancelled)
    return () => {
      cancelled = true
    }
  }, [loadUsage])

  // Fetch items per source once (cwd-scoped). Sources are stable refs.
  const cwdRef = useRef(fetchCtx.cwd)
  useEffect(() => {
    cwdRef.current = fetchCtx.cwd
  })
  useEffect(() => {
    let cancelled = false
    void Promise.all(
      sources.map(async (src) => {
        try {
          const items = await src.fetch({ cwd: cwdRef.current })
          return [src.id, items] as const
        } catch {
          return [src.id, [] as unknown[]] as const
        }
      })
    ).then((pairs) => {
      if (cancelled) return
      const next: Record<string, unknown[]> = {}
      for (const [id, items] of pairs) next[id] = items
      setItemsBySource(next)
    })
    return () => {
      cancelled = true
    }
  }, [sources, fetchCtx.cwd])

  // Detect active sources. All sources whose `detect()` returns the same token range as the
  // first match merge into one cross-source-ranked list (via fzf on the union). This avoids
  // a high-priority source's results shadowing later sources at the same trigger position.
  // Sources with a different token range OR no matches at all are skipped.
  const active = useMemo<ActiveMatch | null>(() => {
    if (suppressed) return null
    let leadMatch: TriggerMatch | null = null
    let leadSourceId: string | null = null
    const groups: { source: AutocompleteSource; items: unknown[] }[] = []
    for (const src of sources) {
      const match = src.detect(draft, cursorPos)
      if (!match) continue
      if (!leadMatch) {
        if (
          dismissed &&
          dismissed.source === src.id &&
          dismissed.match.tokenStart === match.tokenStart
        ) {
          continue
        }
        leadMatch = match
        leadSourceId = src.id
      } else if (
        match.tokenStart !== leadMatch.tokenStart ||
        match.tokenEnd !== leadMatch.tokenEnd
      ) {
        continue
      }
      groups.push({ source: src, items: unshadowed(src, sources, itemsBySource) })
    }
    if (!leadMatch || !leadSourceId || groups.length === 0) return null

    const usageLookup: UsageLookup = (sourceId, name) => usage[sourceId]?.[name] ?? 0
    let entries: MergedEntry[]
    if (groups.some((g) => g.source.getName)) {
      entries = rankAcrossSources(groups, leadMatch.query, usageLookup)
    } else {
      entries = []
      for (const g of groups) {
        const filtered = g.source.filter(g.items, leadMatch.query)
        for (const item of filtered) entries.push({ item, source: g.source })
      }
    }
    if (entries.length === 0) return null
    return { match: leadMatch, entries, leadSourceId }
  }, [sources, draft, cursorPos, itemsBySource, dismissed, usage, suppressed])

  const show = active !== null

  // Both adjusted during render — same triggers as the equivalent effects, so a
  // new match never paints with the previous match's selection.
  // Restart the selection when the active match changes.
  const matchKey = {
    leadSourceId: active?.leadSourceId,
    tokenStart: active?.match.tokenStart,
    query: active?.match.query
  }
  const [selectionMatchKey, setSelectionMatchKey] = useState(matchKey)
  if (
    !Object.is(selectionMatchKey.leadSourceId, matchKey.leadSourceId) ||
    !Object.is(selectionMatchKey.tokenStart, matchKey.tokenStart) ||
    !Object.is(selectionMatchKey.query, matchKey.query)
  ) {
    setSelectionMatchKey(matchKey)
    setSelectedIndex(0)
    setNavigated(false)
  }

  // Clear dismissal on any draft/cursor change — Esc closes current state; next keystroke reopens.
  const [dismissalInput, setDismissalInput] = useState({ draft, cursorPos })
  if (!Object.is(dismissalInput.draft, draft) || !Object.is(dismissalInput.cursorPos, cursorPos)) {
    setDismissalInput({ draft, cursorPos })
    setDismissed(null)
  }

  const accept = useCallback(
    (index: number) => {
      if (!active) return
      const entry = active.entries[index]
      if (!entry) return
      const name = entry.source.getName?.(entry.item)
      if (name) pickedRef.current.set(name, { sourceId: entry.source.id, name })
      void entry.source.accept(entry.item, {
        ...acceptCtx,
        draft,
        setDraft,
        tokenStart: active.match.tokenStart,
        tokenEnd: active.match.tokenEnd
      })
    },
    [active, acceptCtx, draft, setDraft]
  )

  const close = useCallback(() => {
    if (active) setDismissed({ source: active.leadSourceId, match: active.match })
  }, [active])

  /**
   * Enter under `native-commands`: a source with `submitText` SENDS (through the
   * composer) instead of editing the draft; the rest accept as usual.
   */
  const submitEntry = useCallback(
    (index: number) => {
      if (!active) return
      const entry = active.entries[index]
      if (!entry) return
      const text = entry.source.submitText?.(entry.item, {
        ...acceptCtx,
        draft,
        setDraft,
        tokenStart: active.match.tokenStart,
        tokenEnd: active.match.tokenEnd
      })
      if (text == null || !submit) {
        accept(index)
        return
      }
      const name = entry.source.getName?.(entry.item)
      if (name) pickedRef.current.set(name, { sourceId: entry.source.id, name })
      submit(text)
    },
    [active, acceptCtx, draft, setDraft, submit, accept]
  )

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!active) return false
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSelectedIndex((i) => Math.min(i + 1, active.entries.length - 1))
        setNavigated(true)
        return true
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSelectedIndex((i) => Math.max(i - 1, 0))
        setNavigated(true)
        return true
      }
      if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey) {
        e.preventDefault()
        const lead = sources.find((src) => src.id === active.leadSourceId)
        if (enterPolicy !== 'native-commands' || !lead?.commandTrigger || !submit) {
          accept(selectedIndex)
          return true
        }
        const resolution = resolveEnter({
          query: active.match.query,
          names: active.entries.map((en) => en.source.getName?.(en.item) ?? null),
          selectedIndex,
          navigated
        })
        if (resolution.kind === 'entry') submitEntry(resolution.index)
        else submit(draft)
        return true
      }
      if (e.key === 'Tab') {
        e.preventDefault()
        accept(selectedIndex)
        return true
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
        return true
      }
      return false
    },
    [
      active,
      selectedIndex,
      accept,
      close,
      sources,
      enterPolicy,
      submit,
      navigated,
      submitEntry,
      draft
    ]
  )

  const transformSubmit = useCallback(
    (currentDraft: string) => {
      for (const src of sources) {
        if (!src.transformSubmit) continue
        const items = itemsBySource[src.id] ?? []
        const res = src.transformSubmit(currentDraft, items)
        if (res) return res
      }
      return null
    },
    [sources, itemsBySource]
  )

  const bumpUsageFromMessage = useCallback(
    async (text: string) => {
      // Match `/<token>` only at start-of-string or after whitespace; tokens are
      // [a-zA-Z0-9_:-]+, mirroring how skills/commands/agents/builtins name themselves
      // (`:` for plugin-namespaced CLI commands, e.g. `plugin:command`).
      const tokenRe = /(?:^|\s)\/([a-zA-Z0-9_:-]+)/g
      const tokens = new Set<string>()
      for (const m of text.matchAll(tokenRe)) tokens.add(m[1])
      if (tokens.size === 0) return

      const bumps: Array<Promise<unknown>> = []
      const bumped = new Set<string>() // dedup `${sourceId}:${name}`

      for (const tok of tokens) {
        let resolved: { sourceId: string; name: string } | null = null
        // Prefer items the user accepted from the menu — disambiguates name collisions.
        const picked = pickedRef.current.get(tok)
        if (picked) {
          resolved = picked
        } else {
          // Fallback: scan sources in registration order for a name match.
          for (const src of sources) {
            const items = itemsBySource[src.id] ?? []
            const getName = src.getName
            if (!getName) continue
            const hit = items.find((it) => getName(it) === tok)
            if (hit) {
              resolved = { sourceId: src.id, name: tok }
              break
            }
          }
        }
        if (!resolved) continue
        const key = `${resolved.sourceId}:${resolved.name}`
        if (bumped.has(key)) continue
        bumped.add(key)
        bumps.push(
          trpcClient.chat.bumpAutocompleteUsage
            .mutate({ source: resolved.sourceId, name: resolved.name })
            .catch(() => undefined)
        )
      }
      pickedRef.current.clear()
      if (bumps.length === 0) return
      await Promise.all(bumps)
      // Refresh usage map so the next ranking sees the new counts.
      await refreshUsage(trpcClient, setUsage)
    },
    [sources, itemsBySource, trpcClient]
  )

  return {
    show,
    active,
    selectedIndex,
    setSelectedIndex,
    accept,
    close,
    handleKeyDown,
    transformSubmit,
    bumpUsageFromMessage
  }
}

/**
 * A source's fetched items minus names that one of its `shadowedBy` sources
 * already lists (that source's richer entry wins; no duplicate rows).
 */
function unshadowed(
  src: AutocompleteSource,
  sources: AutocompleteSource[],
  itemsBySource: Record<string, unknown[]>
): unknown[] {
  const items = itemsBySource[src.id] ?? []
  const getName = src.getName
  if (!src.shadowedBy?.length || !getName) return items
  const taken = new Set<string>()
  for (const other of sources) {
    if (!src.shadowedBy.includes(other.id) || !other.getName) continue
    for (const it of itemsBySource[other.id] ?? []) taken.add(other.getName(it))
  }
  return taken.size === 0 ? items : items.filter((it) => !taken.has(getName(it)))
}

/** Helper: splice-replace text in draft from [tokenStart, tokenEnd) with `replacement`. */
export function spliceReplace(
  draft: string,
  tokenStart: number,
  tokenEnd: number,
  replacement: string
): string {
  return draft.slice(0, tokenStart) + replacement + draft.slice(tokenEnd)
}
