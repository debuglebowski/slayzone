import { useState, useEffect } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
import { FolderOpen, Upload, Trash2 } from 'lucide-react'
import { Button, IconButton } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { Label } from '@slayzone/ui'
import { ColorPicker } from '@slayzone/ui'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@slayzone/ui'
import type { Project } from '@slayzone/projects/shared'
import { toSlzFileUrl } from '@slayzone/platform/slz-file-url'
import { useDialogStore } from '@slayzone/settings/client'
import { SettingsTabIntro } from './project-settings-shared'

/** Select sentinel for the project's Local (in-process) default runner (null). */
const LOCAL_RUNNER_VALUE = '__local__'

interface GeneralTabProps {
  project: Project
  onUpdated: (project: Project) => void
  /** In-place update (e.g. icon upload) — does not close the dialog. */
  onChanged: (project: Project) => void
  onClose: () => void
}

export function GeneralTab({ project, onUpdated, onChanged, onClose }: GeneralTabProps) {
  const trpc = useTRPC()
  const showOpenDialog = useMutation(trpc.app.dialog.showOpenDialog.mutationOptions())
  const uploadProjectIcon = useMutation(trpc.projects.uploadIcon.mutationOptions())
  const updateProject = useMutation(trpc.projects.update.mutationOptions())
  const runnersQuery = useQuery(trpc.runners.list.queryOptions())
  const setProjectDefaultRunner = useMutation(trpc.runners.setProjectDefaultRunner.mutationOptions())
  const [name, setName] = useState('')
  const [color, setColor] = useState('')
  const [path, setPath] = useState('')
  const [iconLetters, setIconLetters] = useState('')
  const [iconImagePath, setIconImagePath] = useState<string | null>(null)
  const [iconCacheKey, setIconCacheKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [iconBusy, setIconBusy] = useState(false)
  // Default runner (hub/runner split). `default_runner_id` is a v149 column present
  // at runtime (parseProject spreads the row) but not yet on the shared Project type
  // — read via a narrow local cast. null = Local (in-process).
  const [defaultRunnerId, setDefaultRunnerId] = useState<string | null>(null)

  useEffect(() => {
    setName(project.name)
    setColor(project.color)
    setPath(project.path || '')
    setIconLetters(project.icon_letters || '')
    setIconImagePath(project.icon_image_path)
    setIconCacheKey(project.updated_at)
    setDefaultRunnerId((project as { default_runner_id?: string | null }).default_runner_id ?? null)
  }, [project])

  const runners = runnersQuery.data ?? []

  const fallbackLetters = (name || project.name).slice(0, 2).toUpperCase()
  const lettersPreview = iconLetters.trim().toUpperCase() || fallbackLetters

  const handleBrowse = async () => {
    const result = await showOpenDialog.mutateAsync({
      title: 'Select Project Directory',
      defaultPath: path || undefined,
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    if (!result.canceled && result.filePaths[0]) {
      setPath(result.filePaths[0])
    }
  }

  const handleUploadIcon = async () => {
    const result = await showOpenDialog.mutateAsync({
      title: 'Select Project Icon',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'] }]
    })
    if (result.canceled || !result.filePaths[0]) return
    setIconBusy(true)
    try {
      const updated = await uploadProjectIcon.mutateAsync({
        projectId: project.id,
        sourcePath: result.filePaths[0]
      })
      setIconImagePath(updated.icon_image_path)
      setIconCacheKey(updated.updated_at)
      onChanged(updated)
    } finally {
      setIconBusy(false)
    }
  }

  const handleRemoveIcon = async () => {
    setIconBusy(true)
    try {
      const updated = await updateProject.mutateAsync({ id: project.id, iconImagePath: null })
      setIconImagePath(null)
      setIconCacheKey(updated.updated_at)
      onChanged(updated)
    } finally {
      setIconBusy(false)
    }
  }

  // The default runner is its own binding (persisted immediately), not part of the
  // name/color/path form save. null = Local.
  const handleDefaultRunnerChange = async (value: string): Promise<void> => {
    const runnerId = value === LOCAL_RUNNER_VALUE ? null : value
    setDefaultRunnerId(runnerId)
    await setProjectDefaultRunner.mutateAsync({ projectId: project.id, runnerId })
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return

    setLoading(true)
    try {
      const trimmedLetters = iconLetters.trim()
      const updated = await updateProject.mutateAsync({
        id: project.id,
        name: name.trim(),
        color,
        path: path || null,
        iconLetters: trimmedLetters.length > 0 ? trimmedLetters : null
      })

      onUpdated(updated)
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="mb-6 space-y-6">
        <SettingsTabIntro
          title="General"
          description="Configure the project identity and repository defaults."
        />
        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="space-y-1">
            <Label htmlFor="edit-name">Name</Label>
            <Input id="edit-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <Label htmlFor="edit-path">Repository Path</Label>
            <div className="flex gap-2">
              <Input
                id="edit-path"
                value={path}
                onChange={(e) => setPath(e.target.value)}
                placeholder="/path/to/repo"
                className="flex-1"
              />
              <IconButton
                type="button"
                variant="outline"
                aria-label="Browse folder"
                onClick={handleBrowse}
              >
                <FolderOpen className="h-4 w-4" />
              </IconButton>
            </div>
            <p className="text-xs text-muted-foreground">
              Claude Code terminal will open in this directory
            </p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="default-runner">Default runner</Label>
            {runners.length === 0 ? (
              <p className="text-sm text-muted-foreground">No runners — tasks run locally</p>
            ) : (
              <Select
                value={defaultRunnerId ?? LOCAL_RUNNER_VALUE}
                onValueChange={handleDefaultRunnerChange}
              >
                <SelectTrigger id="default-runner" className="max-w-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={LOCAL_RUNNER_VALUE}>Local</SelectItem>
                  {runners.map((runner) => (
                    <SelectItem key={runner.id} value={runner.id}>
                      {runner.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            <p className="text-xs text-muted-foreground">
              Where tasks in this project run by default. Tasks can override this individually.
            </p>
          </div>
          <div className="space-y-1">
            <Label>Color</Label>
            <ColorPicker value={color} onChange={setColor} />
          </div>
          <div className="space-y-2">
            <Label>Icon</Label>
            <div className="flex items-center gap-3">
              <div
                className="h-14 w-14 rounded-md flex items-center justify-center overflow-hidden font-semibold text-white shrink-0"
                style={{ backgroundColor: color }}
              >
                {iconImagePath ? (
                  <img
                    src={toSlzFileUrl(iconImagePath, iconCacheKey)}
                    alt=""
                    className="w-full h-full object-cover"
                    draggable={false}
                  />
                ) : (
                  <span
                    className={
                      lettersPreview.length >= 5
                        ? 'text-xs'
                        : lettersPreview.length > 2
                          ? 'text-sm'
                          : 'text-base'
                    }
                  >
                    {lettersPreview}
                  </span>
                )}
              </div>
              <div className="flex-1 space-y-1">
                <div className="flex items-center gap-2">
                  {!iconImagePath && (
                    <Input
                      id="edit-icon-letters"
                      value={iconLetters}
                      maxLength={5}
                      placeholder={fallbackLetters}
                      onChange={(e) => setIconLetters(e.target.value)}
                      className="w-28"
                    />
                  )}
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={handleUploadIcon}
                    disabled={iconBusy}
                  >
                    <Upload className="h-3.5 w-3.5 mr-1.5" />
                    {iconImagePath ? 'Upload new image' : 'Upload image'}
                  </Button>
                  {iconImagePath && (
                    <button
                      type="button"
                      onClick={handleRemoveIcon}
                      disabled={iconBusy}
                      className="text-xs text-destructive hover:underline disabled:opacity-50"
                    >
                      Remove
                    </button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {iconImagePath
                    ? 'Remove the image to use initials instead.'
                    : 'Initials 1–5 chars (empty = derive from name). Upload an image to override.'}
                </p>
              </div>
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || loading}>
              Save
            </Button>
          </div>
        </form>
      </div>

      <div className="mt-auto space-y-3 rounded-md border border-destructive/40 p-4">
        <div className="space-y-1">
          <h3 className="text-sm font-medium text-destructive">Danger Zone</h3>
          <p className="text-xs text-muted-foreground">
            Permanently delete this project and all of its tasks. This action cannot be undone.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="border-destructive/40 text-destructive hover:text-destructive"
          onClick={() => useDialogStore.getState().openDeleteProject(project)}
        >
          <Trash2 className="h-3.5 w-3.5 mr-1.5" />
          Delete Project
        </Button>
      </div>
    </div>
  )
}
