import { useEffect, useState, useSyncExternalStore } from 'react'
import { useStableCallback } from '@slayzone/ui'
import { useTRPCClient } from './trpc'
import type { AgentEvent } from '@slayzone/terminal-contracts'
import { parseVoiceSettings, VOICE_SETTINGS_KEY } from '../shared'
import { VoiceSession, type VoiceSessionStatus } from './voice-session'

/**
 * Conversation mode is on for at most ONE chat tab in this window (one mic, one
 * pair of headphones): turning it on in a tab turns it off everywhere else.
 */
let activeTab: string | null = null
/** Bumped when the voice settings change: a running session restarts with them. */
let settingsRevision = 0
const subscribers = new Set<() => void>()

export function voiceSettingsChanged(): void {
  settingsRevision++
  for (const s of subscribers) s()
}

function setActiveTab(tabId: string | null): void {
  activeTab = tabId
  for (const s of subscribers) s()
}

function subscribe(cb: () => void): () => void {
  subscribers.add(cb)
  return () => {
    subscribers.delete(cb)
  }
}

export interface UseVoiceModeOpts {
  tabId: string
  sendMessage: (text: string, opts: { id: string }) => Promise<void>
  subscribeEvents: (listener: (event: AgentEvent) => void) => () => void
}

export interface UseVoiceModeResult {
  enabled: boolean
  toggle: () => void
  status: VoiceSessionStatus | null
}

export function useVoiceMode({
  tabId,
  sendMessage,
  subscribeEvents
}: UseVoiceModeOpts): UseVoiceModeResult {
  const enabled = useSyncExternalStore(subscribe, () => activeTab === tabId)
  const revision = useSyncExternalStore(subscribe, () => settingsRevision)
  const [status, setStatus] = useState<VoiceSessionStatus | null>(null)
  const trpc = useTRPCClient()
  const sendTurn = useStableCallback((text: string, id: string) => sendMessage(text, { id }))
  const onEvents = useStableCallback((listener: (event: AgentEvent) => void) =>
    subscribeEvents(listener)
  )

  useEffect(() => {
    if (!enabled) return
    void revision
    let session: VoiceSession | null = null
    let cancelled = false
    trpc.settings.get
      .query({ key: VOICE_SETTINGS_KEY })
      .catch(() => null)
      .then((raw) => {
        if (cancelled) return
        session = new VoiceSession({
          settings: parseVoiceSettings(typeof raw === 'string' ? raw : null),
          sendTurn,
          subscribeEvents: onEvents,
          onStatus: setStatus
        })
      })
    return () => {
      cancelled = true
      session?.stop()
      setStatus(null)
    }
  }, [enabled, revision, trpc, sendTurn, onEvents])

  // The tab goes away: its mic must not stay open.
  useEffect(
    () => () => {
      if (activeTab === tabId) setActiveTab(null)
    },
    [tabId]
  )

  const toggle = useStableCallback(() => setActiveTab(activeTab === tabId ? null : tabId))
  return { enabled, toggle, status }
}
