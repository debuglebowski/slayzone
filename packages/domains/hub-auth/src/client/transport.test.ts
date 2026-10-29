/** Transport helpers and the fetch transport (React Native / browser). */
import { describe, expect, it } from 'vitest'
import {
  createFetchHubTransport,
  type HubFetch,
  HubTransportTimeoutError,
  isHubTransportTimeout,
  transportErrorText
} from './transport'

describe('timeout errors', () => {
  it('carry a stable code and the "timed out after" wording', () => {
    const err = new HubTransportTimeoutError(1500)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toBe('timed out after 1500ms')
    expect(err.timeoutMs).toBe(1500)
    expect(isHubTransportTimeout(err)).toBe(true)
    // By code, so a copy from another bundle still counts.
    expect(isHubTransportTimeout({ code: 'HUB_TRANSPORT_TIMEOUT' })).toBe(true)
    expect(isHubTransportTimeout(new Error('timed out after 1500ms'))).toBe(false)
    expect(isHubTransportTimeout(null)).toBe(false)
  })

  it('transportErrorText: the message of an Error, else the value', () => {
    expect(transportErrorText(new Error('boom'))).toBe('boom')
    expect(transportErrorText('plain')).toBe('plain')
  })
})

describe('createFetchHubTransport', () => {
  const request = {
    method: 'POST' as const,
    url: 'https://hub.example.com/api/auth/sign-in/email',
    headers: { 'content-type': 'application/json' },
    body: '{"email":"a"}',
    timeoutMs: 1000,
    maxResponseChars: 5
  }

  it('sends without cookies and answers status, headers and the capped body', async () => {
    const calls: Array<[string, Parameters<HubFetch>[1]]> = []
    const fetchImpl: HubFetch = async (url, init) => {
      calls.push([url, init])
      return {
        status: 201,
        headers: { get: (name) => (name === 'set-auth-token' ? 'tok' : null) },
        text: async () => '0123456789'
      }
    }
    const res = await createFetchHubTransport(fetchImpl)(request)
    expect(res.status).toBe(201)
    expect(res.header('set-auth-token')).toBe('tok')
    expect(res.text).toBe('01234')
    const [url, init] = calls[0]!
    expect(url).toBe(request.url)
    expect(init).toMatchObject({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"a"}',
      credentials: 'omit'
    })
  })

  it('a fetch that outlives timeoutMs rejects with the timeout error', async () => {
    const fetchImpl: HubFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('The operation was aborted')))
      })
    const err = await createFetchHubTransport(fetchImpl)({ ...request, timeoutMs: 20 }).catch(
      (e: unknown) => e
    )
    expect(isHubTransportTimeout(err)).toBe(true)
    expect((err as Error).message).toBe('timed out after 20ms')
  })

  it('a network failure rejects as is', async () => {
    const failure = new TypeError('Network request failed')
    const fetchImpl: HubFetch = async () => {
      throw failure
    }
    await expect(createFetchHubTransport(fetchImpl)(request)).rejects.toBe(failure)
  })
})
