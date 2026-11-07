/**
 * The chunks a catch-up writes: what the scrollback returned (`missed`) plus the
 * live chunks held while it was in flight (`held`) — each seq once, in order,
 * nothing at or below what is already rendered or at or below a clear.
 *
 * @module terminal/client/catch-up-merge
 */
export interface SeqChunk {
  seq: number
  data: string
}

export function mergeCatchUp(
  lastRendered: number,
  missed: readonly SeqChunk[],
  held: readonly SeqChunk[],
  clearedSeq: number | null
): SeqChunk[] {
  const floor = Math.max(lastRendered, clearedSeq ?? -1)
  const bySeq = new Map<number, SeqChunk>()
  for (const chunk of [...missed, ...held]) {
    if (chunk.seq <= floor || bySeq.has(chunk.seq)) continue
    bySeq.set(chunk.seq, chunk)
  }
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
