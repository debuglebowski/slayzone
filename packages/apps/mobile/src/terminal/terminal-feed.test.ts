import { type AttachResult, type FeedClient, type FeedSink, TerminalFeed } from './terminal-feed'

/** What the terminal was told to do, in order. */
function recordingSink() {
  const ops: string[] = []
  const sink: FeedSink = {
    reset: () => ops.push('reset'),
    write: (data) => ops.push(`write ${data}`),
    resize: (cols, rows) => ops.push(`resize ${cols}x${rows}`)
  }
  return { sink, ops }
}

/** A promise the test resolves when it wants. */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

const buffer = (chunks: Array<[number, string]>, prelude = '') => ({
  chunks: chunks.map(([seq, data]) => ({ seq, data })),
  currentSeq: chunks.length ? chunks[chunks.length - 1][0] : -1,
  prelude
})

const live = (chunks: Array<[number, string]>, prelude = ''): AttachResult => ({
  exists: true,
  state: 'running',
  buffer: buffer(chunks, prelude),
  size: { cols: 120, rows: 40 }
})

function client(overrides: Partial<FeedClient> = {}): FeedClient & { attaches: number[] } {
  const attaches: number[] = []
  return {
    attaches,
    attach: async (_sid, afterSeq) => {
      attaches.push(afterSeq)
      return live([])
    },
    bufferSince: async () => buffer([]),
    ...overrides
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('TerminalFeed', () => {
  it("attaches at the session's size: prelude, then the buffer, then live data", async () => {
    const { sink, ops } = recordingSink()
    const c = client({
      attach: async () =>
        live(
          [
            [0, 'a'],
            [1, 'b']
          ],
          'P'
        )
    })
    const feed = new TerminalFeed('t:t', c, sink)
    await feed.start()
    feed.data(2, 'c')
    expect(ops).toEqual(['reset', 'resize 120x40', 'write P', 'write a', 'write b', 'write c'])
  })

  it('queues data that arrives during the attach and drops what the buffer already had', async () => {
    const { sink, ops } = recordingSink()
    const answer = deferred<AttachResult>()
    const feed = new TerminalFeed('t:t', client({ attach: () => answer.promise }), sink)
    const started = feed.start()
    // Subscribed first: these arrive while the attach is in flight.
    feed.data(1, 'b')
    feed.data(2, 'c')
    answer.resolve(
      live([
        [0, 'a'],
        [1, 'b']
      ])
    )
    await started
    expect(ops.filter((op) => op.startsWith('write'))).toEqual(['write a', 'write b', 'write c'])
  })

  it('drops a chunk it already wrote', async () => {
    const { sink, ops } = recordingSink()
    const feed = new TerminalFeed('t:t', client({ attach: async () => live([[0, 'a']]) }), sink)
    await feed.start()
    feed.data(0, 'a')
    feed.data(1, 'b')
    feed.data(1, 'b')
    expect(ops.filter((op) => op.startsWith('write'))).toEqual(['write a', 'write b'])
  })

  it('catches up after a reconnect from the last chunk it wrote', async () => {
    const { sink, ops } = recordingSink()
    const since: number[] = []
    const c = client({
      attach: async () => live([[0, 'a']]),
      bufferSince: async (_sid, afterSeq) => {
        since.push(afterSeq)
        return buffer([
          [1, 'b'],
          [2, 'c']
        ])
      }
    })
    const feed = new TerminalFeed('t:t', c, sink)
    await feed.start()
    // The socket dropped and the subscription started again.
    await feed.start()
    feed.data(2, 'c')
    feed.data(3, 'd')
    expect(since).toEqual([0])
    // Attached once: the reconnect did not start over.
    expect(ops.filter((op) => op === 'reset')).toHaveLength(1)
    expect(ops.filter((op) => op.startsWith('write'))).toEqual([
      'write a',
      'write b',
      'write c',
      'write d'
    ])
  })

  it('fills a gap in the live data from the buffer', async () => {
    const { sink, ops } = recordingSink()
    const c = client({
      attach: async () => live([[0, 'a']]),
      bufferSince: async () =>
        buffer([
          [1, 'b'],
          [2, 'c']
        ])
    })
    const feed = new TerminalFeed('t:t', c, sink)
    await feed.start()
    feed.data(2, 'c')
    await flush()
    expect(ops.filter((op) => op.startsWith('write'))).toEqual(['write a', 'write b', 'write c'])
  })

  it('starts over when a new process at the session id numbers from 0 again', async () => {
    const { sink, ops } = recordingSink()
    let attach = 0
    const c = client({
      attach: async () =>
        ++attach === 1
          ? live([
              [0, 'old'],
              [1, 'old2']
            ])
          : live([[0, 'new']])
    })
    const feed = new TerminalFeed('t:t', c, sink)
    await feed.start()
    ops.length = 0
    feed.data(0, 'new')
    await flush()
    expect(ops).toEqual(['reset', 'resize 120x40', 'write new'])
  })

  it('starts over when a catch-up finds a younger buffer than it had', async () => {
    const { sink, ops } = recordingSink()
    let attach = 0
    const c = client({
      attach: async () =>
        ++attach === 1
          ? live([
              [0, 'a'],
              [1, 'b'],
              [2, 'c']
            ])
          : live([[0, 'x']]),
      bufferSince: async () => ({ chunks: [], currentSeq: 0, prelude: '' })
    })
    const feed = new TerminalFeed('t:t', c, sink)
    await feed.start()
    ops.length = 0
    await feed.start()
    expect(ops).toEqual(['reset', 'resize 120x40', 'write x'])
  })

  it('follows the session size', async () => {
    const { sink, ops } = recordingSink()
    const feed = new TerminalFeed('t:t', client(), sink)
    await feed.start()
    feed.resize(100, 30)
    expect(ops.at(-1)).toBe('resize 100x30')
  })

  it('reports whether a session runs, and why an attach failed', async () => {
    const statuses: unknown[] = []
    const { sink } = recordingSink()
    const none = new TerminalFeed(
      't:t',
      client({ attach: async () => ({ exists: false, state: null, buffer: null, size: null }) }),
      sink,
      (s) => statuses.push(s)
    )
    await none.start()
    expect(statuses.at(-1)).toEqual({ phase: 'ready', exists: false, error: null })

    const failing = new TerminalFeed(
      't:t',
      client({
        attach: async () => {
          throw new Error('hub gone')
        }
      }),
      sink,
      (s) => statuses.push(s)
    )
    await failing.start()
    expect(statuses.at(-1)).toEqual({ phase: 'error', exists: false, error: 'hub gone' })
  })
})
