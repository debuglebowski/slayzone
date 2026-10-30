import { createContext, useContext, useState } from 'react'
import { useDepsChanged, useStableCallback } from '@slayzone/ui'
import { useChatView } from './ChatViewContext'

/**
 * The key of the timeline row being rendered (its `itemKey`). A row nested in
 * another (a sub-agent's tool call) gets `<parent key>>` + its own key.
 */
export const TimelineRowKeyContext = createContext<string | null>(null)

/** Separator of a nested row's key from its root row's. */
const NESTED = '>'

export function nestedRowKey(parent: string, child: string): string {
  return `${parent}${NESTED}${child}`
}

function rootOf(rowKey: string): string {
  const at = rowKey.indexOf(NESTED)
  return at < 0 ? rowKey : rowKey.slice(0, at)
}

/**
 * UI state of timeline rows that must outlive the row's mount — what is
 * expanded. The timeline is virtualized: a row scrolled out of view unmounts,
 * and its own `useState` would come back at its default.
 *
 * "Collapse all" closes every row that exists at that moment, mounted or not;
 * a row added later keeps its own default (as before virtualization).
 */
export class RowUiStateStore {
  private readonly values = new Map<string, { value: unknown; collapsible: boolean }>()
  private collapsedRoots: ReadonlySet<string> = new Set()

  read<T>(rowKey: string, name: string, initial: T, closed?: T): T {
    const entry = this.values.get(`${rowKey}/${name}`)
    if (entry) return entry.value as T
    if (closed !== undefined && this.collapsedRoots.has(rootOf(rowKey))) return closed
    return initial
  }

  write(rowKey: string, name: string, value: unknown, collapsible: boolean): void {
    this.values.set(`${rowKey}/${name}`, { value, collapsible })
  }

  /** "Collapse all": the rows that exist now (their keys) read closed until toggled. */
  collapseAll(rowKeys: Iterable<string>): void {
    for (const [key, entry] of this.values) if (entry.collapsible) this.values.delete(key)
    this.collapsedRoots = new Set(rowKeys)
  }
}

/**
 * "Collapse all" over the displayed rows (`itemKey`s), mounted or not; the
 * caller also bumps `collapseSignal` for the mounted ones.
 */
export function collapseAllRows<T>(
  store: RowUiStateStore | null,
  items: readonly T[],
  itemKey: (item: T, index: number) => unknown
): void {
  store?.collapseAll(items.map((item, i) => String(itemKey(item, i))))
}

/** One store per chat panel (provided by `ChatPanel`). */
export const RowUiStateContext = createContext<RowUiStateStore | null>(null)

/**
 * `useState` for a timeline row's UI state that survives the row unmounting
 * (scrolled away) and remounting. `closed` makes it a disclosure: "Collapse
 * all" (`collapseSignal`) sets it to `closed` — on rows on screen at once, and
 * on rows off screen when they mount. Outside a timeline row it is plain state.
 */
export function useRowUiState<T>(name: string, initial: T, closed?: T): [T, (next: T) => void] {
  const rowKey = useContext(TimelineRowKeyContext)
  const store = useContext(RowUiStateContext)
  const { collapseSignal } = useChatView()
  const [value, setValue] = useState<T>(() =>
    store && rowKey !== null ? store.read(rowKey, name, initial, closed) : initial
  )
  // "Collapse all": on a CHANGE of the signal only, adjusted during render — so
  // mounting (incl. under an already-bumped signal) keeps what `read` gave.
  const collapseBumped = useDepsChanged([collapseSignal])
  if (collapseBumped && closed !== undefined && !Object.is(value, closed)) setValue(closed)
  const set = useStableCallback((next: T): void => {
    setValue(next)
    if (store && rowKey !== null) store.write(rowKey, name, next, closed !== undefined)
  })
  return [value, set]
}
