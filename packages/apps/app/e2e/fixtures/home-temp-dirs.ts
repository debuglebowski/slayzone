/**
 * Temp project folders under $HOME, for specs whose projects must live there
 * (the computer refuses project paths outside $HOME).
 *
 * The move specs used `mkdtempSync(~/.slz-e2e-move-*)` and never removed them:
 * 540 empty dirs piled up directly in ~, and a Finder window on ~ re-listed all
 * of them nonstop (fseventsd/Finder pegged, fs-watch suites starved).
 *
 * Now every dir lives under ONE parent, `~/.slz-e2e/`, named
 * `<prefix>-<pid>-<digits>` — the `.e2e-runtime` shape, so the global setup
 * prunes a crashed run's leftovers the same way (stale-runtime-dirs.ts). A spec
 * removes its own with `removeHomeTempDirs()` in `afterAll`.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const HOME_TEMP_ROOT = path.join(os.homedir(), '.slz-e2e')

let seq = 0
const created: string[] = []

/** A fresh, empty dir under `~/.slz-e2e/`, owned by this process. */
export function homeTempDir(prefix: string): string {
  fs.mkdirSync(HOME_TEMP_ROOT, { recursive: true })
  // Ends in >= 10 digits (ms + sequence) with the pid before it: the name shape
  // pruneStaleRuntimeDirs parses, unique within this process.
  const dir = path.join(
    HOME_TEMP_ROOT,
    `${prefix}-${process.pid}-${Date.now()}${String(seq++).padStart(4, '0')}`
  )
  fs.mkdirSync(dir)
  created.push(dir)
  return dir
}

/** Removes every dir homeTempDir made in this process. */
export function removeHomeTempDirs(): void {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
}
