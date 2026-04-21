import { useState, useEffect, useCallback } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Input, Label, Tooltip, TooltipTrigger, TooltipContent, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Button } from '@slayzone/ui'
import type { WorktreeCopyBehavior, WorktreeSubmoduleInit } from '@slayzone/projects/shared'
import { SettingsTabIntro } from './SettingsTabIntro'

interface CopyPreset {
  id: string
  name: string
  pathGlobs: string[]
}

const FALLBACK_PRESETS: CopyPreset[] = [
  { id: 'all-ignored', name: 'All ignored files', pathGlobs: [] },
  { id: 'env-only', name: 'Env files only', pathGlobs: ['.env*', '*.local'] },
  { id: 'docs-and-env', name: 'Docs + env', pathGlobs: ['docs/**', '*.md', '.env*', '*.local'] },
]

export function WorktreesSettingsTab() {
  const [worktreeBasePath, setWorktreeBasePath] = useState('')
  const [autoCreateWorktreeOnTaskCreate, setAutoCreateWorktreeOnTaskCreate] = useState(false)
  const [copyBehavior, setCopyBehavior] = useState<WorktreeCopyBehavior>('ask')
  const [submoduleInit, setSubmoduleInit] = useState<WorktreeSubmoduleInit>('auto')
  const [presets, setPresets] = useState<CopyPreset[]>([])

  useEffect(() => {
    window.api.settings.get('worktree_base_path').then(val => setWorktreeBasePath(val ?? ''))
    window.api.settings.get('auto_create_worktree_on_task_create').then(val => setAutoCreateWorktreeOnTaskCreate(val === '1'))
    window.api.settings.get('worktree_copy_behavior').then(val => setCopyBehavior((val as WorktreeCopyBehavior) ?? 'ask'))
    window.api.settings.get('worktree_submodule_init').then(val => setSubmoduleInit((val as WorktreeSubmoduleInit) ?? 'auto'))
    window.api.settings.get('worktree_copy_presets').then(val => {
      const parsed = val ? JSON.parse(val) as CopyPreset[] : null
      setPresets(parsed && parsed.length > 0 ? parsed : FALLBACK_PRESETS)
    }).catch(() => setPresets(FALLBACK_PRESETS))
  }, [])

  const savePresets = useCallback((updated: CopyPreset[]) => {
    setPresets(updated)
    window.api.settings.set('worktree_copy_presets', JSON.stringify(updated))
  }, [])

  const addPreset = () => {
    const id = `preset-${Date.now()}`
    savePresets([...presets, {
      id, name: 'New preset',
      pathGlobs: []
    }])
  }

  const removePreset = (id: string) => {
    savePresets(presets.filter(p => p.id !== id))
  }

  const updatePreset = (id: string, patch: Partial<CopyPreset>) => {
    savePresets(presets.map(p => p.id === id ? { ...p, ...patch } : p))
  }

  return (
    <>
      <SettingsTabIntro
        title="Worktrees"
        description="Configure how git worktrees are created and what files are carried over."
      />

      <div className="space-y-3">
        <Label className="text-base font-semibold">Creation</Label>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm cursor-default">Base path</span>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-64">
              Where git worktrees are created when starting a task on a new branch. Use {'{project}'} as a placeholder for the project directory.
            </TooltipContent>
          </Tooltip>
          <Input
            className="w-full max-w-lg"
            placeholder="{project}/.."
            value={worktreeBasePath}
            onChange={(e) => setWorktreeBasePath(e.target.value)}
            onBlur={() => {
              window.api.settings.set('worktree_base_path', worktreeBasePath.trim())
            }}
          />
        </div>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Auto-create worktree</span>
          <label className="inline-flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={autoCreateWorktreeOnTaskCreate}
              onChange={(e) => {
                const enabled = e.target.checked
                setAutoCreateWorktreeOnTaskCreate(enabled)
                window.api.settings.set(
                  'auto_create_worktree_on_task_create',
                  enabled ? '1' : '0'
                )
              }}
            />
            <span>Create worktree for every new task</span>
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Use {'{project}'} as a token. Leave empty to use {'{project}/..'}.
          Project settings can override auto-create behavior.
        </p>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">File copy behavior</Label>
        <p className="text-sm text-muted-foreground">
          When creating a worktree, what should happen with local files?
        </p>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Default behavior</span>
          <Select
            value={copyBehavior}
            onValueChange={(value) => {
              const v = value as WorktreeCopyBehavior
              setCopyBehavior(v)
              window.api.settings.set('worktree_copy_behavior', v)
            }}
          >
            <SelectTrigger className="max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="ask">Ask every time</SelectItem>
              <SelectItem value="none">Don't copy</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Submodules</Label>
        <p className="text-sm text-muted-foreground">
          When creating a worktree in a repo with <code className="font-mono">.gitmodules</code>, should submodules be initialized automatically?
        </p>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Submodule init</span>
          <Select
            value={submoduleInit}
            onValueChange={(value) => {
              const v = value as WorktreeSubmoduleInit
              setSubmoduleInit(v)
              window.api.settings.set('worktree_submodule_init', v)
            }}
          >
            <SelectTrigger className="max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto-init when .gitmodules present</SelectItem>
              <SelectItem value="skip">Skip</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label className="text-base font-semibold">Copy presets</Label>
          <Button variant="outline" size="sm" onClick={addPreset} className="gap-1.5 h-7">
            <Plus className="h-3 w-3" />
            Add preset
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Presets define which files to copy into new worktrees. They appear in the copy dialog when creating a worktree.
        </p>

        <div className="space-y-2">
          {presets.map(preset => (
            <PresetCard
              key={preset.id}
              preset={preset}
              onUpdate={(patch) => updatePreset(preset.id, patch)}
              onRemove={() => removePreset(preset.id)}
            />
          ))}
          {presets.length === 0 && (
            <p className="text-xs text-muted-foreground py-4 text-center">No presets. Click "Add preset" to create one.</p>
          )}
        </div>
      </div>
    </>
  )
}

function PresetCard({ preset, onUpdate, onRemove }: {
  preset: CopyPreset
  onUpdate: (patch: Partial<CopyPreset>) => void
  onRemove: () => void
}) {
  return (
    <div className="rounded-md border p-3 space-y-3">
      <div className="flex items-center gap-2">
        <Input
          value={preset.name}
          onChange={(e) => onUpdate({ name: e.target.value })}
          className="h-7 text-sm font-medium flex-1"
        />
        <Button variant="ghost" size="sm" onClick={onRemove} className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive">
          <Trash2 className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="space-y-1">
        <label className="text-[11px] text-muted-foreground">Path filter (comma-separated globs, empty = all ignored files)</label>
        <Input
          value={preset.pathGlobs.join(', ')}
          onChange={(e) => onUpdate({ pathGlobs: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
          placeholder="docs/**, *.md, .env*"
          className="h-7 text-xs font-mono"
        />
      </div>
    </div>
  )
}
