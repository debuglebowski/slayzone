/**
 * expo-client: the Expo Push Service's HTTP API (send + receipts), batched at 100,
 * against a fake `fetch`.
 */
import { expect, test } from 'vitest'
import { createExpoPushClient } from './expo-client.js'

type Call = { url: string; body: unknown }

function fakeFetch(respond: (body: unknown) => unknown, calls: Call[], status = 200) {
  return (async (url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body))
    calls.push({ url, body })
    return new Response(JSON.stringify(respond(body)), { status })
  }) as typeof fetch
}

test('sends to https on a public host, http on loopback, in batches of 100', async () => {
  const calls: Call[] = []
  const client = createExpoPushClient({
    address: 'exp.host',
    fetch: fakeFetch(
      (b) => ({ data: (b as unknown[]).map((_, i) => ({ status: 'ok', id: `t${i}` })) }),
      calls
    )
  })
  const msgs = Array.from({ length: 150 }, (_, i) => ({
    to: `ExponentPushToken[${i}]`,
    title: 'x'
  }))
  const tickets = await client.send(msgs)
  expect(calls.map((c) => c.url)).toEqual([
    'https://exp.host/--/api/v2/push/send',
    'https://exp.host/--/api/v2/push/send'
  ])
  expect(calls.map((c) => (c.body as unknown[]).length)).toEqual([100, 50])
  expect(tickets).toHaveLength(150)

  const local: Call[] = []
  await createExpoPushClient({
    address: '127.0.0.1:4100',
    fetch: fakeFetch(() => ({ data: [{ status: 'ok', id: 'a' }] }), local)
  }).send([{ to: 'ExponentPushToken[a]' }])
  expect(local[0].url).toBe('http://127.0.0.1:4100/--/api/v2/push/send')
})

test('reads receipts by id', async () => {
  const calls: Call[] = []
  const client = createExpoPushClient({
    address: 'exp.host',
    fetch: fakeFetch(() => ({ data: { a: { status: 'ok' } } }), calls)
  })
  expect(await client.receipts(['a', 'b'])).toEqual({ a: { status: 'ok' } })
  expect(calls[0]).toEqual({
    url: 'https://exp.host/--/api/v2/push/getReceipts',
    body: { ids: ['a', 'b'] }
  })
})

test('an HTTP failure or a request-level error throws', async () => {
  await expect(
    createExpoPushClient({ address: 'exp.host', fetch: fakeFetch(() => ({}), [], 503) }).send([
      { to: 'ExponentPushToken[a]' }
    ])
  ).rejects.toThrow(/503/)
  await expect(
    createExpoPushClient({
      address: 'exp.host',
      fetch: fakeFetch(() => ({ errors: [{ code: 'PUSH_TOO_MANY', message: 'slow down' }] }), [])
    }).send([{ to: 'ExponentPushToken[a]' }])
  ).rejects.toThrow(/slow down/)
})
