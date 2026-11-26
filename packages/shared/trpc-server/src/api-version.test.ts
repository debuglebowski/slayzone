import { describe, expect, it } from 'vitest'
import { apiIncompatibility, hubApiInfoOf, parseClientApi, withClientApi } from './api-version'

describe('withClientApi', () => {
  it('adds the version as a query parameter, keeping the rest', () => {
    expect(withClientApi('ws://h/trpc', 3)).toBe('ws://h/trpc?clientApi=3')
    expect(withClientApi('ws://h/trpc?windowId=1', 3)).toBe('ws://h/trpc?windowId=1&clientApi=3')
    expect(withClientApi('ws://h/trpc#x', 3)).toBe('ws://h/trpc?clientApi=3#x')
  })
  it('leaves a url that already names one alone', () => {
    expect(withClientApi('ws://h/trpc?clientApi=1', 3)).toBe('ws://h/trpc?clientApi=1')
  })
})

describe('parseClientApi', () => {
  it('reads the query; none or malformed = 0', () => {
    expect(parseClientApi('/trpc?clientApi=4')).toBe(4)
    expect(parseClientApi('/trpc?windowId=1&clientApi=5')).toBe(5)
    expect(parseClientApi('/trpc')).toBe(0)
    expect(parseClientApi('/trpc?clientApi=abc')).toBe(0)
    expect(parseClientApi('/trpc?clientApi=-1')).toBe(0)
    expect(parseClientApi(undefined)).toBe(0)
  })
})

describe('hubApiInfoOf', () => {
  it('reads a hub older than the contract as API 0, no features', () => {
    expect(hubApiInfoOf({ version: '0.43.0', wire: {} })).toEqual({
      version: 0,
      minClient: 0,
      release: '0.43.0',
      features: []
    })
    expect(hubApiInfoOf(null).version).toBe(0)
  })
  it('reads the api block and features', () => {
    expect(
      hubApiInfoOf({ version: '0.44.0', api: { version: 2, minClient: 1 }, features: ['a', 3] })
    ).toEqual({ version: 2, minClient: 1, release: '0.44.0', features: ['a'] })
  })
})

describe('apiIncompatibility', () => {
  const hub = (version: number, minClient = 0) => ({
    version,
    minClient,
    release: 'r',
    features: []
  })
  it('is null inside both minimums', () => {
    expect(apiIncompatibility(hub(2, 1), { clientApi: 2, minHubApi: 2 })).toBeNull()
  })
  it('names the hub when it is below the client minimum', () => {
    expect(apiIncompatibility(hub(1), { clientApi: 3, minHubApi: 2 })).toMatchObject({
      side: 'hub',
      hubApi: 1,
      minHubApi: 2
    })
  })
  it('names the app when the hub no longer serves it (checked first)', () => {
    expect(apiIncompatibility(hub(1, 4), { clientApi: 3, minHubApi: 2 })).toMatchObject({
      side: 'app',
      clientApi: 3,
      minClientApi: 4
    })
  })
})
