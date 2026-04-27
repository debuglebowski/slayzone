import { useState, useEffect, useCallback } from 'react'
import { Button, Label, Switch, Input, Tooltip, TooltipTrigger, TooltipContent } from '@slayzone/ui'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@slayzone/ui'
import { Plus, Pencil, Trash2, Star, Info } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter
} from '@slayzone/ui'
import type {
  TaskTemplate,
  CreateTaskTemplateInput,
  UpdateTaskTemplateInput,
  PanelVisibility
} from '@slayzone/task/shared'
import { BUILTIN_PANEL_IDS } from '@slayzone/task/shared'

const NONE = '__none__'

const PANEL_LABELS: Record<string, string> = {
  terminal: 'Agent',
  browser: 'Browser',
  editor: 'Editor',
  diff: 'Git',
  settings: 'Settings',
  processes: 'Processes',
}

const DEFAULT_PANEL_VISIBILITY: PanelVisibility = {
  terminal: true,
  browser: false,
  diff: false,
  settings: true,
  editor: false,
  assets: false,
  processes: false,
}

interface TemplatesSettingsTabProps {
  projectId: string
}

export function TemplatesSettingsTab({ projectId }: TemplatesSettingsTabProps) {
  const [templates, setTemplates] = useState<TaskTemplate[]>([])
  const [editingTemplate, setEditingTemplate] = useState<TaskTemplate | null>(null)
  const [showDialog, setShowDialog] = useState(false)

  const load = useCallback(() => {
    window.api.taskTemplates.getByProject(projectId).then(setTemplates)
  }, [projectId])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id: string) => {
    await window.api.taskTemplates.delete(id)
    load()
  }

  const handleSetDefault = async (templateId: string, isDefault: boolean) => {
    await window.api.taskTemplates.setDefault(projectId, isDefault ? templateId : null)
    load()
  }

  const openCreate = () => {
    setEditingTemplate(null)
    setShowDialog(true)
  }

  const openEdit = (t: TaskTemplate) => {
    setEditingTemplate(t)
    setShowDialog(true)
  }

  const summarize = (t: TaskTemplate): string => {
    const parts: string[] = []
    if (t.terminal_mode) parts.push(t.terminal_mode)
    if (t.default_priority != null) parts.push(`P${t.default_priority}`)
    if (t.default_status) parts.push(t.default_status)
    if (t.panel_visibility) {
      const open = Object.entries(t.panel_visibility).filter(([, v]) => v).map(([k]) => PANEL_LABELS[k] ?? k)
      if (open.length) parts.push(open.join('+'))
    }
    return parts.join(' \u00b7 ')
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h3 className="text-base font-semibold">Task Templates</h3>
          <p className="text-sm text-muted-foreground mt-1">
            Pre-configure defaults for new tasks. The default template auto-applies when creating tasks.
          </p>
        </div>
        <Button size="sm" variant="outline" className="shrink-0" onClick={openCreate}>
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          New template
        </Button>
      </div>
      <div className="space-y-3">
        <div className="space-y-2">
          {templates.map((t) => (
            <div
              key={t.id}
              className="group rounded-lg border border-border p-3 flex items-center gap-3 hover:bg-muted/30 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-sm">{t.name}</span>
                  {t.is_default && (
                    <span className="text-xs text-primary flex items-center gap-0.5">
                      <Star className="h-3 w-3 fill-current" /> Default
                    </span>
                  )}
                </div>
                {t.description && (
                  <p className="text-xs text-muted-foreground mt-0.5 truncate">{t.description}</p>
                )}
                <p className="text-xs text-muted-foreground mt-0.5">{summarize(t)}</p>
              </div>
              <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-6 w-6"
                  title={t.is_default ? 'Remove default' : 'Set as default'}
                  onClick={() => handleSetDefault(t.id, !t.is_default)}
                >
                  <Star className={`h-3.5 w-3.5 ${t.is_default ? 'fill-current text-primary' : ''}`} />
                </Button>
                <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => openEdit(t)}>
                  <Pencil className="h-3.5 w-3.5" />
                </Button>
                <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => handleDelete(t.id)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
          ))}
          {templates.length === 0 && (
            <p className="text-sm text-muted-foreground">No templates yet. Create one to pre-configure task defaults.</p>
          )}
        </div>
      </div>
      {showDialog && (
        <TemplateFormDialog
          projectId={projectId}
          template={editingTemplate}
          onClose={() => setShowDialog(false)}
          onSaved={load}
        />
      )}
    </div>
  )
}

function SettingLabel({ children, tip }: { children: React.ReactNode; tip: string }) {
  return (
    <span className="text-sm flex items-center gap-1.5">
      {children}
      <Tooltip>
        <TooltipTrigger asChild>
          <Info className="size-3 text-muted-foreground/50 hover:text-muted-foreground shrink-0 cursor-default" />
        </TooltipTrigger>
        <TooltipContent side="top" className="max-w-72 text-xs leading-relaxed">
          {tip}
        </TooltipContent>
      </Tooltip>
    </span>
  )
}

interface TemplateFormDialogProps {
  projectId: string
  template: TaskTemplate | null
  onClose: () => void
  onSaved: () => void
}

function TemplateFormDialog({ projectId, template, onClose, onSaved }: TemplateFormDialogProps) {
  const isEdit = !!template
  const [name, setName] = useState(template?.name ?? '')
  const [description, setDescription] = useState(template?.description ?? '')
  const [terminalMode, setTerminalMode] = useState(template?.terminal_mode ?? NONE)
  const [defaultStatus, setDefaultStatus] = useState(template?.default_status ?? '')
  const [defaultPriority, setDefaultPriority] = useState<string>(
    template?.default_priority != null ? String(template.default_priority) : NONE
  )
  const [panelVisibility, setPanelVisibility] = useState<PanelVisibility>(
    template?.panel_visibility ?? { ...DEFAULT_PANEL_VISIBILITY }
  )
  const [isDefault, setIsDefault] = useState(template?.is_default ?? false)
  const [saving, setSaving] = useState(false)

  const [modes, setModes] = useState<Array<{ id: string; label: string }>>([])
  useEffect(() => {
    window.api.terminalModes.list().then((m) =>
      setModes(m.filter(mode => mode.enabled).map(mode => ({ id: mode.id, label: mode.label })))
    )
  }, [])

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      if (isEdit && template) {
        const data: UpdateTaskTemplateInput = {
          id: template.id,
          name: name.trim(),
          description: description.trim() || null,
          terminalMode: terminalMode === NONE ? null : terminalMode || null,
          defaultStatus: defaultStatus || null,
          defaultPriority: defaultPriority === NONE ? null : (defaultPriority ? Number(defaultPriority) : null),
          panelVisibility,
          isDefault,
        }
        await window.api.taskTemplates.update(data)
      } else {
        const data: CreateTaskTemplateInput = {
          projectId,
          name: name.trim(),
          description: description.trim() || null,
          terminalMode: terminalMode === NONE ? null : terminalMode || null,
          defaultStatus: defaultStatus || null,
          defaultPriority: defaultPriority === NONE ? null : (defaultPriority ? Number(defaultPriority) : null),
          panelVisibility,
          isDefault,
        }
        await window.api.taskTemplates.create(data)
      }
      onSaved()
      onClose()
    } finally {
      setSaving(false)
    }
  }

  const togglePanel = (panel: string) => {
    setPanelVisibility((prev) => ({ ...prev, [panel]: !prev[panel] }))
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Edit template' : 'New template'}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Name</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Frontend task" autoFocus />
          </div>

          <div className="space-y-1.5">
            <Label>Description</Label>
            <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Optional" />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <SettingLabel tip="Which AI provider to launch when opening the terminal panel.">Terminal mode</SettingLabel>
              <Select value={terminalMode} onValueChange={setTerminalMode}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="System default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>System default</SelectItem>
                  {modes.map((m) => (
                    <SelectItem key={m.id} value={m.id}>{m.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <SettingLabel tip="Initial priority assigned to new tasks created with this template.">Default priority</SettingLabel>
              <Select value={defaultPriority} onValueChange={setDefaultPriority}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="System default" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>System default</SelectItem>
                  <SelectItem value="1">Urgent</SelectItem>
                  <SelectItem value="2">High</SelectItem>
                  <SelectItem value="3">Medium</SelectItem>
                  <SelectItem value="4">Low</SelectItem>
                  <SelectItem value="5">None</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <SettingLabel tip="Initial status column for new tasks. Must match a status ID in the project's task statuses.">Default status</SettingLabel>
            <Input value={defaultStatus} onChange={(e) => setDefaultStatus(e.target.value)} placeholder="System default (e.g. inbox)" />
          </div>

          <div className="space-y-2">
            <SettingLabel tip="Which panels are visible when a task is first opened.">Panels open by default</SettingLabel>
            <div className="rounded-lg border border-border p-3 grid grid-cols-2 gap-2">
              {BUILTIN_PANEL_IDS.map((id) => (
                <label key={id} className="flex items-center gap-2 text-sm cursor-pointer">
                  <Switch
                    checked={panelVisibility[id] ?? false}
                    onCheckedChange={() => togglePanel(id)}
                  />
                  {PANEL_LABELS[id] ?? id}
                </label>
              ))}
            </div>
          </div>

        </div>
        <DialogFooter className="flex items-center justify-between sm:justify-between">
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <Switch
              checked={isDefault}
              onCheckedChange={setIsDefault}
            />
            <SettingLabel tip="Auto-apply this template when creating new tasks in this project.">Project default</SettingLabel>
          </label>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>Cancel</Button>
            <Button onClick={handleSave} disabled={!name.trim() || saving}>
              {isEdit ? 'Save' : 'Create'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
