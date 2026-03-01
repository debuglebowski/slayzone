import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, FolderOpen, Trash2 } from 'lucide-react'
import { Button, Input, Label, Textarea, toast } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'
import type { TaskFeatureDetails } from '@slayzone/projects/shared'
import type { Task } from '@slayzone/task/shared'

interface FeaturePanelProps {
  taskId: string
  project: Project | null
  onTaskUpdated: (task: Task) => void
  onOpenFile: (filePath: string) => void
}

export function FeaturePanel({
  taskId,
  project,
  onTaskUpdated,
  onOpenFile
}: FeaturePanelProps): React.JSX.Element {
  const [details, setDetails] = useState<TaskFeatureDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [creatingFeature, setCreatingFeature] = useState(false)
  const [newFeatureId, setNewFeatureId] = useState('')
  const [newFeatureFolder, setNewFeatureFolder] = useState('')
  const [newFeatureTitle, setNewFeatureTitle] = useState('')
  const [newFeatureDescription, setNewFeatureDescription] = useState('')

  const [yamlContent, setYamlContent] = useState('')
  const [yamlLoading, setYamlLoading] = useState(false)
  const [yamlSaving, setYamlSaving] = useState(false)
  const [yamlError, setYamlError] = useState<string | null>(null)
  const [deletingFeature, setDeletingFeature] = useState(false)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRequestIdRef = useRef(0)
  const lastSavedYamlRef = useRef<string | null>(null)

  const loadDetails = useCallback(async () => {
    setLoading(true)
    try {
      const loaded = await window.api.db.getTaskFeatureDetails(taskId)
      setDetails(loaded)
    } finally {
      setLoading(false)
    }
  }, [taskId])

  useEffect(() => {
    if (project?.feature_repo_integration_enabled === 0) {
      setLoading(false)
      setDetails(null)
      return
    }
    void loadDetails()
  }, [loadDetails, project?.id, project?.feature_repo_integration_enabled, project?.updated_at])

  const featureFilePath = details?.featureFilePath ?? null
  const featureDirPath = details?.featureDirPath ?? null
  const projectPath = project?.path ?? null

  useEffect(() => {
    if (!projectPath || !featureFilePath || !featureDirPath) {
      setYamlContent('')
      lastSavedYamlRef.current = null
      return
    }

    let cancelled = false
    void (async () => {
      setYamlLoading(true)
      setYamlError(null)
      try {
        const readResult = await window.api.fs.readFile(projectPath, featureFilePath, true)
        if (cancelled) return

        if (readResult.content == null) {
          setYamlContent('')
          setYamlError('feature.yaml is empty or too large to render')
          lastSavedYamlRef.current = ''
        } else {
          setYamlContent(readResult.content)
          lastSavedYamlRef.current = readResult.content
        }
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        setYamlError(message)
      } finally {
        if (!cancelled) setYamlLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [projectPath, featureFilePath, featureDirPath])

  useEffect(() => {
    if (!details || !projectPath || !featureFilePath) return
    if (lastSavedYamlRef.current === null) return
    if (yamlContent === lastSavedYamlRef.current) return

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const requestId = ++saveRequestIdRef.current
      void (async () => {
        setYamlSaving(true)
        setYamlError(null)
        try {
          await window.api.fs.writeFile(projectPath, featureFilePath, yamlContent)
          const sync = await window.api.db.syncTaskFeatureFromRepo(taskId)
          if (requestId !== saveRequestIdRef.current) return
          if (sync.task) onTaskUpdated(sync.task)
          if (sync.details) setDetails(sync.details)
          lastSavedYamlRef.current = yamlContent
        } catch (err) {
          if (requestId !== saveRequestIdRef.current) return
          setYamlError(err instanceof Error ? err.message : 'Failed to save feature.yaml')
        } finally {
          if (requestId === saveRequestIdRef.current) setYamlSaving(false)
        }
      })()
    }, 350)

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [details, projectPath, featureFilePath, yamlContent, taskId, onTaskUpdated])

  useEffect(() => {
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
      saveRequestIdRef.current += 1
    }
  }, [])

  const canCreateFeature = Boolean(projectPath && project?.feature_repo_integration_enabled === 1)

  if (loading) {
    return <div className="text-xs text-muted-foreground">Loading feature metadata...</div>
  }

  if (project?.feature_repo_integration_enabled !== 1) {
    return (
      <div className="flex h-full flex-col rounded-md border border-dashed border-border p-3">
        <div className="flex items-start gap-2">
          <FileText className="mt-0.5 size-4 text-muted-foreground" />
          <div className="space-y-1">
            <p className="text-sm font-medium">feature.yaml integration disabled</p>
            <p className="text-xs text-muted-foreground">
              To enable, go to Settings -&gt; Integrations.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (!details) {
    if (!canCreateFeature) {
      return (
        <div className="flex h-full flex-col rounded-md border border-dashed border-border p-3">
          <div className="flex items-start gap-2">
            <FileText className="mt-0.5 size-4 text-muted-foreground" />
            <div className="space-y-1">
              <p className="text-sm font-medium">No feature linked</p>
              <p className="text-xs text-muted-foreground">
                Set a repository path for this project to create feature files.
              </p>
            </div>
          </div>
        </div>
      )
    }

    return (
      <div className="flex h-full flex-col rounded-md border border-dashed border-border p-3">
        <div className="space-y-2 rounded-md border border-border p-3">
          <p className="text-xs font-medium">Create Feature Directory</p>
          <div className="space-y-1">
            <Label htmlFor="new-feature-folder" className="text-[11px] text-muted-foreground">Feature Directory</Label>
            <Input
              id="new-feature-folder"
              value={newFeatureFolder}
              onChange={(e) => setNewFeatureFolder(e.target.value)}
              placeholder="feature-001"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-feature-id" className="text-[11px] text-muted-foreground">ID (optional)</Label>
            <Input
              id="new-feature-id"
              value={newFeatureId}
              onChange={(e) => setNewFeatureId(e.target.value)}
              placeholder="FEAT-001"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-feature-title" className="text-[11px] text-muted-foreground">Title (optional)</Label>
            <Input
              id="new-feature-title"
              value={newFeatureTitle}
              onChange={(e) => setNewFeatureTitle(e.target.value)}
              placeholder="Use task title"
              className="h-8 text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="new-feature-description" className="text-[11px] text-muted-foreground">Description (optional)</Label>
            <Textarea
              id="new-feature-description"
              value={newFeatureDescription}
              onChange={(e) => setNewFeatureDescription(e.target.value)}
              placeholder="Use task description"
              className="min-h-24 text-xs"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={creatingFeature}
            onClick={async () => {
              if (creatingFeature) return
              setCreatingFeature(true)
              try {
                const result = await window.api.db.createTaskFeature(taskId, {
                  featureId: newFeatureId.trim() || null,
                  folderName: newFeatureFolder.trim() || null,
                  title: newFeatureTitle.trim() || null,
                  description: newFeatureDescription.trim() || null
                })
                if (result.task) onTaskUpdated(result.task)
                setDetails(result.details)
                setNewFeatureId('')
                setNewFeatureFolder('')
                setNewFeatureTitle('')
                setNewFeatureDescription('')
                toast.success(`Created ${result.featureFilePath}`)
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Failed to create feature file')
              } finally {
                setCreatingFeature(false)
              }
            }}
          >
            Create and link feature
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto">
      <div>
        <label className="mb-1 block text-sm text-muted-foreground">Feature Dir</label>
        <div className="rounded-md border border-border px-3 py-2">
          <div className="flex items-center gap-2">
            <FolderOpen className="size-3.5 text-muted-foreground" />
            <button
              type="button"
              className="truncate text-xs text-foreground hover:underline"
              onClick={() => onOpenFile(details.featureFilePath)}
              title={details.featureDirPath}
            >
              {details.featureDirPath}
            </button>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="block text-sm text-muted-foreground">feature.yaml</label>
          <p className="text-[11px] text-muted-foreground">
            {yamlError
              ? yamlError
              : yamlLoading
                ? 'Loading...'
                : yamlSaving
                  ? 'Saving...'
                  : 'Auto-saved'}
          </p>
        </div>
        <Textarea
          value={yamlContent}
          onChange={(e) => setYamlContent(e.target.value)}
          spellCheck={false}
          className="min-h-[36rem] font-mono text-xs"
          placeholder="feature.yaml content"
        />
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
          Danger zone
        </span>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={deletingFeature}
            onClick={async () => {
              if (deletingFeature) return
              if (!window.confirm('Delete this feature directory and unlink it from the task?')) return
              setDeletingFeature(true)
              try {
                const result = await window.api.db.deleteTaskFeature(taskId)
                if (!result.deleted) {
                  toast.error('No linked feature to delete')
                  return
                }
                if (result.task) onTaskUpdated(result.task)
                setDetails(result.details)
                setYamlContent('')
                setYamlError(null)
                lastSavedYamlRef.current = null
                toast.success('Feature directory deleted')
              } catch (err) {
                toast.error(err instanceof Error ? err.message : 'Failed to delete feature directory')
              } finally {
                setDeletingFeature(false)
              }
            }}
            className="flex-1 gap-1.5 text-xs text-destructive hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
            Delete feature dir
          </Button>
        </div>
      </div>
    </div>
  )
}
