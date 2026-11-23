import { ipcRenderer } from 'electron'
import {
  HTML_PREVIEW_LINK_MESSAGE_TYPE,
  parseHtmlPreviewLinkMessage
} from '@slayzone/platform/html-preview-links'
import {
  HTML_PROTOTYPE_ACTION,
  parseHtmlPrototypeAction
} from '@slayzone/platform/html-prototype-actions'
import {
  ARTIFACT_DEVICE_TOUCH_INPUT,
  ARTIFACT_DEVICE_TOUCH_MODE,
  type ArtifactDeviceTouchInput
} from '@slayzone/platform/preview-devices'
import { SLZ_ARTIFACT_SCHEME } from '@slayzone/platform/slz-file-url'

// Every mouse-driven event a touch screen would not produce.
const MOUSE_EVENTS = [
  'pointerdown',
  'pointermove',
  'pointerup',
  'pointercancel',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'mousedown',
  'mousemove',
  'mouseup',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu'
] as const

/** A real mouse, not a page-made event or the mouse events a tap is followed by. */
function isFromMouse(event: Event): event is MouseEvent {
  if (!event.isTrusted || !(event instanceof MouseEvent)) return false
  if (event instanceof PointerEvent) return event.pointerType === 'mouse'
  const capabilities = (
    event as MouseEvent & { sourceCapabilities?: { firesTouchEvents: boolean } }
  ).sourceCapabilities
  return !capabilities?.firesTouchEvents
}

/**
 * Mobile previews: the primary mouse button acts as a finger. Main replays the
 * forwarded input as real touch on this guest only, and every other mouse event
 * is withheld from the page, as on a touch screen. Desktop previews are untouched.
 */
function installMouseAsTouch() {
  let touchMode = false
  let touching = false
  const send = (type: ArtifactDeviceTouchInput['type'], x = 0, y = 0) => {
    const input: ArtifactDeviceTouchInput = { type, x, y }
    ipcRenderer.send(ARTIFACT_DEVICE_TOUCH_INPUT, input)
  }
  const cancel = () => {
    if (!touching) return
    touching = false
    send('touchCancel')
  }
  const onMouse = (event: Event) => {
    if (!touchMode || !isFromMouse(event)) return
    event.preventDefault()
    event.stopImmediatePropagation()
    const { clientX: x, clientY: y } = event
    switch (event.type) {
      case 'pointerdown':
        if (event.button !== 0) return
        touching = true
        send('touchStart', x, y)
        return
      case 'pointermove':
        if (touching) send('touchMove', x, y)
        return
      case 'pointerup':
        if (event.button !== 0 || !touching) return
        touching = false
        send('touchEnd', x, y)
        return
      case 'pointercancel':
        cancel()
    }
  }
  // Capture on window, registered before any page script: the page never sees them.
  for (const type of MOUSE_EVENTS) window.addEventListener(type, onMouse, true)
  window.addEventListener('blur', cancel)
  const setTouchMode = (enabled: unknown) => {
    touchMode = enabled === true
    if (!touchMode) touching = false
  }
  ipcRenderer.on(ARTIFACT_DEVICE_TOUCH_MODE, (_event, enabled: unknown) => setTouchMode(enabled))
  void ipcRenderer.invoke(ARTIFACT_DEVICE_TOUCH_MODE).then(setTouchMode, () => {
    // Main had no handler (guest torn down): leave the mouse as is.
  })
}

if (process.isMainFrame && location.protocol === `${SLZ_ARTIFACT_SCHEME}:`) {
  installMouseAsTouch()

  // Give the page the same message as an iframe while keeping IPC in the preload.
  ipcRenderer.on(HTML_PROTOTYPE_ACTION, (_event, action: unknown, value: unknown) => {
    const message = parseHtmlPrototypeAction({ type: HTML_PROTOTYPE_ACTION, action, value })
    if (message) window.postMessage(message, '*')
  })

  // Runs in the guest's isolated world. Only a real link click can reach the
  // embedder; the artifact page has no access to this IPC channel.
  const openLink = (event: MouseEvent) => {
    if (!event.isTrusted || event.defaultPrevented) return
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null
    if (!anchor) return
    let url: string
    try {
      url = new URL(anchor.getAttribute('href') ?? '', document.baseURI).href
    } catch {
      return
    }
    const middleClick = event.button === 1
    const message = parseHtmlPreviewLinkMessage({
      type: HTML_PREVIEW_LINK_MESSAGE_TYPE,
      url,
      metaKey: middleClick || event.metaKey,
      ctrlKey: event.ctrlKey,
      shiftKey: !middleClick && event.shiftKey
    })
    if (!message) return
    event.preventDefault()
    ipcRenderer.sendToHost(HTML_PREVIEW_LINK_MESSAGE_TYPE, message)
  }
  window.addEventListener(
    'DOMContentLoaded',
    () => {
      window.addEventListener('click', (event) => {
        if (event.button === 0) openLink(event)
      })
      window.addEventListener('auxclick', (event) => {
        if (event.button === 1) openLink(event)
      })
    },
    { once: true }
  )
}
