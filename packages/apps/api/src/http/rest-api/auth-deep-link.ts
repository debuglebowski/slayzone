import type { Express } from 'express'
import type { RestApiDeps } from './types'
import { parseAuthCallbackUrl } from '../../auth-github'
import { getAuthEvents } from '../../app-deps'

// OAuth deep-link entry point for platforms where `slayzone://` is routed to the
// sidecar over HTTP rather than the C++ Unix socket (Linux today; the Windows
// subtask can reuse it). A `.desktop` `x-scheme-handler/slayzone` handler →
// `scripts/chromium/linux/slayzone-deeplink.sh` POSTs the callback URL here. This
// converges on the SAME chain the macOS socket path uses (sidecar-socket.ts):
// `parseAuthCallbackUrl` → `authEvents.emit('callback')` → the `app.auth.onCallback`
// tRPC subscription → the renderer's ConvexAuthBridge completes the Convex sign-in.
//
// Accepts the URL via `?url=` (the curl `-G --data-urlencode` form the helper uses —
// safe encoding, no body parser needed) OR a JSON `{ url }` body. Localhost-bound
// like every other /api route. Harmless where nothing subscribes (Electron uses the
// inline-mutation path), so it is registered unconditionally.
export function registerAuthDeepLinkRoute(app: Express, _deps: RestApiDeps): void {
  app.post('/api/auth/deep-link', (req, res) => {
    const raw = req.query?.url ?? (req.body as { url?: unknown } | undefined)?.url
    const url = typeof raw === 'string' ? raw : undefined
    if (!url) {
      res.status(400).json({ ok: false, error: 'url required' })
      return
    }
    const callback = parseAuthCallbackUrl(url)
    if (!callback) {
      res.status(400).json({ ok: false, error: 'not a slayzone://auth/callback url' })
      return
    }
    getAuthEvents().emit('callback', callback)
    res.json({ ok: true })
  })
}
