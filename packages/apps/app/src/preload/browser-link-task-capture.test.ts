// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import {
  buildBrowserCreateTaskFromLinkCaptureScript,
  extractCreateTaskFromLinkPayload,
  installBrowserCreateTaskFromLinkCapture,
} from './browser-link-task-capture'

function dispatchClick(target: Element, init?: MouseEventInit): MouseEvent {
  return dispatchMouseEvent('click', target, init)
}

function dispatchMouseEvent(type: 'click' | 'mousedown', target: Element, init?: MouseEventInit): MouseEvent {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button: 0,
    ...init,
  })
  target.dispatchEvent(event)
  return event
}

describe('extractCreateTaskFromLinkPayload', () => {
  it('extracts http link payload for Alt+Shift-click on a top-level anchor', () => {
    document.body.innerHTML = '<a id="docs" href="https://example.com/docs"><span> Example   docs </span></a>'
    const anchor = document.getElementById('docs')
    expect(anchor).toBeInstanceOf(HTMLAnchorElement)

    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      altKey: true,
      shiftKey: true,
      button: 0,
    })
    Object.defineProperty(event, 'target', { value: anchor, configurable: true })

    expect(extractCreateTaskFromLinkPayload(event)).toEqual({
      url: 'https://example.com/docs',
      linkText: 'Example docs',
    })
  })

  it('ignores clicks without the exact modifier gesture or unsupported schemes', () => {
    document.body.innerHTML = '<a id="mailto" href="mailto:test@example.com">Mail</a>'
    const anchor = document.getElementById('mailto')
    expect(anchor).toBeInstanceOf(HTMLAnchorElement)

    const noAlt = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    Object.defineProperty(noAlt, 'target', { value: anchor, configurable: true })
    expect(extractCreateTaskFromLinkPayload(noAlt)).toBeNull()

    const altOnly = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, altKey: true })
    Object.defineProperty(altOnly, 'target', { value: anchor, configurable: true })
    expect(extractCreateTaskFromLinkPayload(altOnly)).toBeNull()

    const withMeta = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, altKey: true, shiftKey: true, metaKey: true })
    Object.defineProperty(withMeta, 'target', { value: anchor, configurable: true })
    expect(extractCreateTaskFromLinkPayload(withMeta)).toBeNull()
  })

  it('accepts a target from another realm when it exposes closest()', () => {
    document.body.innerHTML = '<a id="docs" href="https://example.com/docs">Example docs</a>'
    const anchor = document.getElementById('docs')
    expect(anchor).toBeInstanceOf(HTMLAnchorElement)

    const event = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      altKey: true,
      shiftKey: true,
      button: 0,
    })
    Object.defineProperty(event, 'target', {
      value: {
        closest: (selector: string) => selector === 'a[href]' ? anchor : null,
      },
      configurable: true,
    })

    expect(extractCreateTaskFromLinkPayload(event)).toEqual({
      url: 'https://example.com/docs',
      linkText: 'Example docs',
    })
  })
})

describe('installBrowserCreateTaskFromLinkCapture', () => {
  it('installs one capture handler that prevents navigation and forwards the payload', () => {
    const bridge = vi.fn()
    ;((window as unknown) as Record<string, unknown>).__testBridge = bridge
    document.body.innerHTML = '<a id="docs" href="https://example.com/docs"><span>Example docs</span></a>'
    const anchor = document.getElementById('docs')
    expect(anchor).toBeTruthy()

    installBrowserCreateTaskFromLinkCapture('__testBridge', '__testBridgeInstalled')
    installBrowserCreateTaskFromLinkCapture('__testBridge', '__testBridgeInstalled')

    const mouseDownEvent = dispatchMouseEvent('mousedown', anchor as Element, { altKey: true, shiftKey: true })
    const event = dispatchClick(anchor as Element, { altKey: true, shiftKey: true })
    expect(mouseDownEvent.defaultPrevented).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(bridge).toHaveBeenCalledTimes(1)
    expect(bridge).toHaveBeenCalledWith({
      url: 'https://example.com/docs',
      linkText: 'Example docs',
    })
  })
})

describe('buildBrowserCreateTaskFromLinkCaptureScript', () => {
  it('builds a self-contained installer script that forwards payloads', () => {
    const bridge = vi.fn()
    ;((window as unknown) as Record<string, unknown>).__scriptBridge = bridge
    document.body.innerHTML = '<a id="docs" href="https://example.com/docs"><span>Example docs</span></a>'
    const anchor = document.getElementById('docs')
    expect(anchor).toBeTruthy()

    const script = buildBrowserCreateTaskFromLinkCaptureScript('__scriptBridge', '__scriptBridgeInstalled')
    eval(script)

    const mouseDownEvent = dispatchMouseEvent('mousedown', anchor as Element, { altKey: true, shiftKey: true })
    const event = dispatchClick(anchor as Element, { altKey: true, shiftKey: true })
    expect(mouseDownEvent.defaultPrevented).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(bridge).toHaveBeenCalledTimes(1)
    expect(bridge).toHaveBeenCalledWith({
      url: 'https://example.com/docs',
      linkText: 'Example docs',
    })
  })
})
