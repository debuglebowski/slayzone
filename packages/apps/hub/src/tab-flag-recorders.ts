import type { SlayzoneDb } from '@slayzone/platform'
import { setTabAgentState } from '@slayzone/task-terminals/server'
import {
  setPtyAgentStateTabRecorder,
  setChatAgentStateTabRecorder,
  type AgentStateRecorder
} from '@slayzone/terminal/server'

/**
 * Wire `terminal_tabs.agent_state` to the process that actually owns the
 * sessions.
 *
 * pty-manager / chat-transport-manager record how each agent ended through an
 * injected recorder (`running` on spawn, `auto_stopped` on idle-close, `stopped` on
 * any other exit — unless the shutdown gate is set). The recorders were installed
 * ONLY by the Electron host. Once the pty runtime moved into the side-car and
 * spawning moved to the computer, the host owned no sessions, so its recorder
 * never fired and nothing in this process installed one: no live agent was ever
 * recorded, `listAutoRestoreTasks` returned nothing, and a restart came up on the
 * Start gate. The idle-close half was never wired anywhere, so an idle-closed
 * agent lost its 💤 / Reopen status on reload. Same orphaning as the idle-close
 * config and the warm pool.
 *
 * Extracted from `composition.ts` so the wiring is assertable without booting
 * the whole server (same reason `hub-trpc-context` / `rest-auth` were pulled
 * out) — see `tab-flag-recorders.test.ts`.
 *
 * Fire-and-forget by design: `setTabAgentState` is called from spawn/exit
 * handlers on the hot path, and a failed write must never take down a session.
 * Worst case is a stale state, which the next spawn/exit corrects.
 */
export function wireTabFlagRecorders(db: SlayzoneDb): void {
  const record: AgentStateRecorder = (tabId, state) => {
    void setTabAgentState(db, tabId, state).catch(() => {
      /* best-effort — see above */
    })
  }
  setPtyAgentStateTabRecorder(record)
  setChatAgentStateTabRecorder(record)
}
