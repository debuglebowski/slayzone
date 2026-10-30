import { createContext, useContext, useState } from 'react'
import { useDepsChanged, useStableCallback } from '@slayzone/ui'
import { useChatView } from './ChatViewContext'

/**
 * The key of the timeline row being rendered (its `itemKey`). A row nested in
 * another (a sub-agent's tool call) gets `<parent key>>` + its own key.
 */
export const TimelineRowKeyContext = createContext<string | null>(null)

/**
 * The timeline index of the root row being rendered (paged history: "Collapse
 * all" closes rows that existed then, loaded or not, by index).
 */
export const TimelineRowIndexContext = createContext<number | undefined>(undefined)

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
 * "Collapse all" closes every row that exists at that moment, mounted or not —
 * and loaded or not (paged history: every row with a lower index than the
 * rows there were); a row added later keeps its own default.
 */
export class RowUiStateStore {
  private readonly values = new Map<string, { value: unknown; collapsible: boolean }>()
  private collapsedRoots: ReadonlySet<string> = new Set()
  /** Rows with a lower timeline index existed at the last "Collapse all". */
  private collapsedBefore = 0

  read<T>(rowKey: string, name: string, initial: T, closed?: T, row?: number): T {
    const entry = this.values.get(`${rowKey}/${name}`)
    if (entry) return entry.value as T
    if (closed !== undefined) {
      if (this.collapsedRoots.has(rootOf(rowKey))) return closed
      if (row !== undefined && row < this.collapsedBefore) return closed
    }
    return initial
  }

  write(rowKey: string, name: string, value: unknown, collapsible: boolean): void {
    this.values.set(`${rowKey}/${name}`, { value, collapsible })
  }

  /**
   * "Collapse all": the rows that exist now (their keys, and every row index
   * below `rowCount`) read closed until toggled.
   */
  collapseAll(rowKeys: Iterable<string>, rowCount = 0): void {
    for (const [key, entry] of this.values) if (entry.collapsible) this.values.delete(key)
    this.collapsedRoots = new Set(rowKeys)
    this.collapsedBefore = rowCount
  }
}

/**
 * "Collapse all" over the displayed rows (`itemKey`s), mounted or not; the
 * caller also bumps `collapseSignal` for the mounted ones.
 */
export function collapseAllRows<T>(
  store: RowUiStateStore | null,
  items: readonly T[],
  itemKey: (item: T, index: number) => unknown,
  /** The timeline's length: rows not loaded (paged history) close too. */
  rowCount = 0
): void {
  store?.collapseAll(
    items.map((item, i) => String(itemKey(item, i))),
    rowCount
  )
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
  const rowIndex = useContext(TimelineRowIndexContext)
  const store = useContext(RowUiStateContext)
  const { collapseSignal } = useChatView()
  const [value, setValue] = useState<T>(() =>
    store && rowKey !== null ? store.read(rowKey, name, initial, closed, rowIndex) : initial
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
