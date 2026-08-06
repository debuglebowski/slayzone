import type { SlayzoneDb } from '@slayzone/platform'
import { markTabSpawned } from '@slayzone/task-terminals/server'
import { setPtySpawnedTabRecorder, setChatSpawnedTabRecorder } from '@slayzone/terminal/server'

/**
 * Wire `terminal_tabs.was_spawned` to the process that actually owns the
 * sessions.
 *
 * pty-manager / chat-transport-manager flip this flag through an injected
 * recorder (true on spawn, false on exit — unless the shutdown gate is set).
 * The recorder was installed ONLY by the Electron host. Once the pty runtime
 * moved into the side-car and spawning moved to the runner, the host owned no
 * sessions, so its recorder never fired and nothing in this process installed
 * one: `was_spawned` stayed 0 for every live agent, `listAutoRestoreTasks`
 * returned nothing, and a restart came up on the Start gate. Third instance of
 * the same orphaning (idle-close config, warm pool, this).
 *
 * Extracted from `composition.ts` so the wiring is assertable without booting
 * the whole server (same reason `hub-trpc-context` / `rest-auth` were pulled
 * out) — see `tab-flag-recorders.test.ts`.
 *
 * Fire-and-forget by design: `markTabSpawned` is called from spawn/exit
 * handlers on the hot path, and a failed flag write must never take down a
 * session. Worst case is a stale flag, which the next spawn/exit corrects.
 */
export function wireTabFlagRecorders(db: SlayzoneDb): void {
  const recordSpawned = (tabId: string, wasSpawned: boolean): void => {
    void markTabSpawned(db, tabId, wasSpawned).catch(() => {
      /* best-effort — see above */
    })
  }
  setPtySpawnedTabRecorder(recordSpawned)
  setChatSpawnedTabRecorder(recordSpawned)
}
