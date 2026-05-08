import { useState, useEffect } from 'react'
import { Button, Input, Label, toast } from '@slayzone/ui'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { SettingsTabIntro } from './SettingsTabIntro'

type Mode = 'local' | 'remote'
type ProbeState = { kind: 'idle' } | { kind: 'probing' } | { kind: 'ok' } | { kind: 'fail'; reason: string }

function isPlausibleWsUrl(s: string): boolean {
  return /^wss?:\/\/[^/\s]+(:\d+)?\/.+/.test(s.trim())
}

function toHealthUrl(wsUrl: string): string | null {
  const trimmed = wsUrl.trim()
  if (!isPlausibleWsUrl(trimmed)) return null
  const httpUrl = trimmed.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
  return httpUrl.replace(/\/trpc(?:\?.*)?$/, '/health')
}

export function ServerSettingsTab() {
  const [mode, setMode] = useState<Mode>('local')
  const [url, setUrl] = useState('')
  const [savedMode, setSavedMode] = useState<Mode>('local')
  const [savedUrl, setSavedUrl] = useState('')
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    void Promise.all([
      getTrpcVanillaClient().settings.get.query({ key: 'server_mode' }),
      getTrpcVanillaClient().settings.get.query({ key: 'remote_server_url' }),
    ]).then(([m, u]) => {
      const initialMode: Mode = m === 'remote' ? 'remote' : 'local'
      const initialUrl = u ?? ''
      setMode(initialMode); setSavedMode(initialMode)
      setUrl(initialUrl); setSavedUrl(initialUrl)
    })
  }, [])

  const dirty = mode !== savedMode || (mode === 'remote' && url.trim() !== savedUrl.trim())

  const validateUrl = async (): Promise<void> => {
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

  const save = async (): Promise<void> => {
    if (mode === 'remote' && !isPlausibleWsUrl(url)) {
      toast.error('Server URL must look like ws://host:port/trpc')
      return
    }
    setSaving(true)
    try {
      await getTrpcVanillaClient().settings.set.mutate({ key: 'server_mode', value: mode })
      if (mode === 'remote') {
        await getTrpcVanillaClient().settings.set.mutate({ key: 'remote_server_url', value: url.trim() })
      }
      // Mode change always requires a relaunch — embedded-server start/skip
      // is decided at boot time in main.
      const confirmed = window.confirm('Reload required to apply server-mode change. Relaunch SlayZone now?')
      if (confirmed) {
        await window.api.app.relaunch()
      } else {
        toast.success('Saved. Relaunch later to apply.')
        setSavedMode(mode); setSavedUrl(url.trim())
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to save: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Server"
        description="Run SlayZone with the backend embedded in this app (Local) or pointed at a remote @slayzone/server instance you host yourself (Remote)."
      />

      <div className="space-y-3">
        <Label className="text-base font-semibold">Mode</Label>
        <div className="flex flex-col gap-2">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="server_mode"
              value="local"
              checked={mode === 'local'}
              onChange={() => setMode('local')}
              className="mt-1"
            />
            <div>
              <div className="text-sm font-medium">Local</div>
              <div className="text-muted-foreground text-xs">Backend runs in this Electron process. Default.</div>
            </div>
          </label>
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="radio"
              name="server_mode"
              value="remote"
              checked={mode === 'remote'}
              onChange={() => setMode('remote')}
              className="mt-1"
            />
            <div>
              <div className="text-sm font-medium">Remote</div>
              <div className="text-muted-foreground text-xs">Connect to a self-hosted <code>@slayzone/server</code>. Tasks/PTYs/agents run on that box.</div>
            </div>
          </label>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Server URL</Label>
        <div className="flex items-center gap-2">
          <Input
            value={url}
            onChange={(e) => { setUrl(e.target.value); setProbe({ kind: 'idle' }) }}
            placeholder="ws://box.lan:7800/trpc"
            disabled={mode !== 'remote'}
            className="font-mono max-w-lg"
          />
          <Button
            variant="outline"
            disabled={mode !== 'remote' || probe.kind === 'probing' || !url.trim()}
            onClick={() => { void validateUrl() }}
          >
            {probe.kind === 'probing' ? 'Checking…' : 'Validate'}
          </Button>
        </div>
        <div className="text-xs h-4">
          {probe.kind === 'ok' && <span className="text-green-500">✓ reachable</span>}
          {probe.kind === 'fail' && <span className="text-destructive">✗ {probe.reason}</span>}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button
          onClick={() => { void save() }}
          disabled={!dirty || saving}
        >
          {saving ? 'Saving…' : 'Save & relaunch'}
        </Button>
        {dirty && <span className="text-xs text-muted-foreground">Unsaved changes</span>}
      </div>
    </div>
  )
}
