import { $prose } from '@milkdown/utils'
import { Plugin, PluginKey } from '@milkdown/prose/state'

export type LinkOpenTarget = 'in-app-browser' | 'external'

/**
 * Modifier convention shared with terminal and chat links:
 *   ⌘/Ctrl click   → in-app browser
 *   ⌘/Ctrl⇧ click  → external browser
 *   bare click     → nothing (the editor is editable: it places the caret)
 * `mailto:` always goes external; any other scheme is never opened.
 */
export function resolveLinkClickTarget(
  href: string,
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>
): LinkOpenTarget | null {
  if (!event.metaKey && !event.ctrlKey) return null
  if (/^mailto:/i.test(href)) return 'external'
  if (!/^https?:\/\//i.test(href)) return null
  return event.shiftKey ? 'external' : 'in-app-browser'
}

/**
 * Read-only renders (split-view previews): links are click affordances, so a
 * bare click opens externally too (chat convention). `null` = not openable; the
 * caller still prevents the anchor from navigating the app window.
 */
export function resolveReadOnlyLinkClickTarget(
  href: string,
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'shiftKey'>
): LinkOpenTarget | null {
  if (event.metaKey || event.ctrlKey) return resolveLinkClickTarget(href, event)
  return /^(https?:\/\/|mailto:)/i.test(href) ? 'external' : null
}

/**
 * Opens markdown links (`[text](url)` and GFM autolinks) on a modified click.
 * Inline-HTML anchors and `artifact:` chips have their own handlers.
 */
export function createLinkClickPlugin(onOpenLink: (href: string, target: LinkOpenTarget) => void) {
  return $prose(
    () =>
      new Plugin({
        key: new PluginKey('linkClick'),
        props: {
          handleDOMEvents: {
            click(view, event) {
              if (event.button !== 0) return false
              const anchor = (event.target as Element | null)?.closest?.('a[href]')
              if (!anchor || !view.dom.contains(anchor)) return false
              const href = anchor.getAttribute('href') ?? ''
              const target = resolveLinkClickTarget(href, event)
              if (!target) return false
              event.preventDefault()
              onOpenLink(href, target)
              return true
            }
          }
        }
      })
  )
}
