import { useState, useEffect, useCallback } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { FolderOpen, Trash2, RotateCcw, Download, Loader2, Pencil, Check, X } from 'lucide-react'
import {
  Button,
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  Input,
  Label,
  Switch,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  toast
} from '@slayzone/ui'
import type { BackupInfo, BackupSettings } from '@slayzone/types'
import { track } from '@slayzone/telemetry/client'
import { SettingsTabIntro } from './SettingsTabIntro'

const INTERVAL_OPTIONS = [
  { value: '15', label: '15 minutes' },
  { value: '30', label: '30 minutes' },
  { value: '60', label: '1 hour' },
  { value: '240', label: '4 hours' },
  { value: '720', label: '12 hours' },
  { value: '1440', label: '24 hours' }
]

const MAX_BACKUPS_OPTIONS = [
  { value: '5', label: '5' },
  { value: '10', label: '10' },
  { value: '25', label: '25' },
  { value: '50', label: '50' },
  { value: '0', label: 'Unlimited' }
]

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString()
}

export function BackupSettingsTab() {
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [settings, setSettings] = useState<BackupSettings>({
    autoEnabled: false,
    intervalMinutes: 60,
    maxAutoBackups: 10,
    nextBackupNumber: 1
  })
  const [creating, setCreating] = useState(false)
  const [restoreTarget, setRestoreTarget] = useState<BackupInfo | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<BackupInfo | null>(null)
  const [createSafetyBackup, setCreateSafetyBackup] = useState(true)
  const [editingFilename, setEditingFilename] = useState<string | null>(null)
  const [editingName, setEditingName] = useState('')

  const loadData = useCallback(async () => {
    const [b, s] = await Promise.all([
      getTrpcVanillaClient().app.backup.list.query(),
      getTrpcVanillaClient().app.backup.getSettings.query()
    ])
    setBackups(b)
    setSettings(s)
  }, [])

  useEffect(() => { loadData() }, [loadData])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const backup = await getTrpcVanillaClient().app.backup.create.mutate()
      toast.success(`Backup created (${formatBytes(backup.sizeBytes)})`)
      loadData()
    } catch (err: any) {
      toast.error(`Backup failed: ${err.message}`)
    } finally {
      setCreating(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    try {
      await getTrpcVanillaClient().app.backup.delete.mutate({ filename: deleteTarget.filename })
      toast.success('Backup deleted')
      loadData()
    } catch (err: any) {
      toast.error(`Delete failed: ${err.message}`)
    }
    setDeleteTarget(null)
  }

  const handleRestore = async () => {
    if (!restoreTarget) return
    try {
      if (createSafetyBackup) {
        await getTrpcVanillaClient().app.backup.create.mutate()
      }
      await getTrpcVanillaClient().app.backup.restore.mutate({ filename: restoreTarget.filename })
    } catch (err: any) {
      toast.error(`Restore failed: ${err.message}`)
    }
    setRestoreTarget(null)
  }

  const updateSettings = async (partial: Partial<BackupSettings>) => {
    try {
      const updated = await getTrpcVanillaClient().app.backup.setSettings.mutate(partial)
      setSettings(updated)
    } catch (err: any) {
      toast.error(`Failed to save settings: ${err.message}`)
    }
  }

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Backup"
        description="Create and manage SQLite database backups. Restoring a backup will restart the app."
      />

      <div className="flex items-center gap-2">
        <Button variant="outline" onClick={handleCreate} disabled={creating}>
          {creating ? <Loader2 className="mr-2 size-4 animate-spin" /> : <Download className="mr-2 size-4" />}
          Create Backup
        </Button>
        <Button variant="ghost" onClick={() => getTrpcVanillaClient().app.backup.revealInFinder.mutate()}>
          <FolderOpen className="mr-2 size-4" />
          Open Folder
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Auto-Backup</CardTitle>
          <CardDescription>Automatically back up your database on a schedule.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-3">
            <Switch
              checked={settings.autoEnabled}
              onCheckedChange={(checked) => {
                track('auto_backup_toggled')
                updateSettings({ autoEnabled: checked })
              }}
            />
            <span className="text-sm">Enable automatic backups</span>
          </div>

          {settings.autoEnabled && (
            <div className="ml-[52px] space-y-3">
              <div className="flex items-center gap-3">
                <Label className="text-sm w-16">Every</Label>
                <Select
                  value={String(settings.intervalMinutes)}
                  onValueChange={(v) => updateSettings({ intervalMinutes: parseInt(v) })}
                >
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {INTERVAL_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="flex items-center gap-3">
                <Label className="text-sm w-16">Keep</Label>
                <Select
                  value={String(settings.maxAutoBackups)}
                  onValueChange={(v) => updateSettings({ maxAutoBackups: parseInt(v) })}
                >
                  <SelectTrigger className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {MAX_BACKUPS_OPTIONS.map((o) => (
                      <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <span className="text-muted-foreground text-sm">auto-backups</span>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Backups</CardTitle>
          <CardDescription>{backups.length === 0 ? 'No backups yet. Create one to get started.' : `${backups.length} backup${backups.length === 1 ? '' : 's'}`}</CardDescription>
        </CardHeader>
        {backups.length > 0 && (
          <CardContent className="space-y-1">
            {backups.map((backup) => (
              <div
                key={backup.filename}
                className="group/row flex items-center justify-between rounded-md border px-3 py-2"
              >
                <div className="flex items-center gap-3 min-w-0">
                  {editingFilename === backup.filename ? (
                    <form
                      className="flex items-center gap-1"
                      onSubmit={async (e) => {
                        e.preventDefault()
                        if (editingName.trim()) {
                          await getTrpcVanillaClient().app.backup.rename.mutate({ filename: backup.filename, name: editingName.trim() })
                          loadData()
                        }
                        setEditingFilename(null)
                      }}
                    >
                      <Input
                        className="h-7 w-48 text-sm"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        autoFocus
                        onKeyDown={(e) => { if (e.key === 'Escape') setEditingFilename(null) }}
                      />
                      <Button type="submit" variant="ghost" size="sm" className="size-7 p-0">
                        <Check className="size-3.5" />
                      </Button>
                      <Button type="button" variant="ghost" size="sm" className="size-7 p-0" onClick={() => setEditingFilename(null)}>
                        <X className="size-3.5" />
                      </Button>
                    </form>
                  ) : (
                    <span className="text-sm font-medium truncate">{backup.name}</span>
                  )}
                  <span
                    className={`shrink-0 rounded px-1.5 py-0.5 text-xs font-medium ${{
                      auto: 'bg-blue-500/10 text-blue-500',
                      manual: 'bg-emerald-500/10 text-emerald-500',
                      migration: 'bg-amber-500/10 text-amber-500',
                    }[backup.type]}`}
                  >
                    {backup.type}
                  </span>
                  <span className="text-muted-foreground text-xs shrink-0">{formatTimestamp(backup.timestamp)}</span>
                  <span className="text-muted-foreground text-xs shrink-0">{formatBytes(backup.sizeBytes)}</span>
                </div>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setCreateSafetyBackup(true)
                      setRestoreTarget(backup)
                    }}
                  >
                    <RotateCcw className="mr-1 size-3.5" />
                    Restore
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditingFilename(backup.filename)
                      setEditingName(backup.name)
                    }}
                  >
                    <Pencil className="size-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setDeleteTarget(backup)}
                  >
                    <Trash2 className="size-3.5 text-destructive" />
                  </Button>
                </div>
              </div>
            ))}
          </CardContent>
        )}
      </Card>

      {/* Restore confirmation */}
      <AlertDialog open={!!restoreTarget} onOpenChange={(open) => !open && setRestoreTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore Backup</AlertDialogTitle>
            <AlertDialogDescription>
              This will replace your current database with{' '}
              <strong>{restoreTarget?.name}</strong> ({restoreTarget && formatTimestamp(restoreTarget.timestamp)}) and restart the app.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex items-center gap-3 py-2">
            <Switch
              checked={createSafetyBackup}
              onCheckedChange={setCreateSafetyBackup}
            />
            <span className="text-sm">Create safety backup of current data first</span>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleRestore}>
              Restore & Restart
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Delete confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Backup</AlertDialogTitle>
            <AlertDialogDescription>
              Delete <strong>{deleteTarget?.name}</strong> ({deleteTarget && formatTimestamp(deleteTarget.timestamp)})? This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
