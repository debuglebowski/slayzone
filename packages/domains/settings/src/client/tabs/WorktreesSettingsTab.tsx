import { useEffect, useState } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { Input, Label, Tooltip, TooltipTrigger, TooltipContent, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, Button } from '@slayzone/ui'
import type { WorktreeCopyBehavior, WorktreeSubmoduleInit } from '@slayzone/projects/shared'
import { useSetting, useSetSettingMutation } from '../queries'
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

function parsePresets(raw: string | null | undefined): CopyPreset[] {
  if (!raw) return FALLBACK_PRESETS
  try {
    const parsed = JSON.parse(raw) as CopyPreset[]
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : FALLBACK_PRESETS
  } catch {
    return FALLBACK_PRESETS
  }
}

export function WorktreesSettingsTab() {
  const setSetting = useSetSettingMutation()
  const savedBasePath = useSetting('worktree_base_path') ?? ''
  const autoCreateWorktreeOnTaskCreate = useSetting('auto_create_worktree_on_task_create') === '1'
  const copyBehavior: WorktreeCopyBehavior = (useSetting('worktree_copy_behavior') as WorktreeCopyBehavior) ?? 'ask'
  const submoduleInit: WorktreeSubmoduleInit = (useSetting('worktree_submodule_init') as WorktreeSubmoduleInit) ?? 'auto'
  const presetsRaw = useSetting('worktree_copy_presets')
  const presets = parsePresets(presetsRaw)

  // Editable draft for base path — only resyncs from server when not actively editing.
  const [worktreeBasePathDraft, setWorktreeBasePathDraft] = useState<string | null>(null)
  const worktreeBasePath = worktreeBasePathDraft ?? savedBasePath
  useEffect(() => {
    if (worktreeBasePathDraft === null) return
    if (worktreeBasePathDraft === savedBasePath) setWorktreeBasePathDraft(null)
  }, [worktreeBasePathDraft, savedBasePath])

  const savePresets = (updated: CopyPreset[]) => {
    setSetting.mutate({ key: 'worktree_copy_presets', value: JSON.stringify(updated) })
  }

  const addPreset = () => {
    const id = `preset-${Date.now()}`
    savePresets([...presets, { id, name: 'New preset', pathGlobs: [] }])
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
              Where git worktrees are created when starting a task on a new branch. Tokens: {'{project}'} = project path, {'{project-folder-name}'} = project basename.
            </TooltipContent>
          </Tooltip>
          <Input
            className="w-full max-w-lg"
            placeholder="../{project-folder-name}-workspaces"
            value={worktreeBasePath}
            onChange={(e) => setWorktreeBasePathDraft(e.target.value)}
            onBlur={() => {
              setSetting.mutate({ key: 'worktree_base_path', value: worktreeBasePath.trim() })
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
                setSetting.mutate({
                  key: 'auto_create_worktree_on_task_create',
                  value: e.target.checked ? '1' : '0',
                })
              }}
            />
            <span>Create worktree for every new task</span>
          </label>
        </div>
        <p className="text-xs text-muted-foreground">
          Tokens: {'{project}'} (full project path), {'{project-folder-name}'} (basename). Leave empty to use {'../{project-folder-name}-workspaces'}.
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
              setSetting.mutate({ key: 'worktree_copy_behavior', value: value as WorktreeCopyBehavior })
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
              setSetting.mutate({ key: 'worktree_submodule_init', value: value as WorktreeSubmoduleInit })
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
