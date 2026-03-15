import { useState, useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Input, Label, Tooltip, TooltipTrigger, TooltipContent, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import type { WorktreeCopyBehavior } from '@slayzone/projects/shared'
import { SettingsTabIntro } from './SettingsTabIntro'

export function WorktreesSettingsTab() {
  const [worktreeBasePath, setWorktreeBasePath] = useState('')
  const [autoCreateWorktreeOnTaskCreate, setAutoCreateWorktreeOnTaskCreate] = useState(false)
  const [copyBehavior, setCopyBehavior] = useState<WorktreeCopyBehavior>('ask')
  const [customPaths, setCustomPaths] = useState('')

  useEffect(() => {
    window.api.settings.get('worktree_base_path').then(val => setWorktreeBasePath(val ?? ''))
    window.api.settings.get('auto_create_worktree_on_task_create').then(val => setAutoCreateWorktreeOnTaskCreate(val === '1'))
    window.api.settings.get('worktree_copy_behavior').then(val => setCopyBehavior((val as WorktreeCopyBehavior) ?? 'ask'))
    window.api.settings.get('worktree_copy_paths').then(val => setCustomPaths(val ?? ''))
  }, [])

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
        <Label className="text-base font-semibold">Copy ignored files</Label>
        <p className="text-sm text-muted-foreground">
          Files not tracked by git (e.g. <code className="font-mono text-xs">.env</code>, <code className="font-mono text-xs">node_modules</code>) that should be copied into new worktrees.
        </p>
        <div className="grid grid-cols-[220px_minmax(0,1fr)] items-center gap-4">
          <span className="text-sm">Behavior</span>
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
              <SelectItem value="all">Copy all ignored files</SelectItem>
              <SelectItem value="custom">Custom paths</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {copyBehavior === 'all' && (
          <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 text-xs text-yellow-600 dark:text-yellow-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
            <span>This will copy all git-ignored files including potentially large directories like <code className="font-mono">node_modules</code>. This can be slow and use significant disk space.</span>
          </div>
        )}
        {copyBehavior === 'custom' && (
          <div className="grid grid-cols-[220px_minmax(0,1fr)] items-start gap-4">
            <span className="text-sm pt-2">Paths</span>
            <div className="space-y-1">
              <Input
                className="w-full max-w-lg"
                placeholder=".env*, node_modules, packages/*/dist"
                value={customPaths}
                onChange={(e) => setCustomPaths(e.target.value)}
                onBlur={() => {
                  window.api.settings.set('worktree_copy_paths', customPaths.trim())
                }}
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated paths relative to the repo root. Wildcards (*, ?) supported.
              </p>
            </div>
          </div>
        )}
      </div>
    </>
  )
}
