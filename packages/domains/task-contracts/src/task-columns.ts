import type { Task } from './types'

/**
 * Task rows as columns: every key once (`keys`), each row its values in that order.
 * A board's rows share one key set, so this drops the per-row key names — about
 * half of a card-row board's bytes — and the objects the hub would walk to encode
 * them.
 */
export interface TaskColumns {
  keys: string[]
  values: unknown[][]
}

/**
 * `rows` as columns, or null when their key sets differ: a card row's missing field
 * must stay missing (`isFullTaskRow` tells rows apart by it), which columns cannot
 * say. Send the rows as they are then.
 */
export function encodeTaskColumns(rows: readonly Task[]): TaskColumns | null {
  const first = rows[0] as unknown as Record<string, unknown> | undefined
  const keys = first ? Object.keys(first) : []
  const values: unknown[][] = []
  for (const row of rows) {
    const r = row as unknown as Record<string, unknown>
    if (Object.keys(r).length !== keys.length) return null
    const vals: unknown[] = []
    for (const key of keys) {
      if (!(key in r)) return null
      vals.push(r[key])
    }
    values.push(vals)
  }
  return { keys, values }
}

/** The rows {@link encodeTaskColumns} encoded. */
export function decodeTaskColumns(cols: TaskColumns): Task[] {
  const { keys, values } = cols
  return values.map((vals) => {
    const row: Record<string, unknown> = {}
    for (let i = 0; i < keys.length; i++) row[keys[i]!] = vals[i]
    return row as unknown as Task
  })
}

/**
 * A board as its readers hold it: rows sent as columns (`taskColumns`) decoded into
 * `tasks`. A board without columns (an older hub) is returned as it is.
 */
export function decodeBoard<B extends { tasks: Task[]; taskColumns?: TaskColumns }>(board: B): B {
  if (!board.taskColumns) return board
  const { taskColumns, ...rest } = board
  return { ...rest, tasks: decodeTaskColumns(taskColumns) } as B
}
