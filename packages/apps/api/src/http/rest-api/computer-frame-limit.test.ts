/**
 * REST shape of a frame over the computer link limit (a reply or request the
 * computer protocol refused to send, `frameTooLarge`): 413 `{ ok: false, error,
 * code: 'COMPUTER_FRAME_TOO_LARGE' }` with the message naming method and sizes —
 * the twin of tRPC's PAYLOAD_TOO_LARGE + `data.appCode`. Never an opaque 500.
 */
import { describe, expect, test } from 'vitest'
import type { Response } from 'express'
import { COMPUTER_FRAME_TOO_LARGE_RPC_CODE } from '@slayzone/platform/computer-frame-limit'
import { respondFrameTooLarge } from './computer-frame-limit'
import { sendChatError } from './chat/_chat'

const MESSAGE =
  "reply to 'chat.request' is 211812345 bytes (202.0 MiB); the frame limit is 104857600 bytes (100.0 MiB)"

/** An `RpcError` as computer-transport builds it (structural). */
function rpcError(code: number, message: string): Error {
  return Object.assign(new Error(message), { name: 'RpcError', code })
}

function fakeRes(): Response & { sent: { status?: number; body?: unknown } } {
  const sent: { status?: number; body?: unknown } = {}
  const res = {
    sent,
    headersSent: false,
    status(code: number) {
      sent.status = code
      return res
    },
    json(body: unknown) {
      sent.body = body
      return res
    }
  }
  return res as unknown as Response & { sent: typeof sent }
}

describe('a computer frame over the limit, over REST', () => {
  test('is 413 COMPUTER_FRAME_TOO_LARGE with the message', () => {
    const res = fakeRes()
    expect(respondFrameTooLarge(res, rpcError(COMPUTER_FRAME_TOO_LARGE_RPC_CODE, MESSAGE))).toBe(
      true
    )
    expect(res.sent).toEqual({
      status: 413,
      body: { ok: false, error: MESSAGE, code: 'COMPUTER_FRAME_TOO_LARGE' }
    })
  })

  test('anything else is left to the route', () => {
    const res = fakeRes()
    expect(respondFrameTooLarge(res, rpcError(-32603, 'internal'))).toBe(false)
    expect(res.sent).toEqual({})
  })

  test('chat and agent routes answer it as 413, not 500', () => {
    const res = fakeRes()
    sendChatError(res, rpcError(COMPUTER_FRAME_TOO_LARGE_RPC_CODE, MESSAGE))
    expect(res.sent.status).toBe(413)
    expect(res.sent.body).toMatchObject({ code: 'COMPUTER_FRAME_TOO_LARGE' })
  })
})
