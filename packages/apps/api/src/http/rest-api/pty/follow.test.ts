/**
 * `slay pty buffer` / `follow --full`: the scrollback can live on the session's
 * computer, so reading it is a round trip. `follow --full` must still be gap-free and
 * duplicate-free across that wait: live chunks that land before the replay answers
 * are held, and only those AFTER the replay's seq are written.
 */
import { afterAll, describe, expect, test } from 'vitest'
import express from 'express'
import type { BufferSinceResult } from '@slayzone/terminal-contracts'
import { mountRestApp } from '../../../../../../shared/test-utils/rest-harness.js'
import type { RestApiDeps } from '../types'
import { registerPtyBufferRoute } from './buffer.js'
import { registerPtyFollowRoute } from './follow.js'

let live: ((chunk: string, seq: number) => void) | undefined
let answerReplay: (r: BufferSinceResult) => void = () => undefined
const pty = {
  hasPty: () => true,
  getBuffer: async () => 'scroll\x1b[0mback',
  getBufferSince: () =>
    new Promise<BufferSinceResult>((resolve) => {
      answerReplay = resolve
    }),
  subscribeToPtyData: (_id: string, cb: (chunk: string, seq: number) => void) => {
    live = cb
    return () => {
      live = undefined
    }
  },
  onSessionChange: () => () => undefined
}

const app = express()
registerPtyBufferRoute(app, { pty } as unknown as RestApiDeps)
registerPtyFollowRoute(app, { pty } as unknown as RestApiDeps)
const h = await mountRestApp(app)
afterAll(() => h.close())

describe('pty buffer + follow over an asynchronous scrollback', () => {
  test('buffer: answers with the (possibly remote) scrollback', async () => {
    const res = await fetch(`${h.url}/api/pty/s/buffer`)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('scroll\x1b[0mback')
  })

  test('follow --full: replay, then only live chunks after it, in order, none twice', async () => {
    const ctrl = new AbortController()
    const res = await fetch(`${h.url}/api/pty/s/follow?full=true`, { signal: ctrl.signal })
    const reader = res.body!.getReader()
    await new Promise((r) => setTimeout(r, 50))
    // Arrive while the replay is still being read: 4 is in the replay, 5 is not.
    live?.('four', 4)
    live?.('five', 5)
    answerReplay({
      chunks: [
        { seq: 3, data: 'three' },
        { seq: 4, data: 'four' }
      ],
      prelude: '',
      currentSeq: 4
    })
    await new Promise((r) => setTimeout(r, 50))
    live?.('six', 6)
    let text = ''
    const decoder = new TextDecoder()
    while (!text.includes('six')) {
      const { value } = await reader.read()
      text += decoder.decode(value)
    }
    ctrl.abort()
    const events = text
      .split('\n\n')
      .filter((e) => e.startsWith('data: '))
      .map((e) => JSON.parse(e.slice(6)) as string)
    expect(events).toEqual(['threefour', 'five', 'six'])
  })
})
