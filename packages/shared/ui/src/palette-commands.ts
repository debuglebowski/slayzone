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

interface PaletteCommandState {
  scope: PaletteScope | null
  owner: symbol | null
  publish: (owner: symbol, scope: PaletteScope) => void
  /** Clears the scope only if `owner` still holds it. */
  retract: (owner: symbol) => void
}

export const usePaletteCommandStore = create<PaletteCommandState>((set, get) => ({
  scope: null,
  owner: null,
  publish: (owner, scope) => set({ owner, scope }),
  retract: (owner) => {
    if (get().owner === owner) set({ owner: null, scope: null })
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

export interface FlatPaletteCommand {
  command: PaletteCommand
  /** Titles of the pages above the command. */
  trail: string[]
  /** The nearest enclosing page's `searchLimit`, keyed by that page's command id. */
  limit?: { key: string; max: number }
}

/** Every command in `commands`, sub-page items included, with the trail of page titles above it. */
export function flattenPaletteCommands(
  commands: PaletteCommand[],
  trail: string[] = [],
  limit?: FlatPaletteCommand['limit']
): FlatPaletteCommand[] {
  const out: FlatPaletteCommand[] = []
  for (const command of commands) {
    out.push({ command, trail, limit })
    const page = command.page
    if (page?.kind === 'list') {
      const pageLimit =
        page.searchLimit !== undefined ? { key: command.id, max: page.searchLimit } : limit
      out.push(...flattenPaletteCommands(page.items, [...trail, page.title], pageLimit))
    }
  }
  return out
}
