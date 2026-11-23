import { useEffect, useState } from 'react'
import {
  chatRowDetailIdentity,
  type ChatRowDetailRef,
  type ChatTextDetailRef,
  type ChatToolDetailChunk,
  type ChatToolDetailRef
} from '@slayzone/terminal-contracts'
import type { ToolInvocation } from '../shared/chat-timeline'

export type ChatToolDetailReader = (
  ref: ChatToolDetailRef,
  signal: AbortSignal
) => Promise<ToolInvocation>

export function toolDetailRef(invocation: ToolInvocation): ChatToolDetailRef | undefined {
  return invocation.toolDetail
}

export type ChatTextDetailReader = (ref: ChatTextDetailRef, signal: AbortSignal) => Promise<string>

type DetailIo = {
  toolDetail(input: {
    tabId: string
    detail: ChatRowDetailRef
    offset: number
    revision?: string
  }): Promise<unknown>
}

async function readCompleteDetail(
  io: DetailIo,
  tabId: string,
  detail: ChatRowDetailRef,
  signal: AbortSignal
): Promise<unknown> {
  const parts: string[] = []
  let offset = 0
  let revision: string | undefined
  for (;;) {
    if (signal.aborted) throw new Error('Chat tool detail read cancelled')
    const chunk = (await io.toolDetail({ tabId, detail, offset, revision })) as ChatToolDetailChunk
    if (signal.aborted) throw new Error('Chat tool detail read cancelled')
    if (
      !chunk ||
      !chunk.data.length ||
      (revision !== undefined && revision !== chunk.revision) ||
      (chunk.next !== null && chunk.next !== offset + chunk.data.length)
    ) {
      throw new Error('Tool result changed while it was loading')
    }
    parts.push(chunk.data)
    if (chunk.next === null) break
    revision = chunk.revision
    offset = chunk.next
  }
  return JSON.parse(parts.join(''))
}

export async function readCompleteToolDetail(
  io: DetailIo,
  tabId: string,
  detail: ChatToolDetailRef,
  signal: AbortSignal
): Promise<ToolInvocation> {
  const invocation = (await readCompleteDetail(io, tabId, detail, signal)) as ToolInvocation
  if (invocation.id !== detail.toolUseId) throw new Error('Tool result no longer matches this card')
  return invocation
}

export async function readCompleteTextDetail(
  io: DetailIo,
  tabId: string,
  detail: ChatTextDetailRef,
  signal: AbortSignal
): Promise<string> {
  const text = await readCompleteDetail(io, tabId, detail, signal)
  if (typeof text !== 'string') throw new Error('Text detail no longer matches this row')
  return text
}

/** Several cards may show the same result. Share the active transfer. */
export function shareToolDetailReads<Ref extends ChatRowDetailRef, Value>(
  read: (ref: Ref, signal: AbortSignal) => Promise<Value>
): (ref: Ref, signal: AbortSignal) => Promise<Value> {
  const pending = new Map<
    string,
    {
      controller: AbortController
      promise: Promise<Value>
      readers: number
    }
  >()
  const cancelled = () => new Error('Chat tool detail read cancelled')

  return (ref, signal) => {
    if (signal.aborted) return Promise.reject(cancelled())
    const key = JSON.stringify([ref.instance, ref.epoch, ref.row, chatRowDetailIdentity(ref)])
    let transfer = pending.get(key)
    if (!transfer) {
      const controller = new AbortController()
      transfer = { controller, readers: 0, promise: read(ref, controller.signal) }
      pending.set(key, transfer)
    }
    const shared = transfer
    shared.readers++
    return new Promise((resolve, reject) => {
      let active = true
      const release = () => {
        if (!active) return false
        active = false
        signal.removeEventListener('abort', abort)
        if (--shared.readers === 0) {
          pending.delete(key)
          shared.controller.abort()
        }
        return true
      }
      const abort = () => {
        if (release()) reject(cancelled())
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      void shared.promise.then(
        (value) => {
          if (release()) resolve(value)
        },
        (err: unknown) => {
          if (release()) reject(err)
        }
      )
    })
  }
}

/** Fetch only for an expanded card. The result lives with the row; no persistent cache. */
export function useToolDetail(
  invocation: ToolInvocation,
  read: ChatToolDetailReader | undefined,
  open: boolean
) {
  const detail = useRowDetail(invocation, toolDetailRef(invocation), read, open)
  return { ...detail, invocation: detail.value ?? invocation, loaded: detail.value != null }
}

export function useTextDetail(
  item: { text: string; textDetail?: ChatTextDetailRef },
  read: ChatTextDetailReader | undefined,
  visible: boolean
) {
  const detail = useRowDetail(item, item.textDetail, read, visible)
  return { ...detail, text: detail.value ?? item.text }
}

function useRowDetail<Ref extends ChatRowDetailRef, Value>(
  source: object,
  ref: Ref | undefined,
  read: ((ref: Ref, signal: AbortSignal) => Promise<Value>) | undefined,
  open: boolean
) {
  const [attempt, setAttempt] = useState(0)
  const [settled, setSettled] = useState<{
    source: object
    read: typeof read
    attempt: number
    value: Value | null
  } | null>(null)
  const current =
    settled?.source === source && settled.read === read && settled.attempt === attempt
      ? settled
      : null
  useEffect(() => {
    if (!open || !ref || !read || current) return
    const controller = new AbortController()
    const finish = (value: Value | null) => {
      if (!controller.signal.aborted) setSettled({ source, read, attempt, value })
    }
    void read(ref, controller.signal).then(finish, () => finish(null))
    return () => controller.abort()
  }, [open, ref, read, current, attempt, source])
  return {
    value: current?.value,
    loading: !!(open && ref && read && !current),
    failed: !!(open && ref && (!read || current?.value === null)),
    retry: () => setAttempt((n) => n + 1)
  }
}
