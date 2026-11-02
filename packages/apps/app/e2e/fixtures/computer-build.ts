/**
 * Shared computer-bundle builder for e2e.
 *
 * The app prebuild bundles the computer; direct e2e launches also need it —
 * every worker's app spawns the co-located computer from `dist/bin.cjs`. So the
 * bundle has to exist before ANY spec launches, which is why `global-setup.ts`
 * calls this once per run rather than each computer spec doing it itself.
 *
 * Loopback specs share this builder when spawning an explicit computer.
 */

import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const APP_DIR = path.resolve(__dirname, '..', '..')
const COMPUTER_DIR = path.resolve(APP_DIR, '..', 'computer')

/** Absolute path to the bundle the local-computer supervisor spawns. */
export const COMPUTER_BIN = path.join(COMPUTER_DIR, 'dist', 'bin.cjs')

/** Build all bundled workspace inputs. Checking only computer/src misses domain changes. */
export function ensureComputerBuilt(): void {
  execFileSync('node', ['build.mjs'], { cwd: COMPUTER_DIR, stdio: 'inherit' })
  if (!fs.existsSync(COMPUTER_BIN)) {
    throw new Error(`computer build did not produce ${COMPUTER_BIN}`)
  }
}
