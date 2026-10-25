/**
 * Boot step recorder shared by the desktop main process and the hub.
 *
 * Each process marks named steps during its boot; at "booted" it records ONE
 * diagnostics event with a compact summary (total, step count, the largest
 * gaps), so slow boots in the field are visible without SLAYZONE_DEBUG_BOOT=1.
 * Recording a step is an array push — cheap enough to run unconditionally.
 */

export interface BootStep {
  step: string
  /** ms since the recorder started. */
  t: number
  /** ms since the previous step (or the start). */
  delta: number
}

export interface BootStepsSummary {
  totalMs: number
  steps: number
  /** Largest gaps first: [step, deltaMs, tMs]. */
  top: Array<[string, number, number]>
}

/** Longest step label kept in a summary — labels can embed paths/urls. */
const MAX_LABEL = 80
/**
 * Steps kept. Callers may keep logging after boot (e.g. a supervisor's restart
 * lines); past the cap a step still returns its timing but is not stored.
 */
const MAX_STEPS = 500

export interface BootStepRecorder {
  step: (name: string) => BootStep
  all: () => readonly BootStep[]
  summary: (topN?: number) => BootStepsSummary
}

export function createBootStepRecorder(
  now: () => number = () => performance.now(),
  startMs: number = now()
): BootStepRecorder {
  const steps: BootStep[] = []
  let last = startMs
  return {
    step: (name) => {
      const at = now()
      const entry = { step: name, t: Math.round(at - startMs), delta: Math.round(at - last) }
      last = at
      if (steps.length < MAX_STEPS) steps.push(entry)
      return entry
    },
    all: () => steps,
    summary: (topN = 8) => ({
      totalMs: steps.length ? steps[steps.length - 1].t : 0,
      steps: steps.length,
      top: [...steps]
        .sort((a, b) => b.delta - a.delta)
        .slice(0, topN)
        .map((s) => [s.step.slice(0, MAX_LABEL), s.delta, s.t])
    })
  }
}
