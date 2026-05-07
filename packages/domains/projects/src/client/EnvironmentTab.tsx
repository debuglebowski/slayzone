import { useState, useEffect } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { Button } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'
import { SettingsTabIntro } from './project-settings-shared'

interface EnvironmentTabProps {
  project: Project
  onUpdated: (project: Project) => void
  onClose: () => void
}

export function EnvironmentTab({ project, onUpdated, onClose }: EnvironmentTabProps) {
  const [execType, setExecType] = useState<'host' | 'docker' | 'ssh'>('host')
  const [execContainer, setExecContainer] = useState('')
  const [execSshTarget, setExecSshTarget] = useState('')
  const [execWorkdir, setExecWorkdir] = useState('')
  const [execShell, setExecShell] = useState('')
  const [testingConnection, setTestingConnection] = useState(false)
  const [testResult, setTestResult] = useState<{ success: boolean; error?: string } | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    const ctx = project.execution_context
    if (ctx?.type === 'docker') {
      setExecType('docker')
      setExecContainer(ctx.container)
      setExecWorkdir(ctx.workdir || '')
      setExecShell(ctx.shell || '')
      setExecSshTarget('')
    } else if (ctx?.type === 'ssh') {
      setExecType('ssh')
      setExecSshTarget(ctx.target)
      setExecWorkdir(ctx.workdir || '')
      setExecShell(ctx.shell || '')
      setExecContainer('')
    } else {
      setExecType('host')
      setExecContainer('')
      setExecSshTarget('')
      setExecWorkdir('')
      setExecShell('')
    }
    setTestResult(null)
  }, [project])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (execType === 'docker' && !execContainer.trim()) return
    if (execType === 'ssh' && !execSshTarget.trim()) return

    setLoading(true)
    try {
      const executionContext = execType === 'docker'
        ? { type: 'docker' as const, container: execContainer.trim(), ...(execWorkdir.trim() ? { workdir: execWorkdir.trim() } : {}), ...(execShell.trim() ? { shell: execShell.trim() } : {}) }
        : execType === 'ssh'
          ? { type: 'ssh' as const, target: execSshTarget.trim(), ...(execWorkdir.trim() ? { workdir: execWorkdir.trim() } : {}), ...(execShell.trim() ? { shell: execShell.trim() } : {}) }
          : null

      const updated = await getTrpcVanillaClient().projects.update.mutate({
        id: project.id,
        executionContext
      })
      onUpdated(updated)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="w-full space-y-6">
      <SettingsTabIntro
        title="Environment"
        description="Choose where coding agents run for this project. By default they run on this machine, but you can run them inside a Docker container or on a remote machine via SSH."
      />
      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="space-y-1">
          <Label htmlFor="exec-context">Run agents in</Label>
          <Select
            value={execType}
            onValueChange={(value) => {
              if (value === 'host' || value === 'docker' || value === 'ssh') {
                setExecType(value)
                setTestResult(null)
              }
            }}
          >
            <SelectTrigger id="exec-context" className="max-w-sm">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="host">This machine</SelectItem>
              <SelectItem value="docker">A Docker container</SelectItem>
              <SelectItem value="ssh">A remote machine (SSH)</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            {execType === 'host' && 'Agents run directly on your machine using the project path as the working directory.'}
            {execType === 'docker' && 'Agents run inside an already-running Docker container. Slay attaches via docker exec.'}
            {execType === 'ssh' && 'Agents run on a remote machine. Slay connects via SSH and launches a shell there.'}
          </p>
        </div>
        {execType === 'docker' && (
          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <div className="space-y-1">
              <Label htmlFor="exec-container">Container name</Label>
              <Input id="exec-container" value={execContainer} onChange={(e) => setExecContainer(e.target.value)} placeholder="my-dev-container" className="max-w-sm" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="exec-workdir">Working directory inside container</Label>
              <Input id="exec-workdir" value={execWorkdir} onChange={(e) => setExecWorkdir(e.target.value)} placeholder="/workspace" className="max-w-sm" />
              <p className="text-xs text-muted-foreground">Path inside the container where the agent starts. Defaults to the project path.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="exec-shell">Shell inside container</Label>
              <Input id="exec-shell" value={execShell} onChange={(e) => setExecShell(e.target.value)} placeholder="/bin/bash" className="max-w-sm" />
              <p className="text-xs text-muted-foreground">Defaults to /bin/bash.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!execContainer.trim() || testingConnection}
                onClick={async () => {
                  setTestingConnection(true)
                  setTestResult(null)
                  const result = await window.api.pty.testExecutionContext({ type: 'docker', container: execContainer.trim() }).catch((e: unknown) => ({ success: false as const, error: e instanceof Error ? e.message : String(e) }))
                  setTestResult(result)
                  setTestingConnection(false)
                }}
              >
                {testingConnection ? 'Testing...' : 'Test connection'}
              </Button>
              {testResult && (
                <span className={cn('text-xs', testResult.success ? 'text-green-500' : 'text-red-500')}>
                  {testResult.success ? 'Connected' : testResult.error || 'Failed'}
                </span>
              )}
            </div>
          </div>
        )}
        {execType === 'ssh' && (
          <div className="space-y-3 rounded-lg border border-border/60 p-3">
            <div className="space-y-1">
              <Label htmlFor="exec-ssh-target">Host</Label>
              <Input id="exec-ssh-target" value={execSshTarget} onChange={(e) => setExecSshTarget(e.target.value)} placeholder="user@hostname" className="max-w-sm" />
            </div>
            <div className="space-y-1">
              <Label htmlFor="exec-workdir-ssh">Working directory on remote</Label>
              <Input id="exec-workdir-ssh" value={execWorkdir} onChange={(e) => setExecWorkdir(e.target.value)} placeholder="/home/user/project" className="max-w-sm" />
              <p className="text-xs text-muted-foreground">Path on the remote machine where the agent starts. Defaults to the project path.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="exec-shell-ssh">Shell on remote</Label>
              <Input id="exec-shell-ssh" value={execShell} onChange={(e) => setExecShell(e.target.value)} placeholder="/bin/bash" className="max-w-sm" />
              <p className="text-xs text-muted-foreground">Defaults to /bin/bash.</p>
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!execSshTarget.trim() || testingConnection}
                onClick={async () => {
                  setTestingConnection(true)
                  setTestResult(null)
                  const result = await window.api.pty.testExecutionContext({ type: 'ssh', target: execSshTarget.trim() }).catch((e: unknown) => ({ success: false as const, error: e instanceof Error ? e.message : String(e) }))
                  setTestResult(result)
                  setTestingConnection(false)
                }}
              >
                {testingConnection ? 'Testing...' : 'Test connection'}
              </Button>
              {testResult && (
                <span className={cn('text-xs', testResult.success ? 'text-green-500' : 'text-red-500')}>
                  {testResult.success ? 'Connected' : testResult.error || 'Failed'}
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground">Key-based auth must be set up so no password prompt is needed.</p>
          </div>
        )}
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
