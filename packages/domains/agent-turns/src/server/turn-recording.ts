/**
 * Where turn boundaries come from, wired once by the hub's composition.
 *
 * The hub owns `agent_turns`; the snapshot's git runs on the checkout's computer
 * (`turn-git-routing`). The two boundary sources both reach the hub:
 *  - an AGENT terminal: every submitted prompt (`onPtyInputSubmit` — every pty's
 *    input goes through the hub, wherever the pty runs). Plain shells are skipped
 *    by `initPtyTurnSubscriber`.
 *  - a chat tab: the computer-owned chat runtime's saved events, relayed to the
 *    hub (`user-message` → `result`).
 *
 * daf8d3bb4 moved these subscribers out of Electron main expecting the sidecar to
 * run them; nothing did, so no turn was recorded from 2026-08-06 until this.
 *
 * @module agent-turns/server/turn-recording
 */
import type { SlayzoneDb } from '@slayzone/platform'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { initChatTurnSubscriber, initPtyTurnSubscriber } from './turn-tracker'

/** The hub chat relay's event stream (`createHubChatRelay(...).events`). */
interface ChatEventStream {
  on(
    event: 'event',
    listener: (tabId: string, event: AgentEvent, seq: number, live?: number) => void
  ): unknown
  off(
    event: 'event',
    listener: (tabId: string, event: AgentEvent, seq: number, live?: number) => void
  ): unknown
}

export interface TurnRecordingSources {
  onPtyInputSubmit(cb: (sessionId: string, taskId: string, line: string) => void): () => void
  chatEvents: ChatEventStream
}

/** Subscribe turn recording to both sources; returns the unsubscribe. */
export function wireTurnRecording(db: SlayzoneDb, sources: TurnRecordingSources): () => void {
  const pty = initPtyTurnSubscriber(db)
  const offPty = sources.onPtyInputSubmit((sessionId, taskId, line) => {
    void pty(sessionId, taskId, line).catch((err) => {
      console.error('[turn-recording] pty boundary failed:', err)
    })
  })

  const chat = initChatTurnSubscriber(db)
  // Saved events only: the computer publishes each once, as it is saved (catch-up
  // reads history, it re-emits nothing). A live fragment repeats its saved event's
  // seq, and imported history (a resumed conversation's past) is not a new turn.
  const onChat = (tabId: string, event: AgentEvent, _seq: number, live?: number): void => {
    if (live !== undefined || (event as { history?: boolean }).history) return
    chat(tabId, event)
  }
  sources.chatEvents.on('event', onChat)

  return () => {
    offPty()
    sources.chatEvents.off('event', onChat)
  }
}
