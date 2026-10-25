/**
 * Contract between the dev launcher (packages/apps/app/dev.mjs) and main
 * (src/main/index.ts). Both sides hard-code values the other relies on; dev.mjs
 * is plain node (no TS import), so this test is what keeps them in step:
 *   - DEV_RELAUNCH_EXIT_CODE: main exits with it to ask for a relaunch under
 *     `pnpm dev`; the launcher restarts electron-vite on it. Drift = relaunch
 *     silently becomes "app quits and the dev server dies".
 *   - SHUTDOWN_GRACE_MS > QUIT_WATCHDOG_MS: the launcher waits for a draining
 *     quit before SIGKILL. Shorter = the hub/computer drain is cut off.
 *
 * Run with: npx tsx packages/apps/app/src/main/dev-launcher-contract.test.ts
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))

const mainSrc = readFileSync(join(here, 'index.ts'), 'utf8')
const launcherSrc = readFileSync(join(here, '..', '..', 'dev.mjs'), 'utf8')
const packageJson = JSON.parse(readFileSync(join(here, '..', '..', 'package.json'), 'utf8'))

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passed++
  } catch (e) {
    console.error(`  ✗ ${name}`)
    console.error(`    ${e instanceof Error ? e.message : e}`)
    failed++
  }
}

function numericConst(src: string, name: string, file: string): number {
  const m = src.match(new RegExp(`const ${name} = ([\\d_]+)\\b`))
  if (!m) throw new Error(`${name} not found in ${file}`)
  return Number(m[1].replace(/_/g, ''))
}

console.log('\ndev launcher ↔ main contract')

test('relaunch exit code matches on both sides', () => {
  const main = numericConst(mainSrc, 'DEV_RELAUNCH_EXIT_CODE', 'index.ts')
  const launcher = numericConst(launcherSrc, 'DEV_RELAUNCH_EXIT_CODE', 'dev.mjs')
  if (main !== launcher) throw new Error(`index.ts=${main} vs dev.mjs=${launcher}`)
})

test('launcher shutdown grace outlasts the main quit watchdog', () => {
  const grace = numericConst(launcherSrc, 'SHUTDOWN_GRACE_MS', 'dev.mjs')
  const watchdog = numericConst(mainSrc, 'QUIT_WATCHDOG_MS', 'index.ts')
  if (grace <= watchdog)
    throw new Error(`SHUTDOWN_GRACE_MS=${grace} <= QUIT_WATCHDOG_MS=${watchdog}`)
})

test('every electron-vite dev script goes through the launcher', () => {
  // A script running `electron-vite dev` directly still sets
  // ELECTRON_RENDERER_URL (→ isViteDev), so relaunch would exit 75 with
  // nobody there to restart it.
  for (const [name, cmd] of Object.entries(packageJson.scripts as Record<string, string>)) {
    if (/\belectron-vite dev\b/.test(cmd)) {
      throw new Error(`script "${name}" bypasses dev.mjs: ${cmd}`)
    }
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
