/**
 * Test-only helpers for the task-edit suites (never imported by app code): a hub that
 * answers the task writes and records every call, by procedure path — two of them side
 * by side show which hub a write went to.
 */
import type { FakeHubs } from '../hubs/testing'

export interface Call {
  path: string
  input: unknown
}

export type Answer = (input: unknown) => unknown

/** The task procedures the editor uses, answered with plain defaults. */
const DEFAULTS: Record<string, Answer> = {
  'task.update': (input) => ({ ...(input as object) }),
  'task.create': (input) => ({ id: 'created', ...(input as object) }),
  'task.get': () => null,
  'task.delete': () => true,
  'task.archive': (input) => ({ ...(input as object), archived_at: 'now' }),
  'task.unarchive': (input) => ({ ...(input as object), archived_at: null }),
  'task.getBlockers': () => [],
  'task.addBlocker': () => undefined,
  'task.removeBlocker': () => undefined,
  'tags.setForTask': () => undefined,
  'template.getByProject': () => []
}

/** Serves `hubId`; `answers` replace defaults (throw in one to fail that call). */
export function serveTaskHub(
  hubs: FakeHubs,
  hubId: string,
  answers: Record<string, Answer> = {}
): Call[] {
  const calls: Call[] = []
  const procedures = Object.fromEntries(
    Object.entries({ ...DEFAULTS, ...answers }).map(([path, answer]) => [
      path,
      (input: unknown) => {
        calls.push({ path, input })
        return answer(input)
      }
    ])
  )
  hubs.serve(hubId, {
    procedures,
    subscriptions: { 'notify.onTasksChanged': () => undefined }
  })
  return calls
}

/** The writes among `calls` (reads left out). */
export const writes = (calls: readonly Call[]): Call[] =>
  calls.filter((c) => !/\.(get|getBlockers|getByProject)$/.test(c.path))
