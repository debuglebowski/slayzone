import { useMemo } from 'react'
import type { ChatActions, NavigateActions } from './autocomplete/types'

export interface UseChatActionsResult {
  chatApi: ChatActions
  navigate: NavigateActions
}

/**
 * Builds the two stable `window.api` facades the chat panel + autocomplete need:
 *
 *   - `chatApi` (ChatActions): kill / remove / reset / hydrate / start / send /
 *     interrupt. Each method null-guards the optional `window.api.chat` bridge so
 *     the panel never throws when the preload surface is missing (tests / boot).
 *   - `navigate` (NavigateActions): openSettings / openExternal / openFile — thin
 *     wrappers over `CustomEvent('open-settings')` + `window.api.shell`.
 *
 * Both are memoized with empty deps (the underlying `window.api` is a stable
 * singleton), so the returned object identities stay fixed across renders and
 * don't churn the autocomplete accept-context.
 */
export function useChatActions(): UseChatActionsResult {
  const chatApi = useMemo<ChatActions>(() => {
    const api = (
      window as unknown as {
        api?: {
          chat?: {
            kill: (tabId: string) => Promise<void>
            remove: (tabId: string) => Promise<void>
            reset: (opts: {
              tabId: string
              taskId: string
              mode: string
              cwd: string
              providerFlagsOverride?: string | null
            }) => Promise<unknown>
            hydrate: (opts: {
              tabId: string
              taskId: string
              mode: string
              cwd: string
              providerFlagsOverride?: string | null
            }) => Promise<unknown>
            start: (opts: {
              tabId: string
              taskId: string
              mode: string
              cwd: string
              providerFlagsOverride?: string | null
            }) => Promise<unknown>
            send: (tabId: string, text: string) => Promise<boolean>
            interrupt: (opts: {
              tabId: string
              taskId: string
              mode: string
              cwd: string
              providerFlagsOverride?: string | null
            }) => Promise<unknown>
          }
        }
      }
    ).api
    const chat = api?.chat
    return {
      kill: (id) => chat?.kill(id) ?? Promise.resolve(),
      remove: (id) => chat?.remove(id) ?? Promise.resolve(),
      reset: (opts) => chat?.reset(opts) ?? Promise.resolve(null),
      hydrate: (opts) => chat?.hydrate(opts) ?? Promise.resolve(null),
      start: (opts) => chat?.start(opts) ?? Promise.resolve(null),
      send: (id, text) => chat?.send(id, text) ?? Promise.resolve(false),
      interrupt: (o) => chat?.interrupt(o) ?? Promise.resolve(null)
    }
  }, [])

  const navigate = useMemo<NavigateActions>(
    () => ({
      openSettings(tab) {
        window.dispatchEvent(new CustomEvent('open-settings', { detail: tab ?? 'appearance' }))
      },
      openExternal(url) {
        const api = (
          window as unknown as {
            api?: { shell?: { openExternal: (url: string) => Promise<unknown> } }
          }
        ).api
        void api?.shell?.openExternal(url)
      },
      openFile(absPath) {
        const api = (
          window as unknown as {
            api?: { shell?: { openPath: (p: string) => Promise<string> } }
          }
        ).api
        void api?.shell?.openPath(absPath)
      }
    }),
    []
  )

  return { chatApi, navigate }
}
