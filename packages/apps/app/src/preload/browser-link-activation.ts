/**
 * A plain click on a link in a browser-panel page (the tab's own preload, isolated
 * world). The preload reports it to main SYNCHRONOUSLY, before the click's default
 * action starts the navigation, so main knows which URL the user clicked when that
 * navigation's request arrives. Main believes the report only right after real input
 * it received in that tab, and only a GET to exactly that URL uses it
 * (`UserLocalAccess.userActivatesLink`): a page that rewrites the link, or navigates
 * or POSTs somewhere else, gains nothing.
 */

export { USER_LINK_ACTIVATION_CHANNEL } from '../shared/browser-link-activation-channel'

/** The URL a plain left click on a link navigates THIS tab to, or null. A modified,
 *  middle or new-window click (other paths: the modified-link bridge, popups) is null. */
export function plainLinkActivationUrl(event: MouseEvent): string | null {
  if (event.button !== 0) return null
  if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return null
  const target = event.target
  if (!target || typeof (target as Element).closest !== 'function') return null
  const anchor = (target as Element).closest('a[href], area[href]') as
    | HTMLAnchorElement
    | HTMLAreaElement
    | null
  if (!anchor) return null
  const frame = (anchor.getAttribute('target') ?? '').trim().toLowerCase()
  if (frame !== '' && frame !== '_self' && frame !== '_top') return null
  if (anchor.hasAttribute('download')) return null
  const href = anchor.href
  return /^https?:\/\//i.test(href) ? href : null
}

/** Report every trusted plain link click (capture phase: before the page's handlers). */
export function installUserLinkActivationReport(report: (url: string) => void): void {
  window.addEventListener(
    'click',
    (event) => {
      if (!event.isTrusted) return
      const url = plainLinkActivationUrl(event)
      if (url) report(url)
    },
    true
  )
}
