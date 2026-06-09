import { useMemo } from 'react'
import { useTRPCClient } from '@slayzone/transport/client'
import type { ChatActions, NavigateActions } from './autocomplete/types'

export interface UseChatActionsResult {
  chatApi: ChatActions
  navigate: NavigateActions
}

/**
 * Builds the two stable tRPC-backed facades the chat panel + autocomplete need:
 *
 *   - `chatApi` (ChatActions): kill / remove / reset / hydrate / start / send /
 *     interrupt — thin wrappers over the `chat.*` tRPC procedures.
 *   - `navigate` (NavigateActions): openSettings / openExternal / openFile — thin
 *     wrappers over `CustomEvent('open-settings')` + the `app.shell.*` mutations.
 *
 * Both are memoized on the (stable) tRPC client so the returned object
 * identities stay fixed across renders and don't churn the autocomplete
 * accept-context.
 */
export function useChatActions(): UseChatActionsResult {
  const trpcClient = useTRPCClient()

  const chatApi = useMemo<ChatActions>(
    () => ({
      kill: (tabId) => trpcClient.chat.kill.mutate({ tabId }).then(() => undefined),
      remove: (tabId) => trpcClient.chat.remove.mutate({ tabId }).then(() => undefined),
      reset: (opts) => trpcClient.chat.reset.mutate(opts),
      hydrate: (opts) => trpcClient.chat.hydrate.mutate(opts),
      start: (opts) => trpcClient.chat.start.mutate(opts),
      send: (tabId, text) => trpcClient.chat.send.mutate({ tabId, text }),
      interrupt: (opts) => trpcClient.chat.interrupt.mutate(opts)
    }),
    [trpcClient]
  )

  const navigate = useMemo<NavigateActions>(
    () => ({
      openSettings(tab) {
        window.dispatchEvent(new CustomEvent('open-settings', { detail: tab ?? 'appearance' }))
      },
      openExternal(url) {
        void trpcClient.app.shell.openExternal.mutate({ url })
      },
      openFile(absPath) {
        void trpcClient.app.shell.openPath.mutate({ absPath })
      }
    }),
    [trpcClient]
  )

  return { chatApi, navigate }
}
