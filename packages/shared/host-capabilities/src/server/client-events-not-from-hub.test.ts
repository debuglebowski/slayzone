/**
 * No renderer listens to a hub for a client-local menu event (task 557ebb72, R3).
 *
 * The hub-side paths never fire (menu-router.test.ts), but a client that still
 * subscribed would silently lose the native menu again — and on an older hub that
 * does fire them, it would obey a hub's `screenshot-trigger` / `reload-app`. These
 * events come from this device's client host (`useClientHostEvent`) only.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from 'vitest'

const ROOT = fileURLToPath(new URL('../../../../..', import.meta.url))
const CLIENT_LOCAL_SUBS = [
  'onGoHome',
  'onToggleGlobalAgentPanel',
  'onToggleAgentStatusPanel',
  'onOpenSettings',
  'onOpenProjectSettings',
  'onNewTemporaryTask',
  'onScreenshotTrigger',
  'onCloseCurrentFocus',
  'onCloseActiveTask',
  'onSyncSessionId',
  'onReloadBrowser',
  'onReloadApp',
  'onZoomFactorChanged',
  'onUpdateStatus'
]
const PATTERN = new RegExp(
  `\\bmenu\\.(${CLIENT_LOCAL_SUBS.join('|')})\\s*\\.\\s*(subscriptionOptions|subscribe)\\b`
)

function* sources(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === 'dist' || name === 'out' || name === 'e2e') continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) yield* sources(p)
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) yield p
  }
}

test('no client code subscribes to a hub for a client-local menu event', () => {
  const offenders: string[] = []
  for (const group of ['apps', 'domains', 'shared']) {
    for (const pkg of readdirSync(join(ROOT, 'packages', group))) {
      const src = join(ROOT, 'packages', group, pkg, 'src')
      try {
        statSync(src)
      } catch {
        continue
      }
      for (const file of sources(src)) {
        // The hub's own router + its test harness define these paths.
        if (file.includes('host-capabilities/src/server/menu-router')) continue
        if (file.includes('apps/hub/src/owner-checks-harness')) continue
        const lines = readFileSync(file, 'utf8').split('\n')
        lines.forEach((line, i) => {
          if (PATTERN.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1}`)
        })
      }
    }
  }
  expect(offenders).toEqual([])
})
