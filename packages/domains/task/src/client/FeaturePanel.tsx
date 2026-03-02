import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText } from 'lucide-react'
import { Button, Input, Label, Textarea, toast } from '@slayzone/ui'
import { CodeEditor } from '@slayzone/file-editor/client'
import type { Project } from '@slayzone/projects/shared'
import type { TaskFeatureDetails } from '@slayzone/projects/shared'
import type { Task } from '@slayzone/task/shared'

const NON_SOURCE_EXTENSIONS = new Set([
  'pyc',
  'pyo',
  'pyd',
  'so',
  'dll',
  'dylib',
  'class',
  'o',
  'a',
  'exe',
  'bin',
  'zip',
  'gz',
  'tar',
  'jar',
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'ico',
  'pdf'
])

function isSourceAcceptanceFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase()
  if (normalized.includes('/__pycache__/')) return false
  const fileName = filePath.split('/').pop() ?? filePath
  const ext = fileName.includes('.') ? (fileName.split('.').pop() ?? '').toLowerCase() : ''
  if (!ext) return true
  return !NON_SOURCE_EXTENSIONS.has(ext)
}

interface FeaturePanelProps {
  taskId: string
  project: Project | null
  onTaskUpdated: (task: Task) => void
  onOpenFile: (filePath: string) => void
  onFeatureCreated?: (details: TaskFeatureDetails | null) => void
}

export function FeaturePanel({
  taskId,
  project,
  onTaskUpdated,
  onOpenFile,
  onFeatureCreated
}: FeaturePanelProps): React.JSX.Element {
  const [details, setDetails] = useState<TaskFeatureDetails | null>(null)
  const [loading, setLoading] = useState(true)
  const [contentRefreshTick, setContentRefreshTick] = useState(0)
  const [editorVersion, setEditorVersion] = useState(0)
  const [creatingFeature, setCreatingFeature] = useState(false)
  const [newFeatureFolder, setNewFeatureFolder] = useState('')
  const [newFeatureTitle, setNewFeatureTitle] = useState('')
  const [newFeatureDescription, setNewFeatureDescription] = useState('')

  const [yamlContent, setYamlContent] = useState('')
  const [yamlLoading, setYamlLoading] = useState(false)
  const [yamlSaving, setYamlSaving] = useState(false)
  const [yamlError, setYamlError] = useState<string | null>(null)
  const [acceptanceFiles, setAcceptanceFiles] = useState<string[]>([])
  const [acceptanceLoading, setAcceptanceLoading] = useState(false)
  const [acceptanceError, setAcceptanceError] = useState<string | null>(null)

  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveRequestIdRef = useRef(0)
  const lastSavedYamlRef = useRef<string | null>(null)

  const loadDetails = useCallback(async (silent = false) => {
    if (!silent) setLoading(true)
    try {
      const loaded = await window.api.db.getTaskFeatureDetails(taskId)
      setDetails(loaded)
    } finally {
      if (!silent) setLoading(false)
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

  useEffect(() => {
    if (project?.feature_repo_integration_enabled !== 1) return
    const onDataRefreshed = (): void => {
      setContentRefreshTick((prev) => prev + 1)
      void loadDetails(true)
    }
    window.addEventListener('slayzone:data-refreshed', onDataRefreshed)
    return () => window.removeEventListener('slayzone:data-refreshed', onDataRefreshed)
  }, [loadDetails, project?.feature_repo_integration_enabled])

  const featureFilePath = details?.featureFilePath ?? null
  const featureDirPath = details?.featureDirPath ?? null
  const featureFileName = featureFilePath
    ? featureFilePath.split('/').filter(Boolean).pop() ?? 'Feature file'
    : 'Feature file'
  const projectPath = project?.path ?? null
  const acceptanceDirPath = featureDirPath ? `${featureDirPath}/acceptance` : null

  useEffect(() => {
    if (!projectPath || !featureFilePath || !featureDirPath) {
      setYamlContent('')
      lastSavedYamlRef.current = null
      setEditorVersion((prev) => prev + 1)
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
          setYamlError('Feature file is empty or too large to render')
          lastSavedYamlRef.current = ''
          setEditorVersion((prev) => prev + 1)
        } else {
          setYamlContent(readResult.content)
          lastSavedYamlRef.current = readResult.content
          setEditorVersion((prev) => prev + 1)
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
  }, [projectPath, featureFilePath, featureDirPath, contentRefreshTick])

  useEffect(() => {
    if (!projectPath || !acceptanceDirPath) {
      setAcceptanceFiles([])
      setAcceptanceError(null)
      return
    }

    let cancelled = false
    void (async () => {
      setAcceptanceLoading(true)
      setAcceptanceError(null)
      try {
        const collected: string[] = []
        const stack: string[] = [acceptanceDirPath]
        while (stack.length > 0) {
          const current = stack.pop()
          if (!current) break
          const entries = await window.api.fs.readDir(projectPath, current)
          for (const entry of entries) {
            if (entry.type === 'directory') {
              if (entry.name === '__pycache__') continue
              stack.push(entry.path)
            } else {
              if (isSourceAcceptanceFile(entry.path)) {
                collected.push(entry.path)
              }
            }
          }
        }
        collected.sort((a, b) => a.localeCompare(b))
        if (cancelled) return
        setAcceptanceFiles(collected)
      } catch (err) {
        if (cancelled) return
        const message = err instanceof Error ? err.message : String(err)
        if (/ENOENT/i.test(message)) {
          setAcceptanceFiles([])
          setAcceptanceError(null)
        } else {
          setAcceptanceFiles([])
          setAcceptanceError(message)
        }
      } finally {
        if (!cancelled) setAcceptanceLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [projectPath, acceptanceDirPath, contentRefreshTick])

  const persistFeatureFileContent = useCallback(async (content: string, requestId: number) => {
    if (!details || !projectPath || !featureFilePath) return
    setYamlSaving(true)
    setYamlError(null)
    try {
      await window.api.fs.writeFile(projectPath, featureFilePath, content)
      const sync = await window.api.db.syncTaskFeatureFromRepo(taskId)
      if (requestId !== saveRequestIdRef.current) return
      if (sync.task) onTaskUpdated(sync.task)
      if (sync.details) setDetails(sync.details)
      lastSavedYamlRef.current = content
    } catch (err) {
      if (requestId !== saveRequestIdRef.current) return
      setYamlError(err instanceof Error ? err.message : 'Failed to save feature file')
    } finally {
      if (requestId === saveRequestIdRef.current) setYamlSaving(false)
    }
  }, [details, featureFilePath, onTaskUpdated, projectPath, taskId])

  useEffect(() => {
    if (!details || !projectPath || !featureFilePath) return
    if (lastSavedYamlRef.current === null) return
    if (yamlContent === lastSavedYamlRef.current) return

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      const requestId = ++saveRequestIdRef.current
      void persistFeatureFileContent(yamlContent, requestId)
    }, 350)

    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current)
        saveTimerRef.current = null
      }
    }
  }, [details, projectPath, featureFilePath, yamlContent, persistFeatureFileContent])

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
            <p className="text-sm font-medium">FEATURE.md integration disabled</p>
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
      <div className="flex h-full flex-col gap-3 rounded-md border border-dashed border-border p-3">
        <p className="text-xs font-medium">Create FEATURE.md</p>

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
          <Label htmlFor="new-feature-title" className="text-[11px] text-muted-foreground">Title</Label>
          <Input
            id="new-feature-title"
            value={newFeatureTitle}
            onChange={(e) => setNewFeatureTitle(e.target.value)}
            placeholder="# Title"
            className="h-8 text-xs"
          />
        </div>

        <div className="space-y-1">
          <Label htmlFor="new-feature-description" className="text-[11px] text-muted-foreground">Description</Label>
          <Textarea
            id="new-feature-description"
            value={newFeatureDescription}
            onChange={(e) => setNewFeatureDescription(e.target.value)}
            placeholder="Description"
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
                featureId: null,
                folderName: newFeatureFolder.trim() || null,
                title: newFeatureTitle.trim() || null,
                description: newFeatureDescription.trim() || null
              })
              if (result.task) onTaskUpdated(result.task)
              setDetails(result.details)
              onFeatureCreated?.(result.details)
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
          Create FEATURE.md
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div>
        <p className="text-sm text-muted-foreground">
          Feature directory:{' '}
          <button
            type="button"
            className="truncate text-sm text-foreground hover:underline"
            onClick={() => onOpenFile(details.featureFilePath)}
            title={details.featureDirPath}
          >
            {details.featureDirPath}
          </button>
        </p>
      </div>

      <div className="min-h-0 flex flex-1 flex-col">
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="block text-sm text-muted-foreground">{featureFileName}</label>
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
        <div className="min-h-0 flex-1 rounded-md border border-border bg-surface-1 overflow-hidden">
          <CodeEditor
            filePath={featureFilePath || 'FEATURE.md'}
            content={yamlContent}
            onChange={setYamlContent}
            onSave={() => {
              if (!details || !projectPath || !featureFilePath) return
              if (lastSavedYamlRef.current === null) return
              if (yamlContent === lastSavedYamlRef.current) return
              const requestId = ++saveRequestIdRef.current
              void persistFeatureFileContent(yamlContent, requestId)
            }}
            version={editorVersion}
            showLineNumbers={false}
            wrapLongLines={true}
          />
        </div>
      </div>

      <div className="mt-auto">
        <div className="mb-1 flex items-center justify-between gap-2">
          <label className="block text-sm text-muted-foreground">Acceptance</label>
        </div>
        <div className="h-24 rounded-md border border-border bg-surface-1 overflow-y-auto">
          {acceptanceLoading
            ? <p className="px-3 py-2 text-xs text-muted-foreground">Loading files...</p>
            : acceptanceError
              ? <p className="px-3 py-2 text-xs text-destructive">{acceptanceError}</p>
              : acceptanceFiles.length === 0
                ? <p className="px-3 py-2 text-xs text-muted-foreground">No files in acceptance/</p>
                : acceptanceFiles.map((filePath) => {
                  const name = filePath.split('/').pop() ?? filePath
                  return (
                    <button
                      key={filePath}
                      type="button"
                      className="flex w-full flex-col items-start px-3 py-2 text-left text-xs text-muted-foreground hover:bg-surface-2/70"
                      onClick={() => onOpenFile(filePath)}
                      title={filePath}
                    >
                      <span className="truncate font-medium">{name}</span>
                      <span className="truncate text-[11px]">{filePath}</span>
                    </button>
                  )
                })}
        </div>
      </div>
    </div>
  )
}
