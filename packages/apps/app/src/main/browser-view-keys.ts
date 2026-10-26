import { detectPlatform, isPrimaryModifier, type Platform } from '@slayzone/shortcuts'

/** Primary+key combos that always pass through to the webpage (clipboard, undo, scroll). */
const BROWSER_DEFAULT_PASSTHROUGH = new Set([
  'c',
  'v',
  'x',
  'a',
  'z', // clipboard + undo
  'arrowup',
  'arrowdown' // scroll to top/bottom
])

export type BrowserViewKeyInput = Pick<Electron.Input, 'key' | 'control' | 'meta' | 'shift' | 'alt'>

export type BrowserViewKeyAction =
  /** No Cmd/Ctrl held — the page gets the key untouched. */
  | { kind: 'ignore' }
  /** Native edit/scroll combo — the page gets the key untouched. */
  | { kind: 'passthrough' }
  /** Reload this browser view. */
  | { kind: 'reload-view' }
  /** Emit this menu event from main. */
  | {
      kind: 'menu'
      event:
        | 'reload-app'
        | 'open-project-settings'
        | 'open-settings'
        | 'screenshot-trigger'
        | 'go-home'
    }
  /** Forward to the renderer as a synthetic KeyboardEvent (app shortcuts). */
  | { kind: 'forward' }

/**
 * Decide what a keyDown inside a browser-panel WebContentsView does when keyboard
 * passthrough is off. The main-process keys use the platform's primary modifier
 * (Cmd on macOS, Ctrl elsewhere) — gating on `meta` alone swallowed Ctrl+C/V on
 * Windows/Linux, where meta is the Win/Super key. Any Cmd/Ctrl combo that isn't
 * handled here is forwarded, so the renderer's shortcut registry decides.
 */
export function classifyBrowserViewKey(
  input: BrowserViewKeyInput,
  platform: Platform = detectPlatform()
): BrowserViewKeyAction {
  if (!(input.control || input.meta)) return { kind: 'ignore' }

  const key = input.key.toLowerCase()
  const primary = isPrimaryModifier({ metaKey: input.meta, ctrlKey: input.control }, platform)

  if (BROWSER_DEFAULT_PASSTHROUGH.has(key) && primary && !input.alt) return { kind: 'passthrough' }
  if (!primary) return { kind: 'forward' }

  if (key === 'r' && !input.alt) {
    return input.shift ? { kind: 'menu', event: 'reload-app' } : { kind: 'reload-view' }
  }
  if (key === ',')
    return { kind: 'menu', event: input.shift ? 'open-project-settings' : 'open-settings' }
  if (key === 's' && input.shift) return { kind: 'menu', event: 'screenshot-trigger' }
  if (input.key === '§') return { kind: 'menu', event: 'go-home' }
  return { kind: 'forward' }
}
