// The web shell's `window.api` — the bootstrap-only preload contract
// (`@slayzone/types`' `ElectronAPI`, 17 `app.*` methods + 2 `files.*`) that
// `electronBootstrap` (@slayzone/transport/client) reads. Everything domain/
// backend goes over tRPC; this is ONLY the handful of methods a client needs
// before (or instead of) a tRPC connection exists.
//
// Deliberately NOT `@slayzone/window-api-shim`: that package's barrel pulls in
// every shim namespace down to `transport/mojo.ts` (mojo-bindings), most of
// which routes to the sidecar's `jsonRpcCall` dispatch — a hard switch over
// exactly 3 methods, `default: -32601` for everything else. The web shell has
// no such dispatch to route to at all, so importing that dead weight would
// buy nothing. This file implements ONLY the real typed contract, and nothing
// beyond it is silently stubbed — see the Proxy at the bottom.
import type { ElectronAPI, HubEntry } from '@slayzone/types'
import { resolveServerUrl, resolveWindowId } from './server-url'
import { getStoredSessionToken, setStoredSessionToken } from './web-session-storage'

const NOT_SUPPORTED = 'Not supported in the browser'

/** The single conceptual "hub" a web session ever talks to: itself, same-origin. */
const LOCAL_HUB_ID = 'local'

async function hubLogin(payload: {
  hubId: string
  url: string
  email: string
  password: string
}): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/auth/web-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ email: payload.email, password: payload.password })
    })
    const body = (await res.json().catch(() => null)) as
      | { ok: true; token: string }
      | { ok: false; error: string }
      | null
    if (!res.ok || !body || !body.ok) {
      const error = (body && !body.ok && body.error) || `Sign-in failed (${res.status})`
      return { ok: false, error }
    }
    // The cookie the response also set covers /api/* REST calls; this covers
    // /trpc, which authenticates via connectionParams, not a cookie — see
    // web-session-storage.ts and main.tsx's boot sequence.
    setStoredSessionToken(body.token)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' }
  }
}

const webApiTarget: ElectronAPI = {
  app: {
    getServerUrl: async () => resolveServerUrl(),
    // No multi-hub concept for a browser session — it only ever talks to the
    // one hub that served it.
    getBootConfig: async () => ({ multiHub: false }),
    getHubRegistry: async () => {
      const hubs: HubEntry[] = [{ id: LOCAL_HUB_ID, kind: 'local', label: 'This hub' }]
      return { hubs, defaultHubId: LOCAL_HUB_ID }
    },
    getHubTokens: async (): Promise<Record<string, string>> => {
      const token = getStoredSessionToken()
      return token ? { [LOCAL_HUB_ID]: token } : {}
    },
    // No-op: the web shell has exactly one hub token, written by hubLogin
    // itself. Accepted rather than rejected — its return type has no error
    // variant (`Promise<{ok:true}>`), and desktop's own multi-hub UI calling
    // this against a browser session should degrade silently, not throw.
    setHubToken: async () => ({ ok: true }),
    hubLogin,
    getWindowId: async () => resolveWindowId(),
    relaunch: async () => {
      window.location.reload()
    },
    setBootSettings: async () => ({ ok: true }),
    probeServerHealth: async () => ({ ok: false, error: NOT_SUPPORTED }),
    restartSidecar: async () => ({ ok: false, error: NOT_SUPPORTED }),
    restartLocalComputer: async () => ({ ok: false, error: NOT_SUPPORTED }),
    // A plain boolean, NOT a function — `electron-bootstrap.ts` wraps it as
    // `() => api().app.isPlaywright`, and a function reference here would make
    // every truthiness check on it (`if (api().app.isPlaywright)`) pass, which
    // is exactly the bug `window-api-shim/src/shims/app.ts` documents having
    // fixed once already.
    isPlaywright: false,
    // Pure boot-timing telemetry (desktop's main process times its own
    // window-show latency off these calls) — nothing to measure for a
    // browser tab, so both are deliberate no-ops.
    dataReady: () => {
      /* no boot-timing telemetry to record for a browser tab */
    },
    bootMark: () => {
      /* no boot-timing telemetry to record for a browser tab */
    }
  },
  files: {
    // No native drag/drop or paste-file bridge on the web — the browser's own
    // File/DataTransfer APIs (already used by whatever calls these) are the
    // real path; these two exist only so electron-bootstrap's bare calls
    // (e.g. Terminal.tsx's getPastePaths()) don't throw.
    getDropPaths: () => [],
    getPastePaths: () => []
  }
}

function namedApiError(path: string): Error {
  return new Error(`[web-shell] window.api${path} is not implemented for the web shell`)
}

/**
 * Wrap a namespace object in a Proxy that throws a NAMED error for any key
 * outside the typed contract — e.g. a stray legacy `window.api.app.getX()`
 * left over from a removed method. A loud, specific failure beats the fork's
 * `makeStubNamespace` silence: `app`/`files` are a known-total contract here
 * (the 17+2 `ElectronAPI` methods), every key on them is expected to exist on
 * EVERY host, so a miss genuinely is a bug worth a named error naming it.
 */
function wrapNamespace<T extends object>(ns: T, prefix: string): T {
  return new Proxy(ns, {
    get(target, prop, receiver) {
      if (prop in target || typeof prop === 'symbol') return Reflect.get(target, prop, receiver)
      throw namedApiError(`${prefix}.${String(prop)}`)
    }
  })
}

export function setupWindowApi(): ElectronAPI {
  // Deliberately a PLAIN object at the top level, not itself Proxy-wrapped:
  // `browser-mojo-link.ts` / `embedded-tab-host.ts` (shared renderer-app code
  // this shell also mounts) do `window.api?.browser ?? null` as an intentional
  // feature-detect — `browser` is never part of `ElectronAPI` and is genuinely
  // absent on every host but the fork's own mojo-backed shim. A top-level
  // throwing Proxy would turn that existing, working optional-chain into an
  // uncaught exception instead of the `null` it expects. The per-namespace
  // Proxies below are the loud-failure layer; the object holding them plays by
  // ordinary JS property-access rules.
  return {
    app: wrapNamespace(webApiTarget.app, '.app'),
    files: wrapNamespace(webApiTarget.files, '.files')
  }
}
