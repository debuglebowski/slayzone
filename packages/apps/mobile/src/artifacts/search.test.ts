import type { ArtifactSearchReport } from '@slayzone/task-artifacts/shared'
import { hubEntryOf } from '../hub-session'
import { hubTarget } from './hub-rest'
import { artifactSearchQuery, searchArtifacts } from './search'
import { fakeFetch } from './testing'

const home = hubTarget({ entry: hubEntryOf('home.example'), token: 'h' })
const work = hubTarget({ entry: hubEntryOf('work.example'), token: 'w' })

const report = (...titles: string[]): ArtifactSearchReport => ({
  results: titles.map((title, i) => ({
    artifactId: `a${i}`,
    taskId: 't1',
    title,
    matches: [{ type: 'title', snippet: title }]
  })),
  scannedCount: 10,
  truncated: false,
  skippedLarge: []
})

describe('artifactSearchQuery', () => {
  it('searches every task unless one is named; a flag is sent only when on', () => {
    expect(artifactSearchQuery({ q: 'plan' })).toEqual({ q: 'plan', allTasks: true })
    expect(
      artifactSearchQuery({ q: 'plan', taskId: 't1', regex: true, caseSensitive: false, limit: 20 })
    ).toEqual({ q: 'plan', taskId: 't1', regex: true, limit: '20' })
  })
})

describe('searchArtifacts', () => {
  it('asks every hub with its own bearer and merges the results, each tagged with its hub, hubs in the order given', async () => {
    const fetch = fakeFetch(({ url }) => ({
      status: 200,
      body: {
        ok: true,
        data: url.includes('home.') ? report('Home plan') : report('Work plan', 'Work notes')
      }
    }))
    const outcome = await searchArtifacts([home, work], { q: 'plan' }, { fetch })

    expect(fetch.calls.map((c) => [c.url, c.init.headers.authorization])).toEqual([
      ['https://home.example/api/artifacts/search?q=plan&allTasks=1', 'Bearer h'],
      ['https://work.example/api/artifacts/search?q=plan&allTasks=1', 'Bearer w']
    ])
    expect(outcome.results.map((r) => [r.hubLabel, r.title])).toEqual([
      ['home.example', 'Home plan'],
      ['work.example', 'Work plan'],
      ['work.example', 'Work notes']
    ])
    expect(new Set(outcome.results.map((r) => r.key)).size).toBe(3)
    expect(outcome.hubs).toEqual([
      {
        hubId: home.hubId,
        hubLabel: 'home.example',
        ok: true,
        scannedCount: 10,
        truncated: false,
        skippedLarge: []
      },
      {
        hubId: work.hubId,
        hubLabel: 'work.example',
        ok: true,
        scannedCount: 10,
        truncated: false,
        skippedLarge: []
      }
    ])
  })

  it('keeps the other hubs’ results when one hub fails, and says why it failed', async () => {
    const fetch = fakeFetch(({ url }) =>
      url.includes('home.')
        ? { status: 400, body: { ok: false, code: 'INVALID_REGEX', error: 'Invalid regex: (' } }
        : { status: 200, body: { ok: true, data: report('Work plan') } }
    )
    const outcome = await searchArtifacts([home, work], { q: '(', regex: true }, { fetch })
    expect(outcome.results.map((r) => r.title)).toEqual(['Work plan'])
    expect(outcome.hubs[0]).toEqual({
      hubId: home.hubId,
      hubLabel: 'home.example',
      ok: false,
      code: 'INVALID_REGEX',
      error: 'Invalid regex: ('
    })
  })

  it('rejects an empty query without asking any hub', async () => {
    const fetch = fakeFetch(() => ({ status: 200, body: { ok: true, data: report() } }))
    await expect(searchArtifacts([home], { q: '  ' }, { fetch })).rejects.toThrow(
      'Type something to search for'
    )
    expect(fetch.calls).toHaveLength(0)
  })
})
