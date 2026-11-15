import { Worker } from 'node:worker_threads'
import { createTimelineWorkerPool } from '@slayzone/terminal/timeline-worker'

// build.mjs embeds this bundle so published computers need no workspace files.
declare const __SLAYZONE_TIMELINE_WORKER_SOURCE__: string | undefined
export function createComputerTimelineWorkers() {
  // Unbundled handler unit tests keep their injected, in-process projection.
  if (typeof __SLAYZONE_TIMELINE_WORKER_SOURCE__ !== 'string') return undefined
  return createTimelineWorkerPool(
    () =>
      new Worker(__SLAYZONE_TIMELINE_WORKER_SOURCE__, {
        eval: true,
        name: 'chat-timeline'
      })
  )
}
