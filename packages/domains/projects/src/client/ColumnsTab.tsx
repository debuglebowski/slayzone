import { useState, useEffect } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import {
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown
} from 'lucide-react'
import { Button, IconButton } from '@slayzone/ui'
import { Input } from '@slayzone/ui'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@slayzone/ui'
import { cn } from '@slayzone/ui'
import {
  DEFAULT_COLUMNS,
  WORKFLOW_CATEGORIES,
  resolveColumns,
  validateColumns,
  type WorkflowCategory,
  type ColumnConfig,
  type Project
} from '@slayzone/projects/shared'
import { CATEGORY_META, STATUS_COLOR_BADGE, SettingsTabIntro } from './project-settings-shared'

interface ColumnsTabProps {
  project: Project
  onUpdated: (project: Project) => void
  lockedByProvider?: string | null
}

export function ColumnsTab({ project, onUpdated, lockedByProvider }: ColumnsTabProps) {
  const [columnsDraft, setColumnsDraft] = useState<ColumnConfig[]>(() =>
    resolveColumns(project.columns_config)
  )

  useEffect(() => {
    setColumnsDraft(resolveColumns(project.columns_config))
  }, [project])

  const colorOptions = ['gray', 'slate', 'blue', 'yellow', 'purple', 'green', 'red', 'orange']

  const normalizePositions = (columns: ColumnConfig[]): ColumnConfig[] =>
    columns.map((column, index) => ({ ...column, position: index }))

  const updateColumn = (id: string, update: Partial<ColumnConfig>) => {
    setColumnsDraft((prev) => normalizePositions(prev.map((column) => (
      column.id === id ? { ...column, ...update } : column
    ))))
  }

  const moveColumn = (id: string, category: WorkflowCategory, direction: -1 | 1) => {
    setColumnsDraft((prev) => {
      const sorted = [...prev].sort((a, b) => a.position - b.position)

      const categoryColumns = sorted.filter((column) => column.category === category)
      const categoryIndex = categoryColumns.findIndex((column) => column.id === id)
      const nextCategoryIndex = categoryIndex + direction
      if (categoryIndex < 0 || nextCategoryIndex < 0 || nextCategoryIndex >= categoryColumns.length) return prev

      const nextCategoryColumns = [...categoryColumns]
      const [moved] = nextCategoryColumns.splice(categoryIndex, 1)
      nextCategoryColumns.splice(nextCategoryIndex, 0, moved)

      let replacementIndex = 0
      const next = sorted.map((column) => (
        column.category === category
          ? nextCategoryColumns[replacementIndex++]
          : column
      ))

      return normalizePositions(next)
    })
  }

  const addColumn = (category: WorkflowCategory = 'unstarted') => {
    setColumnsDraft((prev) => {
      const sorted = [...prev].sort((a, b) => a.position - b.position)
      const base = `status-${sorted.length + 1}`
      let id = base
      let n = 2
      const ids = new Set(sorted.map((column) => column.id))
      while (ids.has(id)) {
        id = `${base}-${n}`
        n++
      }
      return [
        ...sorted,
        { id, label: 'New Status', color: 'blue', category, position: sorted.length }
      ]
    })
  }

  const deleteColumn = (id: string) => {
    const next = columnsDraft.filter((column) => column.id !== id)
    if (next.length === columnsDraft.length) return
    if (next.length === 0) return

    setColumnsDraft(normalizePositions(next))
  }

  const handleResetColumns = () => {
    setColumnsDraft(DEFAULT_COLUMNS.map((column) => ({ ...column })))
  }

  const handleSaveColumns = async () => {
    let normalized: ColumnConfig[]
    try {
      normalized = validateColumns(normalizePositions(columnsDraft))
    } catch (error) {
      window.alert(error instanceof Error ? error.message : String(error))
      return
    }

    const updated = await getTrpcVanillaClient().projects.update.mutate({
      id: project.id,
      columnsConfig: normalized
    })
    onUpdated(updated)
    setColumnsDraft(resolveColumns(updated.columns_config))
  }

  const sortedColumns = [...columnsDraft].sort((a, b) => a.position - b.position)

  return (
    <div className="w-full space-y-6">
      <SettingsTabIntro
        title="Task statuses"
        description="Define the workflow statuses your tasks move through. Group statuses by stage and customize each status name, color, and behavior."
      />
      {lockedByProvider && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-200">
          Statuses managed by {lockedByProvider} sync. Disconnect integration to edit.
        </div>
      )}
      <div className="space-y-2 rounded-xl border border-border/60 bg-card/30 p-4">
        {WORKFLOW_CATEGORIES.map((category) => {
          const meta = CATEGORY_META[category]
          const Icon = meta.icon
          const rows = sortedColumns.filter((column) => column.category === category)

          return (
            <div key={category} className="space-y-1">
              <div className="flex items-center justify-between rounded-md border border-border/50 bg-muted/60 py-2 pl-3 pr-2">
                <p className="text-sm font-medium text-foreground/90">{meta.label}</p>
                {!lockedByProvider && (
                  <IconButton
                    type="button"
                    variant="ghost"
                    className="h-7 w-7"
                    onClick={() => addColumn(category)}
                    aria-label={`Add ${meta.label} status`}
                  >
                    <Plus className="h-4 w-4" />
                  </IconButton>
                )}
              </div>

              {rows.length === 0 ? (
                <div className="py-2 pr-3 text-xs text-muted-foreground">
                  No statuses in this group.
                </div>
              ) : (
                <div className="divide-y divide-border/40">
                  {rows.map((column, index) => (
                    <div
                      key={column.id}
                      className="group py-2 pr-2"
                      data-testid={`project-column-${column.id}`}
                    >
                      <div className="flex items-center gap-2">
                        {lockedByProvider ? (
                          <div
                            className={cn(
                              'flex h-9 w-9 items-center justify-center rounded-md border border-border/50',
                              STATUS_COLOR_BADGE[column.color] ?? STATUS_COLOR_BADGE.gray
                            )}
                          >
                            <Icon className="h-4 w-4" />
                          </div>
                        ) : (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <IconButton
                                type="button"
                                variant="ghost"
                                className={cn(
                                  'h-9 w-9 rounded-md border border-border/50 p-0',
                                  STATUS_COLOR_BADGE[column.color] ?? STATUS_COLOR_BADGE.gray
                                )}
                                aria-label="Select status color"
                              >
                                <Icon className="h-4 w-4" />
                              </IconButton>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="start">
                              {colorOptions.map((value) => (
                                <DropdownMenuItem
                                  key={value}
                                  onSelect={() => updateColumn(column.id, { color: value })}
                                >
                                  <span
                                    className={cn(
                                      'mr-2 inline-flex h-2.5 w-2.5 rounded-full',
                                      STATUS_COLOR_BADGE[value] ?? STATUS_COLOR_BADGE.gray
                                    )}
                                  />
                                  {value}
                                </DropdownMenuItem>
                              ))}
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                        <Input
                          value={column.label}
                          onChange={(event) => updateColumn(column.id, { label: event.target.value })}
                          placeholder="Status label"
                          disabled={Boolean(lockedByProvider)}
                          className="h-8 border-0 !bg-transparent dark:!bg-transparent px-0 text-sm font-medium shadow-none focus:bg-transparent focus-visible:!bg-transparent focus-visible:ring-0 focus-visible:ring-offset-0"
                        />
                        {!lockedByProvider && (
                          <div className="ml-1 flex items-center gap-0.5">
                            <IconButton
                              type="button"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              data-testid={`move-up-project-column-${column.id}`}
                              aria-label={`Move ${column.label} status up`}
                              disabled={index === 0}
                              onClick={() => moveColumn(column.id, category, -1)}
                            >
                              <ChevronUp className="h-4 w-4" />
                            </IconButton>
                            <IconButton
                              type="button"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-foreground"
                              data-testid={`move-down-project-column-${column.id}`}
                              aria-label={`Move ${column.label} status down`}
                              disabled={index === rows.length - 1}
                              onClick={() => moveColumn(column.id, category, 1)}
                            >
                              <ChevronDown className="h-4 w-4" />
                            </IconButton>
                            <IconButton
                              type="button"
                              variant="ghost"
                              className="h-7 w-7 text-muted-foreground hover:text-destructive"
                              data-testid={`delete-project-column-${column.id}`}
                              aria-label={`Delete ${column.label} column`}
                              onClick={() => deleteColumn(column.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </IconButton>
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
      {!lockedByProvider && (
        <div className="flex items-center justify-end gap-2">
          <Button type="button" variant="outline" onClick={handleResetColumns}>
            Reset defaults
          </Button>
          <Button type="button" onClick={handleSaveColumns} data-testid="save-project-columns">
            Save statuses
          </Button>
        </div>
      )}
    </div>
  )
}
