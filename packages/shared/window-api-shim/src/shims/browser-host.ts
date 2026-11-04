// The fork's client-local browser host: the generic `window.api.browserHost` the
// canonical browser panel drives (`@slayzone/task-browser`'s `BrowserHostMethods`),
// resolved against the native mojo host shims in `./browser` and `./webview`.
//
// The shims implement only a subset, so every method falls back to the same inert
// answer a "not supported" host gives — read-only probes degrade, never throw.
// `tabs.*` (the `slay browser` relay targets) are not implemented by the fork.

import type { ElectronBrowserHost } from '@slayzone/platform/electron-bootstrap-contract'
import { browserShim } from './browser'
import { webviewShim } from './webview'

type AnyFn = (...args: unknown[]) => unknown
type Bag = Record<string, AnyFn | undefined>

const browser = browserShim as unknown as Bag
const webview = webviewShim as unknown as Bag

const call = (ns: Bag, name: string, args: unknown[], fallback?: unknown): unknown => {
  const fn = ns[name]
  return typeof fn === 'function' ? fn(...args) : fallback
}

const notSupported = (): never => {
  throw new Error('Not supported by this browser host')
}

/** `BrowserHostMethods` key → the shim member that answers it, and its fallback. */
const METHODS: Record<string, (args: unknown[]) => unknown> = {
  'view.create': (a) => call(browser, 'createView', a, null),
  'view.destroy': (a) => call(browser, 'destroyView', a),
  'view.destroyAllForTask': (a) => call(browser, 'destroyAllForTask', a),
  'view.reparentToCurrentWindow': (a) => call(browser, 'reparentToCurrentWindow', a, { ok: false }),
  'view.setBounds': (a) => call(browser, 'setBounds', a),
  'view.setVisible': (a) => call(browser, 'setVisible', a),
  'view.setLocked': (a) => call(browser, 'setLocked', a),
  'view.hideAll': (a) => call(browser, 'hideAll', a),
  'view.showAll': (a) => call(browser, 'showAll', a),
  'view.setHandoffPolicy': (a) => call(browser, 'setHandoffPolicy', a),
  'view.navigate': (a) => call(browser, 'navigate', a),
  'view.goBack': (a) => call(browser, 'goBack', a),
  'view.goForward': (a) => call(browser, 'goForward', a),
  'view.reload': (a) => call(browser, 'reload', a),
  'view.stop': (a) => call(browser, 'stop', a),
  'view.executeJs': (a) => call(browser, 'executeJs', a),
  'view.insertCss': (a) => call(browser, 'insertCss', a, ''),
  'view.removeCss': (a) => call(browser, 'removeCss', a),
  'view.setForcedTheme': (a) => call(browser, 'setForcedTheme', a),
  'view.setZoom': (a) => call(browser, 'setZoom', a),
  'view.focus': (a) => call(browser, 'focus', a),
  'view.findInPage': (a) => call(browser, 'findInPage', a, null),
  'view.stopFindInPage': (a) => call(browser, 'stopFindInPage', a),
  'view.setKeyboardPassthrough': (a) => call(browser, 'setKeyboardPassthrough', a),
  'view.sendInputEvent': (a) => call(browser, 'sendInputEvent', a),
  'view.openDevTools': (a) => call(browser, 'openDevTools', a),
  'view.closeDevTools': (a) => call(browser, 'closeDevTools', a),
  'view.isDevToolsOpen': (a) => call(browser, 'isDevToolsOpen', a, false),
  'view.getWebContentsId': (a) => call(browser, 'getWebContentsId', a, null),
  'view.list': (a) => call(browser, 'listViews', a, []),
  // The shim's own `onEvent` replays state to each new subscriber already.
  'view.stateSnapshots': () => [],
  'extensions.list': (a) => call(browser, 'getExtensions', a, []),
  'extensions.load': (a) => call(browser, 'loadExtension', a, null),
  'extensions.remove': (a) => call(browser, 'removeExtension', a),
  'extensions.discover': (a) => call(browser, 'discoverBrowserExtensions', a, []),
  'extensions.import': (a) => call(browser, 'importExtension', a, { error: 'not supported' }),
  'extensions.activate': (a) => call(browser, 'activateExtension', a, false),
  'webview.registerShortcuts': (a) => call(webview, 'registerShortcuts', a),
  'webview.setKeyboardPassthrough': (a) => call(webview, 'setKeyboardPassthrough', a),
  'webview.setDesktopHandoffPolicy': (a) => call(webview, 'setDesktopHandoffPolicy', a, false),
  'webview.openDevToolsBottom': (a) => call(webview, 'openDevToolsBottom', a, false),
  'webview.openDevToolsDetached': (a) => call(webview, 'openDevToolsDetached', a, false),
  'webview.closeDevTools': (a) => call(webview, 'closeDevTools', a, false),
  'webview.isDevToolsOpened': (a) => call(webview, 'isDevToolsOpened', a, false),
  'webview.enableDeviceEmulation': (a) => call(webview, 'enableDeviceEmulation', a, false),
  'webview.disableDeviceEmulation': (a) => call(webview, 'disableDeviceEmulation', a, false),
  // The fork's embedded-tab host already knows each tab's task; there is no
  // separate registry to keep.
  'tabs.register': () => undefined,
  'tabs.unregister': () => undefined,
  'tabs.setActive': () => undefined,
  'tabs.execJs': notSupported,
  'tabs.loadUrl': notSupported,
  'tabs.getUrl': notSupported,
  'tabs.capturePng': notSupported
}

/** Host event name → the shim subscription that delivers it. */
const EVENTS: Array<[event: string, ns: Bag, member: string]> = [
  ['event', browser, 'onEvent'],
  ['shortcut', browser, 'onBrowserViewShortcut'],
  ['focused', browser, 'onBrowserViewFocused'],
  ['create-task-from-link', browser, 'onCreateTaskFromLink'],
  ['webview-shortcut', webview, 'onShortcut']
]

export const browserHostShim: ElectronBrowserHost = {
  invoke: async (method, args) => {
    const run = METHODS[method]
    if (!run) throw new Error(`browser host: unknown method ${method}`)
    return run(args)
  },
  on: (listener) => {
    const offs: Array<() => void> = []
    for (const [event, ns, member] of EVENTS) {
      const sub = ns[member]
      if (typeof sub !== 'function') continue
      const off = sub((payload: unknown) => listener(event, payload))
      if (typeof off === 'function') offs.push(off as () => void)
    }
    return () => {
      for (const off of offs) off()
    }
  }
}
