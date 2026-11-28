/**
 * Per-turn latency, every stage measured from the moment the keyword was spoken
 * (end of the speech segment that carried it). Null = the stage never happened
 * (a silent reply has no first audio).
 */
export interface TurnLatency {
  turnId: string
  reason: 'keyword' | 'timeout'
  /** Keyword spoken → its transcript ready. */
  sttMs: number
  /** Keyword spoken → turn handed to the chat (includes the keyword-silence wait). */
  sentMs: number
  /** Keyword spoken → the agent's first reply token. */
  firstTokenMs: number | null
  /** Keyword spoken → the first complete sentence of the reply. */
  firstSentenceMs: number | null
  /** Keyword spoken → the first reply audio playing. */
  firstAudioMs: number | null
  /** TTS time of the first sentence alone. */
  firstSynthMs: number | null
}

export const LATENCY_STAGES = [
  'sttMs',
  'sentMs',
  'firstTokenMs',
  'firstSentenceMs',
  'firstAudioMs',
  'firstSynthMs'
] as const

export type LatencyStage = (typeof LATENCY_STAGES)[number]

export interface StageStats {
  n: number
  p50: number
  p95: number
}

/** Nearest-rank percentile of an unsorted sample. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil((p / 100) * sorted.length)
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]
}

export function latencyStats(samples: readonly TurnLatency[]): Record<LatencyStage, StageStats> {
  const out = {} as Record<LatencyStage, StageStats>
  for (const stage of LATENCY_STAGES) {
    const values = samples.map((s) => s[stage]).filter((v): v is number => v !== null)
    out[stage] = { n: values.length, p50: percentile(values, 50), p95: percentile(values, 95) }
  }
  return out
}
