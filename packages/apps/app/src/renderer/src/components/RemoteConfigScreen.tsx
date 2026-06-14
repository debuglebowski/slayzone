import { useEffect, useState } from 'react'
import { electronBootstrap } from '@slayzone/transport/client'

interface Props {
  // url may be empty (never configured) or stale (server unreachable). The
  // parent renders this screen pre-mount of TrpcProvider, so there is no
  // tRPC client — everything goes over the preload bootstrap IPCs.
  initialUrl: string
}

type ProbeState =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ok'; normalizedUrl: string }
  | { kind: 'fail'; reason: string }

/**
 * Boot-recovery screen for remote mode (slice 7). Shown instead of the app
 * when `server_mode = remote` but the configured URL is missing or its
 * /health probe fails — mounting TrpcProvider against a dead URL would just
 * WS-reconnect-loop forever behind a blank window.
 *
 * Self-contained inline styling: this renders before ThemeProvider exists, so
 * theme token classes would not resolve.
 */
export function RemoteConfigScreen({ initialUrl }: Props) {
  const [url, setUrl] = useState(initialUrl)
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)

  // The window is only shown when the renderer signals data-ready (with a 5s
  // fallback in main). The normal signal comes from useTasksData, which never
  // mounts on this path — fire it explicitly or the user stares at nothing.
  useEffect(() => {
    electronBootstrap.dataReady()
  }, [])

  const runProbe = async (): Promise<void> => {
    setProbe({ kind: 'probing' })
    const result = await electronBootstrap.probeServerHealth(url)
    if (result.ok && result.normalizedUrl) {
      setProbe({ kind: 'ok', normalizedUrl: result.normalizedUrl })
    } else {
      setProbe({ kind: 'fail', reason: result.error ?? 'Unreachable' })
    }
  }

  const saveAndRelaunch = async (mode: 'local' | 'remote'): Promise<void> => {
    setSaving(true)
    try {
      // Local fallback only flips the mode — never persists the (possibly
      // garbage) URL from the input. setBootSettings rejects invalid URLs.
      await electronBootstrap.setBootSettings(
        mode === 'remote'
          ? { server_mode: mode, remote_server_url: url.trim() }
          : { server_mode: mode }
      )
      await electronBootstrap.relaunch()
      // app.relaunch() exits the process; only the Playwright no-op gets here.
    } catch (err) {
      setProbe({ kind: 'fail', reason: err instanceof Error ? err.message : String(err) })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      data-testid="remote-config-screen"
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: '#0a0a0a',
        color: '#e8e8e8',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      }}
    >
      <div
        style={{
          width: 480,
          padding: 32,
          background: '#141414',
          borderRadius: 12,
          border: '1px solid #2a2a2a'
        }}
      >
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Configure remote server</h1>
        <p style={{ fontSize: 13, color: '#999', marginBottom: 20, lineHeight: 1.5 }}>
          SlayZone is set to remote mode but the configured server is unreachable. Fix the URL
          below, or switch back to local mode.
        </p>

        <label style={{ display: 'block', fontSize: 12, color: '#bbb', marginBottom: 6 }}>
          Server URL
        </label>
        <input
          type="text"
          data-testid="remote-config-url"
          value={url}
          onChange={(e) => {
            setUrl(e.target.value)
            setProbe({ kind: 'idle' })
          }}
          placeholder="http://box.lan:7800 or ws://box.lan:7800/trpc"
          style={{
            width: '100%',
            padding: '8px 10px',
            fontSize: 13,
            fontFamily: 'monospace',
            background: '#0a0a0a',
            color: '#e8e8e8',
            border: '1px solid #333',
            borderRadius: 6,
            outline: 'none'
          }}
          autoFocus
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <button
            data-testid="remote-config-validate"
            onClick={() => {
              void runProbe()
            }}
            disabled={probe.kind === 'probing' || !url.trim()}
            style={btnStyle(probe.kind === 'probing' || !url.trim())}
          >
            {probe.kind === 'probing' ? 'Checking…' : 'Validate'}
          </button>
          <span style={{ fontSize: 12 }} data-testid="remote-config-probe-result">
            {probe.kind === 'ok' && (
              <span style={{ color: '#7dd87d' }}>✓ reachable — {probe.normalizedUrl}</span>
            )}
            {probe.kind === 'fail' && <span style={{ color: '#e57373' }}>✗ {probe.reason}</span>}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 24, justifyContent: 'flex-end' }}>
          <button
            data-testid="remote-config-switch-local"
            onClick={() => {
              void saveAndRelaunch('local')
            }}
            disabled={saving}
            style={{ ...btnStyle(saving), background: '#2a2a2a' }}
          >
            Switch to local
          </button>
          <button
            data-testid="remote-config-save"
            onClick={() => {
              void saveAndRelaunch('remote')
            }}
            disabled={saving || !url.trim()}
            style={{ ...btnStyle(saving || !url.trim()), background: '#3a6ea5', color: '#fff' }}
          >
            {saving ? 'Restarting…' : 'Save & relaunch'}
          </button>
        </div>
      </div>
    </div>
  )
}

function btnStyle(disabled: boolean): React.CSSProperties {
  return {
    padding: '8px 14px',
    fontSize: 13,
    borderRadius: 6,
    border: '1px solid #333',
    background: '#1f1f1f',
    color: '#e8e8e8',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1
  }
}
