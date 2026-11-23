import type { TimelinePageSummary } from './timeline-summary'

type SummaryFields = {
  u?: TimelinePageSummary['users']
  e?: TimelinePageSummary['ends']
  b?: TimelinePageSummary['branches']
  f?: TimelinePageSummary['files']
  d?: TimelinePageSummary['boundaries']
  a?: TimelinePageSummary['asks']
}

type PackedSummary = number | [rootRows: number, fields: SummaryFields]

function packSummary(summary: TimelinePageSummary): PackedSummary {
  const fields: SummaryFields = {}
  if (summary.users.length) fields.u = summary.users
  if (summary.ends.length) fields.e = summary.ends
  if (summary.branches.length) fields.b = summary.branches
  if (summary.files.length) fields.f = summary.files
  if (summary.boundaries.length) fields.d = summary.boundaries
  if (summary.asks.length) fields.a = summary.asks
  return Object.keys(fields).length ? [summary.rootRows, fields] : summary.rootRows
}

/** Keep one entry per page while omitting empty lists and repeated field names. */
export function unpackTimelineSummary(summary: PackedSummary): TimelinePageSummary {
  const [rootRows, fields] = typeof summary === 'number' ? [summary, undefined] : summary
  return {
    rootRows,
    users: fields?.u ?? [],
    ends: fields?.e ?? [],
    branches: fields?.b ?? [],
    files: fields?.f ?? [],
    boundaries: fields?.d ?? [],
    asks: fields?.a ?? []
  }
}

/** Only the open reply changes. Persisted checkpoints still use their text codec. */
export function packTimelineOpen<T extends { state: string; summaries: TimelinePageSummary[] }>(
  snapshot: T
): T | (Omit<T, 'state' | 'summaries'> & { state: object; summaries: PackedSummary[] }) {
  // Tool inputs can have arbitrary JSON keys. SuperJSON reserves these keys,
  // so carry their checkpoint as opaque text as we did before.
  if (/[{,]"(?:__proto__|constructor|prototype)":/.test(snapshot.state)) return snapshot
  return {
    ...snapshot,
    state: JSON.parse(snapshot.state) as object,
    summaries: snapshot.summaries.map(packSummary)
  }
}
