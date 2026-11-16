/**
 * "Needs attention": items a pass could not process (P3 — one bad item fails
 * alone). Faults come from the hub's own ledger and quarantine, and from each
 * computer's (mirrored on the hub so task badges work while it is offline).
 */
export type ItemFaultSource = 'ledger' | 'quarantine'

/** Addresses one fault for Retry / Discard. */
export interface ItemFaultRef {
  /** null = the hub itself. */
  computerId: string | null
  /** Which side recorded it: the hub (about this computer) or the computer itself. */
  origin: 'hub' | 'computer'
  source: ItemFaultSource
  pass: string
  /** Ledger: the item key. Quarantine: the quarantine entry id. */
  key: string
}

export interface ItemFaultView extends ItemFaultRef {
  taskId: string | null
  /** transient = retried with backoff; structural = set aside until it changes. */
  kind: 'transient' | 'structural'
  message: string
  attempts: number
  firstAt: number
  lastAt: number
  /** Retry runs it again now (quarantine: moves it back where it was). */
  retryable: boolean
  /** Discard permanently deletes the item. Always behind a confirmation. */
  discardable: boolean
}

/** What a computer reports of its own faults (`faults.list` chat request). */
export interface ComputerFaultSnapshot {
  faults: Array<Omit<ItemFaultView, 'computerId' | 'origin'>>
}
