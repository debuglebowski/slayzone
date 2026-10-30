import { hubEntryOf } from '../hub-session'
import { fakeFetch } from './testing'
import { HubRestError, hubApiUrl, hubJson, hubTarget } from './hub-rest'

const remote = hubTarget({ entry: hubEntryOf('hub.example'), token: 'tok' })
const loopback = hubTarget({ entry: hubEntryOf('127.0.0.1:47921'), token: 'tok2' })

describe('hubTarget / hubApiUrl', () => {
  it('addresses a hub by its sign-in address: https off-box, http on loopback', () => {
    expect(remote).toEqual({
      hubId: hubEntryOf('hub.example').id,
      label: 'hub.example',
      address: 'hub.example',
      token: 'tok'
    })
    expect(hubApiUrl(remote, '/api/artifacts/search', { q: 'a b', allTasks: true })).toBe(
      'https://hub.example/api/artifacts/search?q=a%20b&allTasks=1'
    )
    expect(hubApiUrl(loopback, '/api/x')).toBe('http://127.0.0.1:47921/api/x')
  })

  it('leaves out query values that are absent or false', () => {
    expect(hubApiUrl(remote, '/api/x', { a: undefined, b: null, c: false, d: 'v' })).toBe(
      'https://hub.example/api/x?d=v'
    )
  })
})

describe('hubJson', () => {
  it("sends the hub's bearer and returns the envelope's data", async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: { ok: true, data: { n: 1 } } }))
    await expect(hubJson(remote, '/api/x', { fetch })).resolves.toEqual({ n: 1 })
    expect(fetch.calls[0]).toMatchObject({
      url: 'https://hub.example/api/x',
      init: { method: 'GET', headers: { authorization: 'Bearer tok' }, credentials: 'omit' }
    })
  })

  it("fails with the hub's own message and code", async () => {
    const fetch = fakeFetch(() => ({
      status: 400,
      body: { ok: false, code: 'INVALID_REGEX', error: 'Invalid regex: (' }
    }))
    const err = await hubJson(remote, '/api/x', { fetch }).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HubRestError)
    expect(err).toMatchObject({ status: 400, code: 'INVALID_REGEX', message: 'Invalid regex: (' })
  })

  it('says a refused bearer means signing in again', async () => {
    const fetch = fakeFetch(() => ({ status: 401, body: { error: 'Unauthorized' } }))
    await expect(hubJson(remote, '/api/x', { fetch })).rejects.toMatchObject({
      status: 401,
      message: 'Your sign-in to hub.example has expired. Sign in again.'
    })
  })

  it('says the hub cannot be reached when the request itself fails', async () => {
    const fetch = fakeFetch(() => {
      throw new TypeError('Network request failed')
    })
    await expect(hubJson(remote, '/api/x', { fetch })).rejects.toMatchObject({
      status: null,
      message: "Can't reach hub.example (Network request failed)"
    })
  })

  it('names the status when the body is not the envelope', async () => {
    const fetch = fakeFetch(() => ({ status: 502, body: '<html>bad gateway</html>' }))
    await expect(hubJson(remote, '/api/x', { fetch })).rejects.toMatchObject({
      status: 502,
      message: 'hub.example answered HTTP 502'
    })
  })
})
