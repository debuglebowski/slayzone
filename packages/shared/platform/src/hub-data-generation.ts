/**
 * Which "generation" of data a hub serves. It changes only when the hub's data was
 * REPLACED — a backup restore swapped in at boot — never on a plain restart. Clients
 * read it from `hub.describe` (`dataGeneration`) and reload when it changes, since
 * every view they hold describes data that no longer exists.
 *
 * Opaque on purpose: a random id, no backup name, no time — `hub.describe` is open,
 * and all it may tell anyone is "this is different data than before".
 *
 * Kept in `<dataRoot>/hub.data-generation.json`, outside the database: a restored
 * database is the backup's, so a value inside it would go back in time with it.
 * Lean leaf (node builtins only).
 *
 * @module platform/hub-data-generation
 */
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { join } from 'node:path'

export const DATA_GENERATION_FILE = 'hub.data-generation.json'

/** Before any restore: every hub starts here. */
export const INITIAL_DATA_GENERATION = 'initial'

/** This hub's data generation; {@link INITIAL_DATA_GENERATION} when none was written. */
export function readDataGeneration(dataRoot: string): string {
  try {
    const parsed = JSON.parse(readFileSync(join(dataRoot, DATA_GENERATION_FILE), 'utf8')) as {
      generation?: unknown
    }
    return typeof parsed.generation === 'string' && parsed.generation
      ? parsed.generation
      : INITIAL_DATA_GENERATION
  } catch {
    return INITIAL_DATA_GENERATION
  }
}

/** Start a new generation (the data was replaced). Durable: written, fsynced, renamed. */
export function startNewDataGeneration(dataRoot: string): string {
  const generation = randomUUID()
  const path = join(dataRoot, DATA_GENERATION_FILE)
  const tmp = `${path}.tmp`
  const fd = openSync(tmp, 'w', 0o644)
  try {
    writeSync(fd, JSON.stringify({ v: 1, generation }))
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, path)
  return generation
}
