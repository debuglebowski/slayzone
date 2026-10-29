/**
 * Test double for {@link HubTransport}: answers each request from a function, records
 * every request. Test-only (imported by `*.test.ts`), kept platform-neutral like the rest
 * of this directory.
 */
import type { HubHttpRequest, HubTransport } from './transport'

/** One fake answer: an HTTP reply, or an Error the transport rejects with. */
export type FakeAnswer =
  | {
      status: number
      /** Sent as is when a string, else as JSON. Omitted = empty body. */
      body?: unknown
      headers?: Record<string, string>
    }
  | Error

export function fakeHubTransport(answer: (request: HubHttpRequest) => FakeAnswer): {
  transport: HubTransport
  requests: HubHttpRequest[]
} {
  const requests: HubHttpRequest[] = []
  const transport: HubTransport = async (request) => {
    requests.push(request)
    const a = answer(request)
    if (a instanceof Error) throw a
    const text =
      typeof a.body === 'string' ? a.body : a.body === undefined ? '' : JSON.stringify(a.body)
    const headers = new Map(
      Object.entries(a.headers ?? {}).map(([name, value]) => [name.toLowerCase(), value])
    )
    return {
      status: a.status,
      header: (name) => headers.get(name.toLowerCase()) ?? null,
      text: text.slice(0, request.maxResponseChars)
    }
  }
  return { transport, requests }
}

/** Answers in order; a request past the last answer fails the test loudly. */
export function inOrder(...answers: FakeAnswer[]): (request: HubHttpRequest) => FakeAnswer {
  return (request) => {
    const next = answers.shift()
    if (!next) throw new Error(`fake hub: unexpected request ${request.method} ${request.url}`)
    return next
  }
}
