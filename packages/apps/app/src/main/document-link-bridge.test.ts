import type { WebContents, WebFrameMain } from 'electron'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { detectPlatform, type ElectronInput } from '@slayzone/shortcuts'
import { PDF_VIEWER_EXTENSION_ORIGIN } from '@slayzone/platform/pdf-viewer-links'
import { attachDocumentLinkBridges, setDocumentShortcutKeysResolver } from './document-link-bridge'

afterEach(() => setDocumentShortcutKeysResolver(() => []))

function fixture() {
  const listeners = new Map<string, (...args: unknown[]) => void>()
  const executeJavaScript = vi.fn(async (_script: string) => undefined)
  const mainFrame = { executeJavaScript }
  const wc = {
    mainFrame,
    focusedFrame: { url: 'slz-file://app/tmp/report.html', origin: 'null' },
    isDestroyed: () => false,
    on: (event: string, listener: (...args: unknown[]) => void) => listeners.set(event, listener)
  }
  attachDocumentLinkBridges(wc as unknown as WebContents)
  const input: ElectronInput = {
    type: 'keyDown',
    key: 'Y',
    code: 'KeyY',
    meta: detectPlatform() === 'mac',
    control: detectPlatform() !== 'mac',
    shift: true,
    alt: false
  }
  const press = (overrides: Partial<ElectronInput> = {}) => {
    const event = { preventDefault: vi.fn() }
    listeners.get('before-input-event')?.(event, { ...input, ...overrides })
    return event
  }
  return { wc, mainFrame, press, executeJavaScript }
}

describe('document preview shortcut forwarding', () => {
  it('forwards a configured shortcut from HTML to the owning app renderer', () => {
    setDocumentShortcutKeysResolver(() => ['mod+shift+y'])
    const f = fixture()
    expect(f.press().preventDefault).toHaveBeenCalledOnce()
    const dispatchEvent = vi.fn()
    const KeyboardEvent = vi.fn(function (type: string, init: KeyboardEventInit) {
      return { type, ...init }
    })
    runInNewContext(f.executeJavaScript.mock.calls[0][0], {
      document: { dispatchEvent },
      KeyboardEvent
    })
    expect(dispatchEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'keydown',
        key: 'Y',
        code: 'KeyY',
        shiftKey: true,
        bubbles: true
      })
    )
  })

  it('reads live bindings and leaves cleared or unrelated keys alone', () => {
    let keys: string | null = 'mod+shift+y'
    setDocumentShortcutKeysResolver(() => [keys])
    const f = fixture()
    expect(f.press({ key: 'c', shift: false }).preventDefault).not.toHaveBeenCalled()
    keys = 'mod+shift+m'
    expect(f.press().preventDefault).not.toHaveBeenCalled()
    expect(f.press({ key: 'M', code: 'KeyM' }).preventDefault).toHaveBeenCalledOnce()
    keys = null
    expect(f.press({ key: 'M', code: 'KeyM' }).preventDefault).not.toHaveBeenCalled()
    expect(f.executeJavaScript).toHaveBeenCalledOnce()
  })

  it('also forwards from the embedded PDF viewer', () => {
    setDocumentShortcutKeysResolver(() => ['mod+shift+y'])
    const f = fixture()
    f.wc.focusedFrame = {
      url: `${PDF_VIEWER_EXTENSION_ORIGIN}/index.html`,
      origin: PDF_VIEWER_EXTENSION_ORIGIN
    }
    expect(f.press().preventDefault).toHaveBeenCalledOnce()
    expect(f.executeJavaScript).toHaveBeenCalledOnce()
  })

  it('leaves ordinary renderer focus, remote frames and key-up events alone', () => {
    setDocumentShortcutKeysResolver(() => ['mod+shift+y'])
    const f = fixture()
    expect(f.press({ type: 'keyUp' }).preventDefault).not.toHaveBeenCalled()
    f.wc.focusedFrame = f.mainFrame as unknown as WebFrameMain
    expect(f.press().preventDefault).not.toHaveBeenCalled()
    f.wc.focusedFrame = { url: 'https://example.com/', origin: 'https://example.com' }
    expect(f.press().preventDefault).not.toHaveBeenCalled()
    expect(f.executeJavaScript).not.toHaveBeenCalled()
  })
})
