/**
 * The composer's behaviour — desktop's `useChatComposer` (task-terminals): the draft,
 * the `/` menu, and the send / stop pipeline.
 *
 *   - Send: `/effort` and `/model` go to the settings (`planSend`); a provider that does
 *     not run slash commands gets command files expanded here; behind a running turn or
 *     a non-empty queue the message waits in the hub's queue (`chat.queue.push`, FIFO,
 *     sent by the hub), otherwise it goes now (`chat.send` — the hub starts the agent if
 *     it is not running). A use of a `/command` is counted for the menu's ranking.
 *   - Stop: the queue is cleared and the turn aborted (`chat.abortAndPop`); when nothing
 *     came back yet the message is withdrawn and put back in the draft — its files too
 *     (attached on desktop; the phone has no file picker yet), sent again with the next
 *     message unless removed.
 *   - The `/` menu: a tap accepts an entry (runs a builtin, or puts it in the draft);
 *     Send while the menu is open does what Enter does on desktop (`enterSlash`).
 */
import type {
  AcceptCtx,
  ChatActions,
  NavigateActions
} from '@slayzone/task-terminals/slash-commands'
import {
  type ChatAttachment,
  type ChatCapabilities,
  userMessageAttachments
} from '@slayzone/terminal-contracts'
import { useCallback, useRef, useState } from 'react'
import { messageContent } from './attachments'
import { openWebLink } from './Markdown'
import {
  acceptSlash,
  enterSlash,
  planSend,
  rankSlash,
  type SlashAction,
  type SlashItem,
  slashQuery,
  usageTarget
} from './slash-menu'
import { useTRPCClient } from '../trpc'
import type { ChatQueue } from './useChatQueue'
import type { ChatSessionApi, ChatTarget } from './useChatSession'
import type { ChatSettings } from './useChatSettings'
import type { SlashCommands } from './useSlashCommands'

const MENU_SIZE = 40

export interface ChatComposer {
  draft: string
  setDraft: (text: string) => void
  /** Files the next message carries (given back by Stop). */
  attachments: readonly ChatAttachment[]
  removeAttachment: (index: number) => void
  /** The `/` menu's entries, best first; null = no menu. */
  menu: SlashItem[] | null
  pick: (item: SlashItem) => void
  send: () => void
  stop: () => void
  /** Text or files a send would carry. */
  canSend: boolean
}

export function useChatComposer({
  target,
  caps,
  session,
  queue,
  settings,
  slash,
  notify,
  sessionEnded
}: {
  target: ChatTarget
  caps: ChatCapabilities
  session: ChatSessionApi
  queue: ChatQueue
  settings: ChatSettings
  slash: SlashCommands
  notify: (message: string) => void
  /** The agent's process ended: sending waits for a restart (desktop's rule). */
  sessionEnded: boolean
}): ChatComposer {
  const client = useTRPCClient()
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<readonly ChatAttachment[]>([])
  /** The entry picked from the menu for this draft (its use is counted on send). */
  const pickedRef = useRef<{ source: string; name: string } | null>(null)
  /** What was sent for the running turn (put back when Stop withdraws it). */
  const lastSentRef = useRef<{ text: string; attachments: readonly ChatAttachment[] } | null>(null)

  const query = slashQuery(draft)
  const menu =
    query === null ? null : rankSlash(slash.items, query, slash.usage).slice(0, MENU_SIZE)

  const { inFlight, sendMessage, resetLocal, abortAndPop } = session
  const queued = queue.items.length

  // Send a prompt the way the composer does: behind a turn it waits in the queue.
  const submitPrompt = useCallback(
    async (
      toSend: string,
      original: string,
      files: readonly ChatAttachment[] = []
    ): Promise<void> => {
      if (inFlight || queued > 0) {
        await queue.push(toSend, original, messageContent(toSend, files))
        return
      }
      lastSentRef.current = { text: original, attachments: files }
      // A failure stays on screen (the bubble, with Retry); nothing more to do here.
      await sendMessage(toSend, files).catch(() => undefined)
    },
    [inFlight, queued, queue, sendMessage]
  )

  const sendText = useCallback(
    async (raw: string): Promise<void> => {
      if (sessionEnded) return
      const files = attachments
      const plan = planSend(raw, target.mode, caps, slash.commands)
      switch (plan.type) {
        case 'empty':
          // Files alone are a message too.
          if (files.length === 0) return
          setDraft('')
          setAttachments([])
          await submitPrompt('', '', files).catch((err: unknown) =>
            notify(
              `Could not queue the message: ${err instanceof Error ? err.message : String(err)}`
            )
          )
          return
        case 'invalid':
          notify(plan.message)
          return
        case 'effort':
          setDraft('')
          await settings.setEffort(plan.level).then(
            () => notify(`Effort set to ${plan.level}`),
            () => undefined
          )
          return
        case 'model':
          setDraft('')
          await settings.setModel(plan.id).then(
            () => notify(`Model set to ${plan.id}`),
            () => undefined
          )
          return
        case 'send': {
          const original = raw.trim()
          setDraft('')
          setAttachments([])
          const used = usageTarget(original, slash.items, pickedRef.current)
          pickedRef.current = null
          await submitPrompt(plan.text, original, files).catch((err: unknown) =>
            notify(
              `Could not queue the message: ${err instanceof Error ? err.message : String(err)}`
            )
          )
          if (used) slash.bump(used)
        }
      }
    },
    [sessionEnded, attachments, target.mode, caps, slash, notify, settings, submitPrompt]
  )

  const chatActions: ChatActions = {
    kill: (tabId) => client.chat.kill.mutate({ tabId }).then(() => undefined),
    remove: (tabId) => client.chat.remove.mutate({ tabId }).then(() => undefined),
    reset: (opts) => {
      // Cleared here at once (desktop's reset does the same); the hub's new log follows.
      resetLocal()
      void queue.clear().catch(() => undefined)
      return client.chat.reset.mutate({
        ...opts,
        providerFlagsOverride: opts.providerFlagsOverride ?? null
      })
    },
    hydrate: (opts) => client.chat.hydrate.mutate(opts),
    start: (opts) => client.chat.start.mutate(opts),
    send: (tabId, text) => client.chat.send.mutate({ tabId, text }),
    interrupt: (opts) => client.chat.interrupt.mutate(opts)
  }
  const navigate: NavigateActions = {
    openExternal: openWebLink,
    openSettings: () => notify('Settings are in SlayZone on your computer.'),
    openFile: (path) => notify(`Open ${path} in SlayZone on your computer.`)
  }

  const run = (action: SlashAction, item: SlashItem | null): void => {
    switch (action.type) {
      case 'run': {
        setDraft(action.draft)
        const ctx: AcceptCtx = {
          draft,
          setDraft,
          tokenStart: 0,
          tokenEnd: draft.length,
          session: target,
          chat: chatActions,
          navigate,
          toast: notify,
          submit: (text) => submitPrompt(text, text)
        }
        void Promise.resolve(action.builtin.run(ctx)).catch((err: unknown) =>
          notify(
            `/${action.builtin.name} failed: ${err instanceof Error ? err.message : String(err)}`
          )
        )
        return
      }
      case 'draft':
        setDraft(action.draft)
        if (item) pickedRef.current = { source: item.source, name: item.name }
        if (action.hint) notify(action.hint)
        return
      case 'send':
        if (item) pickedRef.current = { source: item.source, name: item.name }
        void sendText(action.text)
    }
  }

  const send = (): void => {
    if (menu && menu.length > 0) {
      const action = enterSlash(draft, menu, caps)
      if (action.type !== 'passthrough') {
        const item = action.type === 'run' ? null : menu[0]
        run(action, item)
        return
      }
    }
    void sendText(draft)
  }

  const stop = (): void => {
    void queue.clear().catch(() => undefined)
    void abortAndPop().then(
      (result) => {
        if (!result.popped || draft.trim() !== '') return
        // What this phone sent, else the popped message itself (sent elsewhere, or
        // before a remount): its text and its files.
        const sent = lastSentRef.current
        lastSentRef.current = null
        const text = sent ? sent.text : result.text
        const files = sent ? sent.attachments : userMessageAttachments(result.content ?? [])
        if (text) setDraft(text)
        if (files.length > 0) setAttachments(files)
      },
      (err: unknown) =>
        notify(`Could not stop: ${err instanceof Error ? err.message : String(err)}`)
    )
  }

  return {
    draft,
    setDraft,
    attachments,
    removeAttachment: (index) => setAttachments((prev) => prev.filter((_, i) => i !== index)),
    menu: menu && menu.length > 0 ? menu : null,
    pick: (item) => run(acceptSlash(item, draft, caps), item),
    send,
    stop,
    canSend: (draft.trim().length > 0 || attachments.length > 0) && !sessionEnded
  }
}
