/**
 * The chat's permission mode, model and effort — desktop's chat header pills
 * (`task-terminals/src/client/chat/useChatMode.ts`, `useChatModel.ts`, `useChatEffort.ts`)
 * in one hook:
 *
 *   - Read: the live session (`chat.getInfo`, fresher) else the task's stored value
 *     (`chat.getMode` / `getModel` / `getEffort`).
 *   - Change: shown at once, then `chat.setMode` / `setModel` / `setEffort` (the hub
 *     applies it live or respawns the agent); the hub's answer wins (it may downgrade),
 *     a failure reverts and says why. One change at a time per setting: a pick while
 *     one runs becomes the next target (the latest pick wins).
 *   - The running agent's own permission mode (`turn-init`, `livePermissionMode`)
 *     overrides the mode when it CHANGES (not on every render), unless a change of
 *     ours is on its way.
 */
import {
  type ChatEffort,
  DEFAULT_CHAT_EFFORT,
  rawPermissionModeToChatMode
} from '@slayzone/terminal-contracts'
import { useQuery } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatTarget } from './useChatSession'
import { type HubTrpcClient, useTRPC, useTRPCClient } from '../trpc'

type Kind = 'mode' | 'model' | 'effort'

export interface ChatSettings {
  mode: string | null
  model: string | null
  effort: string
  /** The account may use Claude's `auto` mode (desktop hides it otherwise). */
  autoEligible: boolean
  autoOptedIn: boolean
  /** A change of this setting is on its way. */
  changing: Record<Kind, boolean>
  setMode: (next: string) => Promise<void>
  setModel: (next: string) => Promise<void>
  setEffort: (next: string) => Promise<void>
}

interface SessionInfoLite {
  chatMode?: string | null
  chatModel?: string | null
  chatEffort?: string | null
}

function apply(
  client: HubTrpcClient,
  target: ChatTarget,
  kind: Kind,
  value: string
): Promise<string | null> {
  const opts = { ...target }
  const pick = (info: SessionInfoLite | null | undefined) =>
    kind === 'mode' ? info?.chatMode : kind === 'model' ? info?.chatModel : info?.chatEffort
  switch (kind) {
    case 'mode':
      return client.chat.setMode.mutate({ ...opts, chatMode: value }).then((i) => pick(i) ?? value)
    case 'model':
      return client.chat.setModel
        .mutate({ ...opts, chatModel: value })
        .then((i) => pick(i) ?? value)
    case 'effort':
      return client.chat.setEffort
        .mutate({ ...opts, chatEffort: value })
        .then((i) => pick(i) ?? value)
  }
}

export function useChatSettings(
  target: ChatTarget,
  livePermissionMode: string | null,
  onError: (message: string) => void
): ChatSettings {
  const trpc = useTRPC()
  const client = useTRPCClient()
  const { tabId, taskId, mode: terminalMode } = target
  const info = useQuery(trpc.chat.getInfo.queryOptions({ tabId }))
  const live = (info.data ?? null) as SessionInfoLite | null
  const storedMode = useQuery(
    trpc.chat.getMode.queryOptions(
      { taskId, mode: terminalMode },
      { enabled: info.isSuccess && !live?.chatMode }
    )
  )
  const storedModel = useQuery(
    trpc.chat.getModel.queryOptions(
      { taskId, mode: terminalMode },
      { enabled: info.isSuccess && !live?.chatModel }
    )
  )
  const storedEffort = useQuery(
    trpc.chat.getEffort.queryOptions(
      { taskId, mode: terminalMode },
      { enabled: info.isSuccess && !live?.chatEffort }
    )
  )
  const auto = useQuery(trpc.chat.getAutoEligibility.queryOptions())

  const loaded: Record<Kind, string | null> = {
    mode: live?.chatMode ?? (storedMode.data as string | undefined) ?? null,
    model: live?.chatModel ?? (storedModel.data as string | undefined) ?? null,
    effort:
      live?.chatEffort ??
      (storedEffort.data as string | null | undefined) ??
      (storedEffort.isSuccess ? DEFAULT_CHAT_EFFORT : null)
  }

  // What the user (or the agent) set since the load; null = the loaded value.
  const [own, setOwn] = useState<Record<Kind, string | null>>({
    mode: null,
    model: null,
    effort: null
  })
  const [changing, setChanging] = useState<Record<Kind, boolean>>({
    mode: false,
    model: false,
    effort: false
  })
  const pendingRef = useRef<Record<Kind, string | null>>({ mode: null, model: null, effort: null })
  const runningRef = useRef<Record<Kind, Promise<void> | null>>({
    mode: null,
    model: null,
    effort: null
  })
  const value = (kind: Kind): string | null => own[kind] ?? loaded[kind]
  const valueRef = useRef(value)
  useEffect(() => {
    valueRef.current = value
  })

  const change = useCallback(
    (kind: Kind, next: string): Promise<void> => {
      setOwn((prev) => ({ ...prev, [kind]: next }))
      pendingRef.current[kind] = next
      const running = runningRef.current[kind]
      if (running) return running
      // What shows now (the last committed value): restored if the change fails.
      const previous = valueRef.current(kind)
      setChanging((prev) => ({ ...prev, [kind]: true }))
      const loop = async (): Promise<void> => {
        let failure: unknown = null
        while (pendingRef.current[kind] !== null) {
          const goal = pendingRef.current[kind] as string
          let resolved: string | null
          try {
            resolved = await apply(client, target, kind, goal)
          } catch (err) {
            failure = err
            break
          }
          // Superseded while on its way: apply the newer pick next.
          if (pendingRef.current[kind] !== goal) continue
          pendingRef.current[kind] = null
          setOwn((prev) => ({ ...prev, [kind]: resolved }))
        }
        pendingRef.current[kind] = null
        runningRef.current[kind] = null
        setChanging((prev) => ({ ...prev, [kind]: false }))
        if (failure !== null) {
          setOwn((prev) => ({ ...prev, [kind]: previous }))
          onError(
            `${kind === 'mode' ? 'Mode' : kind === 'model' ? 'Model' : 'Effort'} change failed: ${
              failure instanceof Error ? failure.message : String(failure)
            }`
          )
          throw failure
        }
      }
      const run = loop()
      runningRef.current[kind] = run
      return run
    },
    [client, target, onError]
  )

  // The agent's own mode, on a change only (a stale value must not undo a pick), and
  // not while a pick of ours is on its way (the dying process may report its old mode).
  // React's "adjust state when a value changes" pattern, during render.
  const [seenLive, setSeenLive] = useState<string | null | undefined>(undefined)
  if (livePermissionMode !== seenLive) {
    setSeenLive(livePermissionMode)
    const mapped = rawPermissionModeToChatMode(livePermissionMode)
    if (mapped && !changing.mode && own.mode !== mapped) setOwn({ ...own, mode: mapped })
  }

  return {
    mode: value('mode'),
    model: value('model'),
    effort: value('effort') ?? (DEFAULT_CHAT_EFFORT as ChatEffort),
    autoEligible: auto.data?.eligible ?? false,
    autoOptedIn: auto.data?.optedIn ?? false,
    changing,
    setMode: (next) => {
      if (next === value('mode')) return Promise.resolve()
      if (next === 'auto' && !(auto.data?.optedIn ?? false)) {
        onError('Auto mode requires Max/Team/Enterprise + opt-in via `claude` CLI')
        return Promise.resolve()
      }
      return change('mode', next)
    },
    setModel: (next) => (next === value('model') ? Promise.resolve() : change('model', next)),
    setEffort: (next) => (next === value('effort') ? Promise.resolve() : change('effort', next))
  }
}
