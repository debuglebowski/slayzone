export type ProjectionMethod =
  | 'begin'
  | 'feed'
  | 'finish'
  | 'apply'
  | 'openSnapshot'
  | 'pagesAsOf'
  | 'toolDetail'
  | 'searchPages'
  | 'searchToolMatches'
  | 'flush'
  | 'close'
export type StoreMethod =
  | 'loadCheckpoint'
  | 'loadPages'
  | 'loadSummaries'
  | 'save'
  | 'searchPages'
  | 'discard'
export type RecordMethod = 'load' | 'pageIds' | 'loadSummaries' | 'searchPages' | 'save' | 'discard'
export type WorkerCall = {
  type: 'call'
  id: number
  projectionId: number
  method: ProjectionMethod
  args: unknown[]
}
export type StoreCall = {
  type: 'store'
  id: number
  projectionId: number
  raw: boolean
  method: StoreMethod | RecordMethod
  args: unknown[]
}
export type Reply = { type: 'result'; id: number; usable?: boolean } & (
  | { ok: true; value: unknown }
  | { ok: false; error: string }
)

export type WorkerNotice = { type: 'notice'; projectionId: number; what: string; error: string }
