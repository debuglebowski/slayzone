import { useState, useEffect, useRef, useCallback } from 'react'
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  toast,
} from '@slayzone/ui'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import type { MigrateReceipt, ProgressEvent } from '@slayzone/migrate/shared'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
}

type Step = 'intro' | 'url' | 'preview' | 'progress' | 'done' | 'error'
type ProbeState = { kind: 'idle' } | { kind: 'probing' } | { kind: 'ok'; remoteVersion: string } | { kind: 'fail'; reason: string }

function isPlausibleWsUrl(s: string): boolean {
  return /^wss?:\/\/[^/\s]+(:\d+)?\/.+/.test(s.trim())
}

function toHealthUrl(wsUrl: string): string | null {
  const trimmed = wsUrl.trim()
  if (!isPlausibleWsUrl(trimmed)) return null
  const httpUrl = trimmed.replace(/^ws:/i, 'http:').replace(/^wss:/i, 'https:')
  return httpUrl.replace(/\/trpc(?:\?.*)?$/, '/health')
}

interface PreviewSummary {
  taskCount: number
  projectCount: number
  artifactFileCount: number
  approxArchiveBytes: number
  worktreesToNull: number
  unresolvableProjectPaths: number
}

export function MigrateToRemoteWizard({ open, onOpenChange }: Props) {
  const [step, setStep] = useState<Step>('intro')
  const [url, setUrl] = useState('')
  const [probe, setProbe] = useState<ProbeState>({ kind: 'idle' })
  const [preview, setPreview] = useState<PreviewSummary | null>(null)
  const [progressEvents, setProgressEvents] = useState<ProgressEvent[]>([])
  const [receipt, setReceipt] = useState<MigrateReceipt | null>(null)
  const [errorMsg, setErrorMsg] = useState<string>('')
  const [running, setRunning] = useState(false)
  const subRef = useRef<{ unsubscribe: () => void } | null>(null)
  const inFlightRef = useRef(false)

  const reset = useCallback((): void => {
    setStep('intro')
    setProbe({ kind: 'idle' })
    setPreview(null)
    setProgressEvents([])
    setReceipt(null)
    setErrorMsg('')
    setRunning(false)
  }, [])

  useEffect(() => {
    if (!open) {
      subRef.current?.unsubscribe()
      subRef.current = null
      reset()
    }
  }, [open, reset])

  const validateUrl = async (): Promise<void> => {
    const target = toHealthUrl(url)
    if (!target) {
      setProbe({ kind: 'fail', reason: 'URL must be ws://host:port/trpc or wss://...' })
      return
    }
    setProbe({ kind: 'probing' })
    try {
      // 1. HTTP /health (fast sanity).
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 5000)
      const res = await fetch(target, { signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) {
        setProbe({ kind: 'fail', reason: `HTTP ${res.status}` })
        return
      }
      // 2. We need to call the REMOTE tRPC migrate.health. We do this server-side
      //    via localExport's pre-flight, but for a fast probe at this step the local
      //    tRPC `migrate.health` only reflects this instance. Skip remote-version probe
      //    here; uploadFinalize will hard-stop on schema mismatch with a clear error.
      const body = (await res.json().catch(() => null)) as { ok?: boolean; version?: string } | null
      if (body?.ok) {
        setProbe({ kind: 'ok', remoteVersion: body.version ?? 'unknown' })
      } else {
        setProbe({ kind: 'fail', reason: 'Health response missing ok:true' })
      }
    } catch (err) {
      setProbe({ kind: 'fail', reason: err instanceof Error ? err.message : String(err) })
    }
  }

  const computePreview = async (): Promise<void> => {
    setRunning(true)
    try {
      // Local-side counts via existing local tRPC.
      const trpc = getTrpcVanillaClient()
      const [tasks, projects] = await Promise.all([
        trpc.task.getAll.query().catch(() => [] as unknown[]),
        trpc.projects.list.query().catch(() => [] as Array<{ path?: string | null }>),
      ])
      // Crude approximation; full numbers come from the actual archive build.
      const taskList = Array.isArray(tasks) ? tasks : []
      const projectList = Array.isArray(projects) ? projects : []
      const worktreesToNull = taskList.filter(
        (t: unknown) => typeof (t as { worktree_path?: string }).worktree_path === 'string'
          && (t as { worktree_path?: string }).worktree_path,
      ).length
      const unresolvableProjectPaths = projectList.filter(
        (p) => typeof p?.path === 'string' && p.path && !p.path.startsWith('/'),
      ).length
      setPreview({
        taskCount: taskList.length,
        projectCount: projectList.length,
        artifactFileCount: 0,
        approxArchiveBytes: 0,
        worktreesToNull,
        unresolvableProjectPaths,
      })
    } catch (err) {
      toast.error(`Preview failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setRunning(false)
    }
  }

  const startSubscription = (): void => {
    subRef.current?.unsubscribe()
    const trpc = getTrpcVanillaClient()
    const sub = trpc.migrate.progress.subscribe(undefined, {
      onData: (ev) => {
        setProgressEvents((prev) => [...prev, ev])
      },
      onError: (err) => {
        console.error('migrate.progress subscription error:', err)
      },
    })
    subRef.current = sub
  }

  const runMigration = async (dryRun: boolean): Promise<void> => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setRunning(true)
    setProgressEvents([])
    setReceipt(null)
    setErrorMsg('')
    setStep('progress')
    startSubscription()
    try {
      const trpc = getTrpcVanillaClient()
      // Pre-migration backup safety net (skip on dry-run — pointless).
      if (!dryRun) {
        try {
          await trpc.app.backup.create.mutate({ name: 'pre-migration' })
        } catch (err) {
          console.warn('Pre-migration backup failed (continuing):', err)
        }
      }
      const result = await trpc.migrate.localExport.mutate({
        remoteUrl: url.trim(),
        dryRun,
      })
      setReceipt(result)
      setStep('done')
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err))
      setStep('error')
    } finally {
      inFlightRef.current = false
      setRunning(false)
    }
  }

  const switchToRemoteAndRelaunch = async (): Promise<void> => {
    const trpc = getTrpcVanillaClient()
    try {
      await trpc.settings.set.mutate({ key: 'server_mode', value: 'remote' })
      await trpc.settings.set.mutate({ key: 'remote_server_url', value: url.trim() })
      const wapi = (window as unknown as { api?: { app?: { relaunch?: () => Promise<void> } } }).api
      if (wapi?.app?.relaunch) {
        await wapi.app.relaunch()
      } else {
        toast.success('Mode saved. Relaunch SlayZone manually to apply.')
        onOpenChange(false)
      }
    } catch (err) {
      toast.error(`Failed to switch mode: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  const overallPercent = ((): number => {
    const last = progressEvents[progressEvents.length - 1]
    if (!last) return 0
    // Map phases to a global 0..1 ribbon.
    const order: Record<ProgressEvent['phase'], number> = {
      preflight: 0,
      uploading: 0.2,
      'verifying-archive': 0.7,
      unpacking: 0.75,
      'verifying-manifest': 0.85,
      committing: 0.9,
      'cleaning-up': 0.97,
      done: 1,
      error: 0,
    }
    const base = order[last.phase] ?? 0
    const span = last.phase === 'uploading' ? 0.5 : 0.05
    return Math.min(1, base + span * (last.percent ?? 0))
  })()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Migrate to remote server</DialogTitle>
          <DialogDescription>
            Move all local data to a self-hosted <code>@slayzone/server</code>. One-way. Reverse migration is not supported.
          </DialogDescription>
        </DialogHeader>

        {step === 'intro' && (
          <div className="space-y-3 text-sm">
            <p><strong>What migrates:</strong> tasks, projects, artifacts, project icons, integration secrets.</p>
            <p>
              <strong>What does NOT migrate:</strong> existing worktree directories (paths are nulled and re-created on server demand),
              backups (server creates its own), diagnostics/telemetry.
            </p>
            <p>A pre-migration backup is created automatically as a safety net before any state changes.</p>
            <p className="text-muted-foreground text-xs">
              Note: the destination server must be empty (no projects/tasks). Schema versions must match.
            </p>
          </div>
        )}

        {step === 'url' && (
          <div className="space-y-3">
            <Label className="text-base font-semibold">Server URL</Label>
            <div className="flex items-center gap-2">
              <Input
                value={url}
                onChange={(e) => { setUrl(e.target.value); setProbe({ kind: 'idle' }) }}
                placeholder="ws://box.lan:7800/trpc"
                className="font-mono"
              />
              <Button
                variant="outline"
                disabled={probe.kind === 'probing' || !url.trim()}
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
        )}

        {step === 'preview' && (
          <div className="space-y-3 text-sm">
            {!preview ? (
              <p className="text-muted-foreground">{running ? 'Loading preview…' : 'No preview yet.'}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1">
                  <div>Tasks</div><div className="font-mono text-right">{preview.taskCount}</div>
                  <div>Projects</div><div className="font-mono text-right">{preview.projectCount}</div>
                  <div>Worktrees to null-out</div><div className="font-mono text-right">{preview.worktreesToNull}</div>
                  <div>Projects with possibly-unresolvable paths on server</div>
                  <div className="font-mono text-right">{preview.unresolvableProjectPaths}</div>
                </div>
                {preview.unresolvableProjectPaths > 0 && (
                  <p className="text-amber-500 text-xs">
                    Warning: {preview.unresolvableProjectPaths} project(s) reference paths that may not resolve on the server.
                    You can fix project paths post-migration via project settings.
                  </p>
                )}
              </>
            )}
          </div>
        )}

        {step === 'progress' && (
          <div className="space-y-3 text-sm">
            <div className="h-2 w-full bg-muted rounded overflow-hidden">
              <div
                className="h-full bg-primary transition-all"
                style={{ width: `${(overallPercent * 100).toFixed(1)}%` }}
              />
            </div>
            <div className="font-mono text-xs space-y-0.5 max-h-48 overflow-auto">
              {progressEvents.slice(-12).map((ev, i) => (
                <div key={i}>
                  <span className="text-muted-foreground">[{ev.phase}]</span> {ev.message}
                </div>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              Do not close SlayZone or change tasks/projects until this completes.
            </p>
          </div>
        )}

        {step === 'done' && receipt && (
          <div className="space-y-3 text-sm">
            <div className={receipt.ok ? 'text-green-500' : 'text-destructive'}>
              {receipt.dryRun ? 'Dry-run' : 'Migration'} {receipt.ok ? '✓ succeeded' : '✗ failed'}
              {' '}({(receipt.durationMs / 1000).toFixed(1)}s)
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1">
              <div>Files</div>
              <div className="font-mono text-right">
                {receipt.files.present}/{receipt.files.expected} present
                {receipt.files.mismatched.length > 0 && `, ${receipt.files.mismatched.length} mismatched`}
              </div>
              {Object.entries(receipt.tables).map(([t, c]) => (
                <div key={t} className="contents">
                  <div className="text-muted-foreground">{t}</div>
                  <div className={`font-mono text-right ${c.expected !== c.actual ? 'text-destructive' : ''}`}>
                    {c.actual}/{c.expected}
                  </div>
                </div>
              ))}
              <div>Worktrees nulled</div>
              <div className="font-mono text-right">{receipt.worktreeRowsRewritten}</div>
            </div>
            {receipt.errors.length > 0 && (
              <ul className="text-destructive text-xs list-disc pl-5">
                {receipt.errors.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            )}
          </div>
        )}

        {step === 'error' && (
          <div className="space-y-3 text-sm">
            <p className="text-destructive">Migration failed: {errorMsg}</p>
            <p className="text-xs text-muted-foreground">
              Your local data is unchanged. You can retry from the start.
            </p>
          </div>
        )}

        <DialogFooter>
          {step === 'intro' && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button onClick={() => setStep('url')}>Next</Button>
            </>
          )}
          {step === 'url' && (
            <>
              <Button variant="ghost" onClick={() => setStep('intro')}>Back</Button>
              <Button
                disabled={probe.kind !== 'ok'}
                onClick={() => { setStep('preview'); void computePreview() }}
              >
                Next
              </Button>
            </>
          )}
          {step === 'preview' && (
            <>
              <Button variant="ghost" onClick={() => setStep('url')} disabled={running}>Back</Button>
              <Button
                variant="outline"
                disabled={!preview || running}
                onClick={() => { void runMigration(true) }}
              >
                Dry-run
              </Button>
              <Button
                disabled={!preview || running}
                onClick={() => { void runMigration(false) }}
              >
                Migrate
              </Button>
            </>
          )}
          {step === 'progress' && (
            <Button variant="ghost" disabled>Migrating…</Button>
          )}
          {step === 'done' && receipt && (
            <>
              {receipt.dryRun ? (
                <>
                  <Button variant="ghost" onClick={() => setStep('preview')}>Back</Button>
                  <Button onClick={() => onOpenChange(false)}>Done</Button>
                </>
              ) : (
                <>
                  <Button variant="ghost" onClick={() => onOpenChange(false)}>Stay local</Button>
                  <Button onClick={() => { void switchToRemoteAndRelaunch() }}>
                    Switch to remote & relaunch
                  </Button>
                </>
              )}
            </>
          )}
          {step === 'error' && (
            <>
              <Button variant="ghost" onClick={() => onOpenChange(false)}>Close</Button>
              <Button onClick={() => { reset(); setStep('intro') }}>Retry</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
