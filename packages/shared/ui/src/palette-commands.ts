import { useEffect, useState, type ComponentType } from 'react'
import { create } from 'zustand'

/**
 * Context commands for the Cmd+K palette, published by whatever owns the current
 * context (today: the active task tab). The palette lives in `@slayzone/search`,
 * which depends on the task domain, so the task domain cannot import it — this
 * store is the seam both sides share.
 */

export type PaletteIcon = ComponentType<{ className?: string }>

/** A sub-page that lists more commands (e.g. the statuses under "Change status…"). */
export interface PaletteListPage {
  kind: 'list'
  title: string
  placeholder?: string
  items: PaletteCommand[]
  /**
   * Max hits root search shows from this page. For pages listing other entities
   * (tasks, projects, tags) — searching inside the page still shows all of them.
   */
  searchLimit?: number
}

/** A sub-page whose input is the value (e.g. a new subtask's title). Enter submits. */
export interface PalettePromptPage {
  kind: 'prompt'
  title: string
  placeholder: string
  /** Prefills the input (e.g. the current title when renaming). */
  initialValue?: string
  onSubmit: (value: string) => void | Promise<void>
}

export type PalettePage = PaletteListPage | PalettePromptPage

export interface PaletteCommand {
  /** Unique within its scope (page items included). */
  id: string
  label: string
  /** Extra text fuzzy search matches on, beyond `label`. */
  keywords?: string
  icon?: PaletteIcon
  iconClassName?: string
  /** Shortcut registry id; the palette shows its current key display. */
  shortcutId?: string
  /** Shown before anything is typed. */
  featured?: boolean
  /** The option currently in effect (in a picker page). */
  checked?: boolean
  /** Run on select. A command has `run` or `page`. */
  run?: () => void | Promise<void>
  /** Opens a sub-page on select. */
  page?: PalettePage
  /** Keep the palette open after `run` (multi-toggle pickers such as tags). */
  keepOpen?: boolean
  /** `run` moves focus itself; the palette must not restore focus when it closes. */
  takesFocus?: boolean
}

export interface PaletteScope {
  /** Identity of the context (task id). */
  key: string
  /** Heading of the palette section. */
  title: string
  commands: PaletteCommand[]
}

/** Commands a pane inside a context adds (e.g. the active chat tab of a task). */
interface PaletteContribution {
  /** The context they belong to (`PaletteScope.key`). */
  scopeKey: string
  commands: PaletteCommand[]
  /** Claim order: the most recently claimed contribution of a context is the one shown. */
  seq: number
}

interface PaletteCommandState {
  /**
   * What the palette shows: the published scope, with the commands of its most
   * recently claimed contribution first. Exactly the published object when
   * nothing contributes.
   */
  scope: PaletteScope | null
  owner: symbol | null
  /** The scope as published (without contributions). */
  base: PaletteScope | null
  contributions: ReadonlyMap<symbol, PaletteContribution>
  publish: (owner: symbol, scope: PaletteScope) => void
  /** Clears the scope only if `owner` still holds it. */
  retract: (owner: symbol) => void
  /** Add (or replace) `owner`'s commands to the context `scopeKey`, and claim it. */
  contribute: (owner: symbol, scopeKey: string, commands: PaletteCommand[]) => void
  /** `owner`'s contribution becomes the one shown for its context (e.g. its pane got focus). */
  claim: (owner: symbol) => void
  withdraw: (owner: symbol) => void
}

let claimSeq = 0

function withContribution(
  base: PaletteScope | null,
  contributions: ReadonlyMap<symbol, PaletteContribution>
): PaletteScope | null {
  if (!base) return null
  let best: PaletteContribution | null = null
  for (const c of contributions.values()) {
    if (c.scopeKey === base.key && (!best || c.seq > best.seq)) best = c
  }
  return best ? { ...base, commands: [...best.commands, ...base.commands] } : base
}

export const usePaletteCommandStore = create<PaletteCommandState>((set, get) => ({
  scope: null,
  owner: null,
  base: null,
  contributions: new Map(),
  publish: (owner, scope) =>
    set({ owner, base: scope, scope: withContribution(scope, get().contributions) }),
  retract: (owner) => {
    if (get().owner === owner) set({ owner: null, base: null, scope: null })
  },
  contribute: (owner, scopeKey, commands) => {
    const contributions = new Map(get().contributions)
    contributions.set(owner, { scopeKey, commands, seq: ++claimSeq })
    set({ contributions, scope: withContribution(get().base, contributions) })
  },
  claim: (owner) => {
    const current = get().contributions.get(owner)
    if (!current) return
    const contributions = new Map(get().contributions)
    contributions.set(owner, { ...current, seq: ++claimSeq })
    set({ contributions, scope: withContribution(get().base, contributions) })
  },
  withdraw: (owner) => {
    if (!get().contributions.has(owner)) return
    const contributions = new Map(get().contributions)
    contributions.delete(owner)
    set({ contributions, scope: withContribution(get().base, contributions) })
  }
}))

/**
 * Publish `scope` while `enabled`. Owner-tokened, so on a tab switch the old tab's
 * cleanup (which may run after the new tab published) cannot wipe the new scope.
 * Pass a `scope` whose identity changes only when its content does.
 */
export function usePublishPaletteCommands(scope: PaletteScope | null, enabled: boolean): void {
  const [owner] = useState(() => Symbol('palette-scope'))
  useEffect(() => {
    if (!enabled || !scope) return
    usePaletteCommandStore.getState().publish(owner, scope)
    return () => usePaletteCommandStore.getState().retract(owner)
  }, [owner, scope, enabled])
}

/**
 * Add `commands` to the context `scopeKey` (shown first in its section) while
 * `enabled`. Of several contributors to one context, the last to claim wins:
 * call the returned `claim` when the pane gets focus. Pass `commands` whose
 * identity changes only when their content does.
 */
export function usePaletteContribution(
  scopeKey: string,
  commands: PaletteCommand[],
  enabled: boolean
): { claim: () => void } {
  const [owner] = useState(() => Symbol('palette-contribution'))
  useEffect(() => {
    if (!enabled) return
    usePaletteCommandStore.getState().contribute(owner, scopeKey, commands)
    return () => usePaletteCommandStore.getState().withdraw(owner)
  }, [owner, scopeKey, commands, enabled])
  const [claim] = useState(() => () => usePaletteCommandStore.getState().claim(owner))
  return { claim }
}

export interface FlatPaletteCommand {
  command: PaletteCommand
  /** Titles of the pages above the command. */
  trail: string[]
  /** The nearest enclosing page's `searchLimit`, keyed by that page's command id. */
  limit?: { key: string; max: number }
  /** Id of the top-level command whose page (sub-pages included) holds this one. */
  rootId?: string
}

/** Every command in `commands`, sub-page items included, with the trail of page titles above it. */
export function flattenPaletteCommands(
  commands: PaletteCommand[],
  trail: string[] = [],
  limit?: FlatPaletteCommand['limit'],
  rootId?: string
): FlatPaletteCommand[] {
  const out: FlatPaletteCommand[] = []
  for (const command of commands) {
    out.push({ command, trail, limit, rootId })
    const page = command.page
    if (page?.kind === 'list') {
      const pageLimit =
        page.searchLimit !== undefined ? { key: command.id, max: page.searchLimit } : limit
      out.push(
        ...flattenPaletteCommands(
          page.items,
          [...trail, page.title],
          pageLimit,
          rootId ?? command.id
        )
      )
    }
  }
  return out
}
