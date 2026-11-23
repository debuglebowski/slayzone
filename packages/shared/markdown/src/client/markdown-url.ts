import { defaultUrlTransform } from 'react-markdown'

/**
 * App link schemes kept in rendered markdown. Agents link artifacts
 * (`[title](artifact:<id>)`, the convention the slay CLI teaches), tasks
 * (`slayzone://task/<id>`) and local files (`file://`); the host's click
 * handler opens them in-app. None of them can run script.
 */
const APP_LINK_SCHEMES: ReadonlySet<string> = new Set(['artifact', 'slayzone', 'file'])

/**
 * `react-markdown`'s default transform blanks every scheme outside
 * http(s)/mailto/irc(s)/xmpp to `href=""` — a link to the current page, so a
 * click reloaded the whole app. Keep the app schemes; everything else (e.g.
 * `javascript:`) is still dropped.
 */
export function markdownUrlTransform(url: string): string {
  const safe = defaultUrlTransform(url)
  if (safe) return safe
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  return scheme && APP_LINK_SCHEMES.has(scheme) ? url : ''
}
