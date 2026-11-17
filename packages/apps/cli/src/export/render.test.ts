/**
 * `withPage` (render.ts) against a scripted in-process Browser — what happens around
 * the CDP calls, not the calls' wire format (cdp-protocol.test.ts covers that):
 *  - review 6, #2: every JS dialog on the page's session is dismissed, so an html
 *    artifact calling alert()/confirm()/prompt() cannot block the export.
 *  - review 6, #8: a browser that fails to close does not hide the render's own error.
 *  - review 7, #7: nor does it discard a good render (a warning names what is left).
 *  - review 9, F1 / F2 / L1: downloads are denied before the page exists; the
 *    navigation guard and the print() no-op are in place before the document goes in;
 *    a main-frame navigation is refused and fails the export, a child frame's is not.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Browser } from './cdp'
// vi.mock below is hoisted above this import: render.ts gets the scripted browser.
import { DocumentNavigationError, renderPdf } from './render'

type EventListener = (method: string, params: Record<string, unknown>, sessionId?: string) => void

interface Script {
  /** Answers a command; a throw / rejection fails it. */
  answer: (method: string, params: Record<string, unknown>, sessionId?: string) => unknown
  close: () => Promise<void>
}

const calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []
let script: Script
let listeners: EventListener[] = []
/** How the browser was closed, each time. */
const closes: Array<{ kill?: boolean }> = []
/** Set by `failPage`: every pending and later command fails with it. */
let pageFailure: Error | null = null
const failWaiters = new Set<(err: Error) => void>()
/** A command the page never answers on its own (fails only with the page). */
const untilPageFails = (): Promise<never> =>
  new Promise((_, reject) => {
    if (pageFailure) reject(pageFailure)
    else failWaiters.add(reject)
  })
const emit: EventListener = (method, params, sessionId) => {
  for (const l of [...listeners]) l(method, params, sessionId)
}

// The real module (`openPage` drives this fake like any browser), its launch faked.
vi.mock('./cdp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./cdp')>()),
  launchBrowser: async (): Promise<Browser> => {
    const send = async <T>(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string
    ): Promise<T> => {
      calls.push({ method, params, sessionId })
      if (sessionId && pageFailure) throw pageFailure
      return (await script.answer(method, params, sessionId)) as T
    }
    return {
      send,
      sendLong: send,
      onEvent: (l: EventListener) => {
        listeners.push(l)
        return () => {
          listeners = listeners.filter((x) => x !== l)
        }
      },
      failPage: (_sid: string, err: Error) => {
        pageFailure ??= err
        for (const reject of failWaiters) reject(err)
        failWaiters.clear()
      },
      // No OS process behind this page to watch.
      watchProcess: async () => undefined,
      close: (opts?: { kill?: boolean }) => {
        closes.push(opts ?? {})
        return script.close()
      }
    }
  }
}))

/** A page that loads and prints; `override` changes single answers. */
function page(override: Partial<Record<string, Script['answer']>> = {}): Script['answer'] {
  return (method, params, sessionId) => {
    const o = override[method]
    if (o) return o(method, params, sessionId)
    switch (method) {
      case 'Target.createTarget':
        return { targetId: 't1' }
      case 'Target.attachToTarget':
        return { sessionId: 's1' }
      case 'Page.getFrameTree':
        return { frameTree: { frame: { id: 'f1' } } }
      case 'Runtime.evaluate':
        return { result: { value: true } }
      case 'Page.printToPDF':
        return { stream: 'h1' }
      case 'IO.read':
        return { data: Buffer.from('%PDF-1.7').toString('base64'), base64Encoded: true, eof: true }
      default:
        return {}
    }
  }
}

beforeEach(() => {
  calls.length = 0
  listeners = []
  pageFailure = null
  failWaiters.clear()
  closes.length = 0
})

describe('JS dialogs (review 6, #2)', () => {
  test('a dialog that opens while the document loads is dismissed, and loading goes on', {
    timeout: 5_000
  }, async () => {
    script = {
      close: async () => undefined,
      answer: page({
        // The document's script opens a dialog; loading resumes only once it is answered.
        'Page.setDocumentContent': (_m, _p, sid) =>
          new Promise((resolve) => {
            const t = setInterval(() => {
              if (calls.some((c) => c.method === 'Page.handleJavaScriptDialog')) {
                clearInterval(t)
                resolve({})
              }
            }, 5)
            emit('Page.javascriptDialogOpening', { type: 'alert', message: 'hi' }, sid)
          })
      })
    }
    const pdf = await renderPdf('/fake', '<script>alert(1)</script>', { waitReady: false })
    expect(pdf.toString('latin1')).toBe('%PDF-1.7')
    // Page events are on before the document goes in.
    const order = calls.map((c) => c.method)
    expect(order.indexOf('Page.enable')).toBeGreaterThan(-1)
    expect(order.indexOf('Page.enable')).toBeLessThan(order.indexOf('Page.setDocumentContent'))
    const handled = calls.filter((c) => c.method === 'Page.handleJavaScriptDialog')
    expect(handled).toEqual([
      { method: 'Page.handleJavaScriptDialog', params: { accept: false }, sessionId: 's1' }
    ])
  })

  test('every dialog type is dismissed; another session’s dialogs are left alone', async () => {
    script = {
      close: async () => undefined,
      answer: page({
        'Page.setDocumentContent': (_m, _p, sid) => {
          for (const type of ['alert', 'confirm', 'prompt', 'beforeunload']) {
            emit('Page.javascriptDialogOpening', { type, message: type }, sid)
          }
          emit('Page.javascriptDialogOpening', { type: 'alert', message: 'x' }, 'other')
          return {}
        }
      })
    }
    await renderPdf('/fake', '<p>x</p>', { waitReady: false })
    const handled = calls.filter((c) => c.method === 'Page.handleJavaScriptDialog')
    expect(handled.map((c) => c.sessionId)).toEqual(['s1', 's1', 's1', 's1'])
    // No prompt text: a prompt() is cancelled (returns null), not answered.
    for (const c of handled) expect(c.params).toEqual({ accept: false })
  })
})

describe('closing the browser (review 6, #8)', () => {
  test('a render error survives a close that throws', async () => {
    script = {
      close: async () => {
        throw new Error('EBUSY: profile dir still locked')
      },
      answer: page({
        'Page.printToPDF': () => {
          throw new Error('The page crashed while rendering')
        }
      })
    }
    await expect(renderPdf('/fake', '<p>x</p>', { waitReady: false })).rejects.toThrow(
      'The page crashed while rendering'
    )
  })

  // Review 7, #7: the only realistic close failure is the temp profile still held
  // (EBUSY on Windows). The finished PDF is kept; the leftover dir is reported.
  test('a close that throws after a good render keeps the result and warns', async () => {
    script = {
      close: async () => {
        throw new Error("EBUSY: resource busy or locked, rmdir 'C:\\Temp\\slay-export-profile-x'")
      },
      answer: page()
    }
    const warnings: string[] = []
    const pdf = await renderPdf('/fake', '<p>x</p>', {
      waitReady: false,
      warn: (l) => warnings.push(l)
    })
    expect(pdf.toString('latin1')).toBe('%PDF-1.7')
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/^Warning: .*slay-export-profile-x/)
  })
})

describe('what the page may do (review 9, F1 / F2 / L1)', () => {
  const methods = () => calls.map((c) => c.method)

  test('downloads are denied browser-wide before the page is made', async () => {
    script = { close: async () => undefined, answer: page() }
    await renderPdf('/fake', '<p>x</p>', { waitReady: false })
    const deny = calls.find((c) => c.method === 'Browser.setDownloadBehavior')
    expect(deny).toEqual({
      method: 'Browser.setDownloadBehavior',
      params: { behavior: 'deny' },
      sessionId: undefined
    })
    expect(methods().indexOf('Browser.setDownloadBehavior')).toBeLessThan(
      methods().indexOf('Target.createTarget')
    )
  })

  test('the navigation guard, the print() no-op and the download-click denial are in place before the document', async () => {
    script = { close: async () => undefined, answer: page() }
    await renderPdf('/fake', '<p>x</p>', { waitReady: false })
    const doc = methods().indexOf('Page.setDocumentContent')
    const fetch = calls.find((c) => c.method === 'Fetch.enable')
    expect(fetch?.sessionId).toBe('s1')
    expect(fetch?.params).toEqual({
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }]
    })
    expect(methods().indexOf('Fetch.enable')).toBeLessThan(doc)
    // Documents made later (child frames), and the window the document goes into.
    const later = calls.find((c) => c.method === 'Page.addScriptToEvaluateOnNewDocument')
    expect(later?.params.source).toMatch(/'print'/)
    // Follow-up N4: a click on an <a download> is cancelled in the page, re-armed after
    // the document goes in (render.integration: the real browser).
    expect(later?.params.source).toMatch(/hasAttribute\('download'\)/)
    expect(later?.params.source).toMatch(/MutationObserver/)
    const now = calls.findIndex(
      (c) => c.method === 'Runtime.evaluate' && /'print'/.test(String(c.params.expression))
    )
    expect(now).toBeGreaterThan(-1)
    expect(now).toBeLessThan(doc)
    expect(methods().indexOf('Page.addScriptToEvaluateOnNewDocument')).toBeLessThan(doc)
  })

  test('a main-frame document request is failed and fails the export; a child frame’s goes on', async () => {
    script = {
      close: async () => undefined,
      answer: page({
        'Page.setDocumentContent': (_m, _p, sid) => {
          emit(
            'Fetch.requestPaused',
            { requestId: 'r-child', frameId: 'child', request: { url: 'https://a.example/' } },
            sid
          )
          return {}
        },
        // Loading never completes on its own: only the refused navigation ends it.
        'Runtime.evaluate': (_m, p, sid) => {
          if (!String(p.expression).includes('readyState')) return { result: { value: true } }
          emit(
            'Fetch.requestPaused',
            { requestId: 'r-main', frameId: 'f1', request: { url: 'http://127.0.0.1:9/x' } },
            sid
          )
          return untilPageFails()
        }
      })
    }
    const err = await renderPdf('/fake', '<p>x</p>', { waitReady: false }).catch((e) => e)
    expect(err).toBeInstanceOf(DocumentNavigationError)
    expect(err.message).toMatch(/navigate away \(to http:\/\/127\.0\.0\.1:9\/x\)/)
    expect(
      calls.filter((c) => c.method.startsWith('Fetch.') && c.method !== 'Fetch.enable')
    ).toEqual([
      { method: 'Fetch.continueRequest', params: { requestId: 'r-child' }, sessionId: 's1' },
      {
        method: 'Fetch.failRequest',
        params: { requestId: 'r-main', errorReason: 'BlockedByClient' },
        sessionId: 's1'
      }
    ])
    expect(methods()).not.toContain('Page.printToPDF')
    // Ended at once: an orderly shutdown could let a refused navigation out.
    expect(closes).toEqual([{ kill: true }])
  })

  test('a navigation refused after the PDF is done: the PDF is kept, the browser still killed', async () => {
    script = {
      close: async () => undefined,
      answer: page({
        'IO.read': (_m, _p, sid) => {
          emit(
            'Page.frameRequestedNavigation',
            { frameId: 'f1', url: 'https://a.example/', disposition: 'currentTab' },
            sid
          )
          return {
            data: Buffer.from('%PDF-1.7').toString('base64'),
            base64Encoded: true,
            eof: true
          }
        }
      })
    }
    // The read already answered; IO.close (after) fails with the page and is ignored.
    const pdf = await renderPdf('/fake', '<p>x</p>', { waitReady: false })
    expect(pdf.toString('latin1')).toBe('%PDF-1.7')
    expect(closes).toEqual([{ kill: true }])
  })

  test('an export with no navigation closes the browser the orderly way', async () => {
    script = { close: async () => undefined, answer: page() }
    await renderPdf('/fake', '<p>x</p>', { waitReady: false })
    expect(closes).toEqual([{ kill: false }])
  })

  for (const [name, method, params] of [
    [
      'a navigation the renderer asks for',
      'Page.frameRequestedNavigation',
      { frameId: 'f1', url: 'blob:null/1', disposition: 'currentTab', reason: 'scriptInitiated' }
    ],
    [
      'a navigation due now that Chrome refuses itself (data:)',
      'Page.frameScheduledNavigation',
      { frameId: 'f1', url: 'data:text/html,x', delay: 0, reason: 'scriptInitiated' }
    ],
    [
      'a navigation the browser starts',
      'Page.frameStartedNavigating',
      { frameId: 'f1', url: 'about:blank', navigationType: 'differentDocument' }
    ],
    ['a new document committing', 'Page.frameNavigated', { frame: { id: 'f1', url: 'blob:x' } }]
  ] as const) {
    test(`${name} fails the export`, async () => {
      script = {
        close: async () => undefined,
        answer: page({
          'Runtime.evaluate': (_m, p, sid) => {
            if (!String(p.expression).includes('readyState')) return { result: { value: true } }
            emit(method, params, sid)
            return untilPageFails()
          }
        })
      }
      await expect(renderPdf('/fake', '<p>x</p>', { waitReady: false })).rejects.toThrow(
        DocumentNavigationError
      )
    })
  }

  test('fragment and history-API navigations, a child frame’s, a refresh due later: no failure', async () => {
    script = {
      close: async () => undefined,
      answer: page({
        'Page.setDocumentContent': (_m, _p, sid) => {
          // While the document goes in, a main-frame commit is not yet a new document.
          emit('Page.frameNavigated', { frame: { id: 'f1', url: 'about:blank' } }, sid)
          emit(
            'Page.frameScheduledNavigation',
            { frameId: 'f1', url: 'about:blank#a', delay: 0 },
            sid
          )
          emit('Page.navigatedWithinDocument', { frameId: 'f1', url: 'about:blank#a' }, sid)
          emit(
            'Page.frameScheduledNavigation',
            { frameId: 'f1', url: 'about:blank#b', delay: 0 },
            sid
          )
          emit(
            'Page.frameScheduledNavigation',
            { frameId: 'f1', url: 'https://a.example/', delay: 60 },
            sid
          )
          emit(
            'Page.frameStartedNavigating',
            { frameId: 'f1', url: 'about:blank#c', navigationType: 'sameDocument' },
            sid
          )
          emit(
            'Page.frameRequestedNavigation',
            { frameId: 'child', url: 'https://a.example/', disposition: 'currentTab' },
            sid
          )
          emit(
            'Page.frameStartedNavigating',
            { frameId: 'child', url: 'https://a.example/', navigationType: 'differentDocument' },
            sid
          )
          emit(
            'Page.frameNavigated',
            { frame: { id: 'child', parentId: 'f1', url: 'https://a.example/' } },
            sid
          )
          emit(
            'Page.frameRequestedNavigation',
            { frameId: 'f1', url: 'https://a.example/', disposition: 'newTab' },
            sid
          )
          // Another page's navigations are not this one's.
          emit(
            'Page.frameRequestedNavigation',
            { frameId: 'f1', url: 'https://a.example/', disposition: 'currentTab' },
            'other'
          )
          return {}
        }
      })
    }
    const pdf = await renderPdf('/fake', '<p>x</p>', { waitReady: false })
    expect(pdf.toString('latin1')).toBe('%PDF-1.7')
  })
})

// CI round 2: a cross-site child frame loads in a process of its own; the document's
// readyState turns complete without it. The export waits for it, as desktop's
// did-finish-load does.
describe('child frames', () => {
  test('the export prints only once every child frame has stopped loading', {
    timeout: 5_000
  }, async () => {
    let printedWhileLoading: boolean | null = null
    let loading = true
    script = {
      close: async () => undefined,
      answer: page({
        'Page.setDocumentContent': (_m, _p, sid) => {
          emit('Page.frameStartedLoading', { frameId: 'child' }, sid)
          emit('Page.frameStartedLoading', { frameId: 'gone' }, sid)
          // The main frame's own loading state is not what the wait is about.
          emit('Page.frameStartedLoading', { frameId: 'f1' }, sid)
          // Another page's frames are not this one's.
          emit('Page.frameStartedLoading', { frameId: 'other-child' }, 'other')
          setTimeout(() => {
            emit('Page.frameDetached', { frameId: 'gone', reason: 'remove' }, sid)
            loading = false
            emit('Page.frameStoppedLoading', { frameId: 'child' }, sid)
          }, 300)
          return {}
        },
        'Page.printToPDF': () => {
          printedWhileLoading = loading
          return { stream: 'h1' }
        }
      })
    }
    const pdf = await renderPdf('/fake', '<iframe src="https://a.example/"></iframe>', {
      waitReady: false
    })
    expect(pdf.toString('latin1')).toBe('%PDF-1.7')
    expect(printedWhileLoading).toBe(false)
  })
})
