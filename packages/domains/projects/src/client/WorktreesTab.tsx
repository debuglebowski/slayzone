import { useState, useEffect } from 'react'
import { AlertTriangle } from 'lucide-react'
import { Button, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import type { Project, WorktreeCopyBehavior, WorktreeSubmoduleInit } from '@slayzone/projects/shared'
import { SettingsTabIntro } from './project-settings-shared'

type CopyOverride = 'inherit' | WorktreeCopyBehavior
type SubmoduleOverride = 'inherit' | WorktreeSubmoduleInit

interface WorktreesTabProps {
  project: Project
  onUpdated: (project: Project) => void
  onClose: () => void
}

export function WorktreesTab({ project, onUpdated, onClose }: WorktreesTabProps) {
  const [autoCreateOverride, setAutoCreateOverride] = useState<'inherit' | 'on' | 'off'>('inherit')
  const [sourceBranch, setSourceBranch] = useState('')
  const [copyOverride, setCopyOverride] = useState<CopyOverride>('inherit')
  const [customPaths, setCustomPaths] = useState('')
  const [submoduleOverride, setSubmoduleOverride] = useState<SubmoduleOverride>('inherit')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    setAutoCreateOverride(
      project.auto_create_worktree_on_task_create === 1
        ? 'on'
        : project.auto_create_worktree_on_task_create === 0
          ? 'off'
          : 'inherit'
    )
    setSourceBranch(project.worktree_source_branch || '')
    setCopyOverride((project.worktree_copy_behavior as CopyOverride) ?? 'inherit')
    setCustomPaths(project.worktree_copy_paths || '')
    setSubmoduleOverride((project.worktree_submodule_init as SubmoduleOverride) ?? 'inherit')
  }, [project])

  const openComputerSettings = () => {
    onClose()
    window.dispatchEvent(new CustomEvent('open-settings', { detail: 'worktrees' }))
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const updated = await window.api.db.updateProject({
        id: project.id,
        autoCreateWorktreeOnTaskCreate:
          autoCreateOverride === 'inherit'
            ? null
            : autoCreateOverride === 'on',
        worktreeSourceBranch: sourceBranch.trim() || null,
        worktreeCopyBehavior: copyOverride === 'inherit' ? null : copyOverride,
        worktreeCopyPaths: copyOverride === 'custom' ? customPaths.trim() || null : null,
        worktreeSubmoduleInit: submoduleOverride === 'inherit' ? null : submoduleOverride
      })
      onUpdated(updated)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full space-y-6">
      <SettingsTabIntro
        title="Worktrees"
        description="Configure how git worktrees are created for this project."
      />
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-1">
          <Label htmlFor="auto-create-worktree-override">Auto-create worktree on task creation</Label>
          <div className="flex items-center gap-2">
            <Select
              value={autoCreateOverride}
              onValueChange={(value) => setAutoCreateOverride(value as typeof autoCreateOverride)}
            >
              <SelectTrigger id="auto-create-worktree-override" className="max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Use computer setting</SelectItem>
                <SelectItem value="on">Always on</SelectItem>
                <SelectItem value="off">Always off</SelectItem>
              </SelectContent>
            </Select>
            {autoCreateOverride === 'inherit' && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                onClick={openComputerSettings}
              >
                Go to computer setting
              </button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            Overrides the computer setting for this project only.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor="worktree-source-branch">Source branch</Label>
          <Input
            id="worktree-source-branch"
            value={sourceBranch}
            onChange={(e) => setSourceBranch(e.target.value)}
            placeholder="main"
            className="max-w-sm"
          />
          <p className="text-xs text-muted-foreground">
            Branch to create worktrees from. Defaults to the current branch if empty.
          </p>
        </div>

        <div className="space-y-3">
          <div className="space-y-1">
            <Label>Copy ignored files</Label>
            <p className="text-xs text-muted-foreground">
              Files not tracked by git to copy into new worktrees.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Select
              value={copyOverride}
              onValueChange={(value) => setCopyOverride(value as CopyOverride)}
            >
              <SelectTrigger className="max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Use computer setting</SelectItem>
                <SelectItem value="ask">Ask every time</SelectItem>
                <SelectItem value="none">Don't copy</SelectItem>
                <SelectItem value="all">Copy all ignored files</SelectItem>
                <SelectItem value="custom">Custom paths</SelectItem>
              </SelectContent>
            </Select>
            {copyOverride === 'inherit' && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                onClick={openComputerSettings}
              >
                Go to computer setting
              </button>
            )}
          </div>
          {copyOverride === 'all' && (
            <div className="flex items-start gap-2 px-3 py-2 rounded-md border border-yellow-500/30 bg-yellow-500/10 text-xs text-yellow-600 dark:text-yellow-400">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
              <span>This will copy all git-ignored files including potentially large directories like <code className="font-mono">node_modules</code>. This can be slow and use significant disk space.</span>
            </div>
          )}
          {copyOverride === 'custom' && (
            <div className="space-y-1">
              <Input
                className="max-w-lg"
                placeholder=".env*, node_modules, packages/*/dist"
                value={customPaths}
                onChange={(e) => setCustomPaths(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Comma-separated paths relative to the repo root. Wildcards (*, ?) supported.
              </p>
            </div>
          )}
        </div>

        <div className="space-y-1">
          <Label>Submodule init</Label>
          <p className="text-xs text-muted-foreground">
            Initialize submodules (<code className="font-mono">git submodule update --init --recursive</code>) when a worktree is created.
          </p>
          <div className="flex items-center gap-2">
            <Select
              value={submoduleOverride}
              onValueChange={(value) => setSubmoduleOverride(value as SubmoduleOverride)}
            >
              <SelectTrigger className="max-w-sm">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="inherit">Use computer setting</SelectItem>
                <SelectItem value="auto">Auto-init when .gitmodules present</SelectItem>
                <SelectItem value="skip">Skip</SelectItem>
              </SelectContent>
            </Select>
            {submoduleOverride === 'inherit' && (
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground transition-colors flex items-center gap-1"
                onClick={openComputerSettings}
              >
                Go to computer setting
              </button>
            )}
          </div>
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={loading}>
            Save
          </Button>
        </div>
      </form>
    </div>
  )
}
