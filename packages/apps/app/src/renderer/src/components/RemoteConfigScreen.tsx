import { useState } from 'react'

interface Props {
  // url may be empty (never configured) or stale (server unreachable). The
  // parent renders this screen pre-mount of TrpcProvider, so we have no
  // tRPC client and must operate over preload IPCs only.
  initialUrl: string
}

type ProbeState = { kind: 'idle' } | { kind: 'probing' } | { kind: 'ok' } | { kind: 'fail'; reason: string }

function isPlausibleWsUrl(s: string): boolean {
  return /^wss?:\/\/[^/\s]+(:\d+)?\/.+/.test(s.trim())
}

function toHealthUrl(wsUrl: string): string | null {
  const trimmed = wsUrl.trim()
  if (!isPlausibleWsUrl(trimmed)) return null
  const httpUrl = trimmed.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
  // Drop /trpc[?...] suffix; replace with /health
  return httpUrl.replace(/\/trpc(?:\?.*)?$/, '/health').replace(/\/?$/, (m) => m || '/health')
}

export function RemoteConfigScreen({ initialUrl }: Props) {
  const [url, setUrl] = useState(initialUrl)
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)

  const probe_ = async (): Promise<void> => {
    const target = toHealthUrl(url)
    if (!target) {
      setProbe({ kind: 'fail', reason: 'URL must be ws://host:port/trpc or wss://...' })
      return
    }
    setProbe({ kind: 'probing' })
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5000)
      const res = await fetch(target, { signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) { setProbe({ kind: 'fail', reason: `HTTP ${res.status}` }); return }
      const body = await res.json().catch(() => null) as { ok?: boolean } | null
      setProbe(body?.ok ? { kind: 'ok' } : { kind: 'fail', reason: 'Health response missing ok:true' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setProbe({ kind: 'fail', reason: msg })
    }
  }

  const saveAndRelaunch = async (mode: 'local' | 'remote', persistUrl: string): Promise<void> => {
    setSaving(true)
    // Pre-mount we have no tRPC. Persist via a temporary HTTP fetch to the
    // local main process? No HTTP server in remote mode. Use a one-shot
    // tRPC connection... still need a URL. The clean way: round-trip via
    // preload IPCs. Reuse the existing flow by writing via the test channel
    // doesn't work in prod. So: spawn a short-lived tRPC-over-WS round-trip
    // to the LOCAL embedded server only when mode==='local'. For mode==='remote'
    // we need a separate persistence path.
    //
    // Simpler: expose a small `app.setBootSettings` IPC for these two keys.
    // For now, call it via window.api.app (added in preload).
    await window.api.app.setBootSettings({ server_mode: mode, remote_server_url: persistUrl })
    await window.api.app.relaunch()
    // app.relaunch() exits the process; nothing to do after.
  }

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#0a0a0a', color: '#e8e8e8', fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
    }}>
      <div style={{ width: 480, padding: 32, background: '#141414', borderRadius: 12, border: '1px solid #2a2a2a' }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, marginBottom: 4 }}>Configure remote server</h1>
        <p style={{ fontSize: 13, color: '#999', marginBottom: 20, lineHeight: 1.5 }}>
          SlayZone is set to remote mode but no reachable server URL is configured. Enter a tRPC WebSocket URL below, or switch back to local mode.
        </p>

        <label style={{ display: 'block', fontSize: 12, color: '#bbb', marginBottom: 6 }}>Server URL</label>
        <input
          type="text"
          value={url}
          onChange={(e) => { setUrl(e.target.value); setProbe({ kind: 'idle' }) }}
          placeholder="ws://box.lan:7800/trpc"
          style={{
            width: '100%', padding: '8px 10px', fontSize: 13, fontFamily: 'monospace',
            background: '#0a0a0a', color: '#e8e8e8', border: '1px solid #333', borderRadius: 6, outline: 'none',
          }}
          autoFocus
        />

        <div style={{ display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' }}>
          <button
            onClick={() => { void probe_() }}
            disabled={probe.kind === 'probing' || !url.trim()}
            style={btnStyle(probe.kind === 'probing' || !url.trim())}
          >
            {probe.kind === 'probing' ? 'Checking…' : 'Validate'}
          </button>
          <span style={{ fontSize: 12 }}>
            {probe.kind === 'ok' && <span style={{ color: '#7dd87d' }}>✓ reachable</span>}
            {probe.kind === 'fail' && <span style={{ color: '#e57373' }}>✗ {probe.reason}</span>}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 24, justifyContent: 'flex-end' }}>
          <button
            onClick={() => { void saveAndRelaunch('local', url.trim()) }}
            disabled={saving}
            style={{ ...btnStyle(saving), background: '#2a2a2a' }}
          >
            Switch to local
          </button>
          <button
            onClick={() => { void saveAndRelaunch('remote', url.trim()) }}
            disabled={saving || !isPlausibleWsUrl(url)}
            style={{ ...btnStyle(saving || !isPlausibleWsUrl(url)), background: '#3a6ea5', color: '#fff' }}
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
    padding: '8px 14px', fontSize: 13, borderRadius: 6, border: '1px solid #333',
    background: '#1f1f1f', color: '#e8e8e8',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
  }
}
