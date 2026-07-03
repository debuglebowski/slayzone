import { useState, useEffect } from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { useTRPC, useTRPCClient } from '@slayzone/transport/client'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import type { DiagnosticsConfig } from '@slayzone/types'
import { SettingsTabIntro } from './SettingsTabIntro'

export function DiagnosticsSettingsTab() {
  const trpc = useTRPC()
  const trpcClient = useTRPCClient()
  const [diagnosticsConfig, setDiagnosticsConfig] = useState<DiagnosticsConfig | null>(null)
  const [retentionDaysInput, setRetentionDaysInput] = useState('14')
  const [exportRange, setExportRange] = useState<'15m' | '1h' | '24h' | '7d'>('1h')
  const [exportingDiagnostics, setExportingDiagnostics] = useState(false)
  const [diagnosticsMessage, setDiagnosticsMessage] = useState('')

  const diagnosticsConfigQuery = useQuery(trpc.diagnostics.getConfig.queryOptions())
  const setDiagnosticsConfigMutation = useMutation(trpc.diagnostics.setConfig.mutationOptions())

  useEffect(() => {
    const config = diagnosticsConfigQuery.data
    if (config) {
      setDiagnosticsConfig(config)
      setRetentionDaysInput(String(config.retentionDays))
    }
  }, [diagnosticsConfigQuery.data])

  // Poll the dark-launch side-car status while this tab is mounted. 5s feels
  // live; the interval pauses while the window is unfocused (react-query
  // default), matching the old useVisibleInterval behavior.
  const sidecarStatusQuery = useQuery(
    trpc.app.meta.getSidecarStatus.queryOptions(undefined, { refetchInterval: 5000 })
  )
  const sidecarStatus = sidecarStatusQuery.data ?? null
  const revealSidecarLogMutation = useMutation(trpc.app.meta.revealSidecarLog.mutationOptions())

  const updateDiagnosticsConfig = async (partial: Partial<DiagnosticsConfig>) => {
    const next = await setDiagnosticsConfigMutation.mutateAsync(partial)
    setDiagnosticsConfig(next)
    setRetentionDaysInput(String(next.retentionDays))
    return next
  }

  const handleExportDiagnostics = async () => {
    setExportingDiagnostics(true)
    setDiagnosticsMessage('')
    try {
      const now = Date.now()
      const fromByRange: Record<typeof exportRange, number> = {
        '15m': now - 15 * 60 * 1000,
        '1h': now - 60 * 60 * 1000,
        '24h': now - 24 * 60 * 60 * 1000,
        '7d': now - 7 * 24 * 60 * 60 * 1000
      }
      const appVersion = await trpcClient.app.meta.getVersion.query()
      const bundle = await trpcClient.diagnostics.exportBundle.query({
        fromTsMs: fromByRange[exportRange],
        toTsMs: now,
        appVersion
      })
      if (!bundle) {
        setDiagnosticsMessage('Export failed')
        return
      }
      // Browser-native download (replaces the IPC save-dialog path).
      const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = `slayzone-diagnostics-${exportRange}-${new Date(now)
        .toISOString()
        .replace(/[:.]/g, '-')}.json`
      anchor.click()
      URL.revokeObjectURL(url)
      setDiagnosticsMessage(`Exported ${bundle.events.length} events`)
    } catch (err) {
      setDiagnosticsMessage(err instanceof Error ? err.message : 'Export failed')
    } finally {
      setExportingDiagnostics(false)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Diagnostics"
        description="Control debug logging and export diagnostic bundles for troubleshooting."
      />
      <Card>
        <CardHeader>
          <CardTitle>Logging</CardTitle>
          <CardDescription>Control debug logging captured for diagnostics.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <span className="text-sm">Diagnostics enabled</span>
            <input
              type="checkbox"
              checked={diagnosticsConfig?.enabled ?? true}
              onChange={(e) => {
                updateDiagnosticsConfig({ enabled: e.target.checked })
              }}
            />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <span className="text-sm">Verbose logging</span>
            <input
              type="checkbox"
              checked={diagnosticsConfig?.verbose ?? false}
              onChange={(e) => {
                updateDiagnosticsConfig({ verbose: e.target.checked })
              }}
            />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <span className="text-sm">Include PTY output content</span>
            <input
              type="checkbox"
              checked={diagnosticsConfig?.includePtyOutput ?? false}
              onChange={(e) => {
                updateDiagnosticsConfig({ includePtyOutput: e.target.checked })
              }}
            />
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <span className="text-sm">Retention days</span>
            <Input
              className="w-full max-w-24"
              inputMode="numeric"
              value={retentionDaysInput}
              onChange={(e) => setRetentionDaysInput(e.target.value)}
              onBlur={() => {
                const parsed = Number.parseInt(retentionDaysInput, 10)
                if (Number.isFinite(parsed) && parsed > 0) {
                  updateDiagnosticsConfig({ retentionDays: parsed })
                } else if (diagnosticsConfig) {
                  setRetentionDaysInput(String(diagnosticsConfig.retentionDays))
                }
              }}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Export</CardTitle>
          <CardDescription>Export a diagnostic bundle for troubleshooting.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <span className="text-sm">Time range</span>
            <Select
              value={exportRange}
              onValueChange={(v) => setExportRange(v as typeof exportRange)}
            >
              <SelectTrigger className="w-full max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="15m">Last 15 minutes</SelectItem>
                <SelectItem value="1h">Last 1 hour</SelectItem>
                <SelectItem value="24h">Last 24 hours</SelectItem>
                <SelectItem value="7d">Last 7 days</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Button onClick={handleExportDiagnostics} disabled={exportingDiagnostics}>
            {exportingDiagnostics ? 'Exporting…' : 'Export Diagnostics'}
          </Button>
          {diagnosticsMessage ? (
            <p className="text-xs text-muted-foreground">{diagnosticsMessage}</p>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Background server</CardTitle>
          <CardDescription>
            A supervised local server runs alongside the app. It is not yet
            serving the UI — this is informational only.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <span className="text-sm">Status</span>
            <span className="text-sm text-muted-foreground flex items-center gap-1.5">
              {(() => {
                const health = sidecarStatus?.health ?? 'starting'
                const dot =
                  health === 'ready'
                    ? 'text-green-500'
                    : health === 'failed'
                      ? 'text-destructive'
                      : health === 'restarting'
                        ? 'text-yellow-500'
                        : 'text-muted-foreground'
                const label =
                  health === 'ready'
                    ? `Running · port ${sidecarStatus?.port ?? '—'}`
                    : health === 'restarting'
                      ? 'Restarting…'
                      : health === 'failed'
                        ? 'Failed'
                        : 'Starting…'
                return (
                  <>
                    <span className={dot}>●</span>
                    {label}
                  </>
                )
              })()}
            </span>
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <span className="text-sm">Uptime</span>
            <span className="text-sm text-muted-foreground">
              {sidecarStatus?.uptimeMs != null ? formatUptime(sidecarStatus.uptimeMs) : '—'}
            </span>
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <span className="text-sm">Restarts</span>
            <span className="text-sm text-muted-foreground">{sidecarStatus?.restarts ?? 0}</span>
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
            <span className="text-sm">Process ID</span>
            <span className="text-sm text-muted-foreground">{sidecarStatus?.pid ?? '—'}</span>
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4">
            <span className="text-sm">Build</span>
            <span className="text-xs text-muted-foreground flex flex-col gap-1 break-all">
              <span>{sidecarStatus?.runningBuildId ?? '—'}</span>
              {sidecarStatus?.stale && (
                <span className="text-destructive">
                  ⚠ STALE — a newer build is on disk ({sidecarStatus.diskBuildId}). Restart the app
                  to load it.
                </span>
              )}
            </span>
          </div>
          <div className="grid grid-cols-[220px_minmax(0,1fr)] gap-4">
            <span className="text-sm">Database</span>
            <span className="text-xs text-muted-foreground break-all">
              {sidecarStatus?.dbPath ?? '—'}
            </span>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => revealSidecarLogMutation.mutate()}
          >
            Reveal log file
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}

function formatUptime(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  if (totalSec < 60) return `${totalSec}s`
  const totalMin = Math.floor(totalSec / 60)
  if (totalMin < 60) return `${totalMin}m`
  const hours = Math.floor(totalMin / 60)
  return `${hours}h ${totalMin % 60}m`
}
