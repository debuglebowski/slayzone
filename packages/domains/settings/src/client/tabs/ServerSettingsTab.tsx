import { useState, useEffect } from 'react'
import { electronBootstrap } from '@slayzone/transport/client'
import { Button, Input, Label, toast } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

type Mode = 'local' | 'remote'
type ProbeState =
  | { kind: 'idle' }
  | { kind: 'probing' }
  | { kind: 'ok'; normalizedUrl: string }
  | { kind: 'fail'; reason: string }

/**
 * Server-mode toggle (slice 7). Deliberately NOT backed by the settings DB:
 * in remote mode the DB lives on the remote server, so the mode must come from
 * the local pre-boot config file — read via `getServerUrl` and written via
 * `setBootSettings` (both bootstrap IPCs). The /health probe runs in the main
 * process (`probeServerHealth`) because the renderer CSP only allows ws(s)
 * connects and /health sets no CORS headers.
 */
export function ServerSettingsTab() {
  const [mode, setMode] = useState<Mode>('local')
  const [url, setUrl] = useState('')
  const [savedMode, setSavedMode] = useState<Mode>('local')
  const [savedUrl, setSavedUrl] = useState('')
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)
  const [restarting, setRestarting] = useState(false)

  useEffect(() => {
    void electronBootstrap.getServerUrl().then((server) => {
      setMode(server.mode)
      setSavedMode(server.mode)
      // Local mode reports the embedded port URL — only a configured remote
      // URL belongs in the input.
      if (server.mode === 'remote') {
        setUrl(server.url)
        setSavedUrl(server.url)
      }
    })
  }, [])

  const dirty = mode !== savedMode || (mode === 'remote' && url.trim() !== savedUrl.trim())

  const validateUrl = async (): Promise<void> => {
    setProbe({ kind: 'probing' })
    const result = await electronBootstrap.probeServerHealth(url)
    if (result.ok && result.normalizedUrl) {
      setProbe({ kind: 'ok', normalizedUrl: result.normalizedUrl })
    } else {
      setProbe({ kind: 'fail', reason: result.error ?? 'Unreachable' })
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      await electronBootstrap.setBootSettings(
        mode === 'remote' ? { server_mode: mode, remote_server_url: url } : { server_mode: mode }
      )
      // Mode change always requires a relaunch — embedded-server start/skip
      // is decided at boot time in main. The button label is the consent.
      await electronBootstrap.relaunch()
      // Under Playwright relaunch is a no-op — reflect the saved state.
      setSavedMode(mode)
      setSavedUrl(url.trim())
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Failed to save: ${msg}`)
    } finally {
      setSaving(false)
    }
  }

  // Cycle the embedded side-car without relaunching the app. The IPC resolves
  // only once the new child answers /health (or reports why it couldn't).
  const restartServer = async (): Promise<void> => {
    setRestarting(true)
    try {
      const result = await electronBootstrap.restartSidecar()
      if (result.ok) {
        toast.success('Server restarted')
      } else {
        toast.error(`Restart failed: ${result.error ?? 'unknown error'}`)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      toast.error(`Restart failed: ${msg}`)
    } finally {
      setRestarting(false)
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
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="radio"
              name="server_mode"
              value="local"
              checked={mode === 'local'}
              onChange={() => setMode('local')}
              className="mt-1"
              data-testid="server-mode-local"
            />
            <div>
              <div className="text-sm font-medium">Local</div>
              <div className="text-muted-foreground text-xs">
                Backend runs in this app. Default.
              </div>
            </div>
          </label>
          <label className="flex cursor-pointer items-start gap-3">
            <input
              type="radio"
              name="server_mode"
              value="remote"
              checked={mode === 'remote'}
              onChange={() => setMode('remote')}
              className="mt-1"
              data-testid="server-mode-remote"
            />
            <div>
              <div className="text-sm font-medium">Remote</div>
              <div className="text-muted-foreground text-xs">
                Connect to a self-hosted <code>@slayzone/server</code>. Tasks, agents and
                integrations run on that machine; this app becomes a client.
              </div>
            </div>
          </label>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Server URL</Label>
        <div className="flex items-center gap-2">
          <Input
            value={url}
            onChange={(e) => {
              setUrl(e.target.value)
              setProbe({ kind: 'idle' })
            }}
            placeholder="http://box.lan:7800 or ws://box.lan:7800/trpc"
            disabled={mode !== 'remote'}
            className="max-w-lg font-mono"
            data-testid="server-remote-url"
          />
          <Button
            variant="outline"
            disabled={mode !== 'remote' || probe.kind === 'probing' || !url.trim()}
            onClick={() => {
              void validateUrl()
            }}
            data-testid="server-probe-button"
          >
            {probe.kind === 'probing' ? 'Checking…' : 'Validate'}
          </Button>
        </div>
        <div className="h-4 text-xs" data-testid="server-probe-result">
          {probe.kind === 'ok' && (
            <span className="text-green-500">✓ reachable — {probe.normalizedUrl}</span>
          )}
          {probe.kind === 'fail' && <span className="text-destructive">✗ {probe.reason}</span>}
        </div>
      </div>

      <div className="flex items-center gap-2 pt-2">
        <Button
          onClick={() => {
            void save()
          }}
          disabled={!dirty || saving || (mode === 'remote' && !url.trim())}
          data-testid="server-save-relaunch"
        >
          {saving ? 'Saving…' : 'Save & relaunch'}
        </Button>
        {dirty && <span className="text-muted-foreground text-xs">Unsaved changes</span>}
      </div>

      <div className="border-border space-y-3 border-t pt-6">
        <Label className="text-base font-semibold">Embedded server</Label>
        <p className="text-muted-foreground max-w-lg text-xs">
          Restart the local backend process without relaunching the app. Running agents and
          terminal sessions are stopped; the app reconnects automatically.
        </p>
        <Button
          variant="outline"
          disabled={savedMode !== 'local' || restarting}
          onClick={() => {
            void restartServer()
          }}
          data-testid="server-restart-button"
        >
          {restarting ? 'Restarting…' : 'Restart server'}
        </Button>
        {savedMode !== 'local' && (
          <p className="text-muted-foreground text-xs">Available in Local mode only.</p>
        )}
      </div>
    </div>
  )
}
