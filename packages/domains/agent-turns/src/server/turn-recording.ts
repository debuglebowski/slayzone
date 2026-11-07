/**
 * Where turn boundaries come from, wired once by the hub's composition.
 *
 * The hub owns `agent_turns`; the snapshot's git runs on the checkout's computer
 * (`turn-git-routing`). The two boundary sources both reach the hub:
 *  - an AGENT terminal: every submitted prompt (`onPtyInputSubmit` — every pty's
 *    input goes through the hub, wherever the pty runs). Plain shells are skipped
 *    by `initPtyTurnSubscriber`.
 *  - a chat tab: the computer-owned chat runtime's saved events. A turn ends at
 *    each saved `result`, read from the signal the computer sends the hub for every
 *    saved event (`saved`), so it records also for a tab on the direct link, whose
 *    full events the hub never sees (docs/direct-link.md). The prompt preview comes
 *    from a full `user-message` when the hub does see it.
 *
 * daf8d3bb4 moved these subscribers out of Electron main expecting the sidecar to
 * run them; nothing did, so no turn was recorded from 2026-08-06 until this.
 *
 * @module agent-turns/server/turn-recording
 */
import type { SlayzoneDb } from '@slayzone/platform'
import type { AgentEvent, ChatSavedSummary } from '@slayzone/terminal-contracts'
import { initChatTurnSubscriber, initPtyTurnSubscriber } from './turn-tracker'

type FullEventListener = (tabId: string, event: AgentEvent, seq: number, live?: number) => void
type SavedListener = (tabId: string, saved: ChatSavedSummary) => void

/** The hub chat relay's event stream (`createHubChatRelay(...).events`). */
interface ChatEventStream {
  on(event: 'event', listener: FullEventListener): unknown
  on(event: 'saved', listener: SavedListener): unknown
  off(event: 'event', listener: FullEventListener): unknown
  off(event: 'saved', listener: SavedListener): unknown
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
  // The prompt, when the full event reaches the hub. Saved events only (a live
  // fragment repeats its saved event's seq); imported history (a resumed
  // conversation's past) is not a new turn.
  const onChat: FullEventListener = (tabId, event, _seq, live) => {
    if (live !== undefined || (event as { history?: boolean }).history) return
    if (event.kind === 'user-message') chat(tabId, event)
  }
  // The turn's end, from the signal sent for every saved event, relayed or not:
  // once per result whichever path the tab's clients use.
  const onSaved: SavedListener = (tabId, saved) => {
    if (saved.history || saved.kind !== 'result') return
    chat(tabId, { kind: 'result' } as AgentEvent)
  }
  sources.chatEvents.on('event', onChat)
  sources.chatEvents.on('saved', onSaved)

  return () => {
    offPty()
    sources.chatEvents.off('event', onChat)
    sources.chatEvents.off('saved', onSaved)
  }
}
