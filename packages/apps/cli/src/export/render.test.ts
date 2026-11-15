/**
 * `withPage` (render.ts) against a scripted in-process Browser — what happens around
 * the CDP calls, not the calls' wire format (cdp-protocol.test.ts covers that):
 *  - review 6, #2: every JS dialog on the page's session is dismissed, so an html
 *    artifact calling alert()/confirm()/prompt() cannot block the export.
 *  - review 6, #8: a browser that fails to close does not hide the render's own error.
 */
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { Browser } from './cdp'
// vi.mock below is hoisted above this import: render.ts gets the scripted browser.
import { renderPdf } from './render'

type EventListener = (method: string, params: Record<string, unknown>, sessionId?: string) => void

interface Script {
  /** Answers a command; a throw / rejection fails it. */
  answer: (method: string, params: Record<string, unknown>, sessionId?: string) => unknown
  close: () => Promise<void>
}

const calls: Array<{ method: string; params: Record<string, unknown>; sessionId?: string }> = []
let script: Script
let listeners: EventListener[] = []
const emit: EventListener = (method, params, sessionId) => {
  for (const l of [...listeners]) l(method, params, sessionId)
}

vi.mock('./cdp', () => ({
  launchBrowser: async (): Promise<Browser> => {
    const send = async <T>(
      method: string,
      params: Record<string, unknown> = {},
      sessionId?: string
    ): Promise<T> => {
      calls.push({ method, params, sessionId })
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
      close: () => script.close()
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

  test('a close that throws after a good render fails the render', async () => {
    script = {
      close: async () => {
        throw new Error('EBUSY: profile dir still locked')
      },
      answer: page()
    }
    await expect(renderPdf('/fake', '<p>x</p>', { waitReady: false })).rejects.toThrow('EBUSY')
  })
})
