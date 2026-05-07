import { useState, useEffect, useRef, useCallback } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import {
  Input,
  Button,
  Separator,
  Card,
  CardAction,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@slayzone/ui'
import { Plus, Trash2, Save } from 'lucide-react'
import type { TestCategory, TestProfile, CreateTestCategoryInput, TestLabel } from '../shared/types'

type GroupBy = 'none' | 'path' | 'label'

interface TestsTabProps {
  projectId: string
  groupBy: GroupBy
  onGroupByChange: (value: GroupBy) => void
}

const CUSTOM_VALUE = '__custom__'
const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280']

function matchProfile(categories: TestCategory[], profiles: TestProfile[]): string {
  for (const p of profiles) {
    if (p.categories.length !== categories.length) continue
    const match = p.categories.every((pc, i) =>
      categories[i] && pc.name === categories[i].name && pc.pattern === categories[i].pattern && pc.color === categories[i].color
    )
    if (match) return p.id
  }
  return CUSTOM_VALUE
}

export function TestsTab({ projectId, groupBy, onGroupByChange }: TestsTabProps): React.JSX.Element {
  const [profiles, setProfiles] = useState<TestProfile[]>([])
  const [categories, setCategories] = useState<TestCategory[]>([])
  const [labels, setLabels] = useState<TestLabel[]>([])

  const reload = useCallback(async () => {
    const [cats, lbls, profs] = await Promise.all([
      getTrpcVanillaClient().testPanel.getCategories.query({ projectId: projectId }),
      getTrpcVanillaClient().testPanel.getLabels.query({ projectId: projectId }),
      getTrpcVanillaClient().testPanel.getProfiles.query()
    ])
    setCategories(cats)
    setLabels(lbls)
    setProfiles(profs)
  }, [projectId])

  useEffect(() => { reload() }, [reload])

  const selectedProfile = matchProfile(categories, profiles)

  const handleProfileChange = async (value: string) => {
    if (value !== CUSTOM_VALUE && value !== '') {
      await getTrpcVanillaClient().testPanel.applyProfile.mutate({ projectId, profileId: value })
      reload()
    }
  }

  const addCategory = async () => {
    const input: CreateTestCategoryInput = {
      project_id: projectId,
      name: 'New Category',
      pattern: '**/*.test.ts'
    }
    await getTrpcVanillaClient().testPanel.createCategory.mutate(input)
    reload()
  }

  const categoryIdsRef = useRef(new Set<string>())
  useEffect(() => {
    categoryIdsRef.current = new Set(categories.map((c) => c.id))
  }, [categories])

  const updateCategory = async (id: string, field: string, value: string | number) => {
    if (!categoryIdsRef.current.has(id)) return
    await getTrpcVanillaClient().testPanel.updateCategory.mutate({ id, [field]: value })
    reload()
  }

  const deleteCategory = async (id: string) => {
    await getTrpcVanillaClient().testPanel.deleteCategory.mutate({ id: id })
    reload()
  }

  const [savePopoverOpen, setSavePopoverOpen] = useState(false)

  const saveAsProfile = async (name: string) => {
    if (!name.trim()) return
    const profile: TestProfile = {
      id: crypto.randomUUID(),
      name: name.trim(),
      categories: categories.map((c) => ({ name: c.name, pattern: c.pattern, color: c.color }))
    }
    await getTrpcVanillaClient().testPanel.saveProfile.mutate(profile)
    setProfiles(await getTrpcVanillaClient().testPanel.getProfiles.query())
    setSavePopoverOpen(false)
  }

  const deleteProfile = async (id: string) => {
    await getTrpcVanillaClient().testPanel.deleteProfile.mutate({ id: id })
    setProfiles(await getTrpcVanillaClient().testPanel.getProfiles.query())
  }

  const addLabel = async () => {
    await getTrpcVanillaClient().testPanel.createLabel.mutate({ project_id: projectId, name: 'New Label' })
    reload()
  }

  const updateLabel = async (id: string, field: string, value: string | number) => {
    await getTrpcVanillaClient().testPanel.updateLabel.mutate({ id, [field]: value })
    reload()
  }

  const deleteLabel = async (id: string) => {
    await getTrpcVanillaClient().testPanel.deleteLabel.mutate({ id: id })
    reload()
  }

  const builtinProfiles = profiles.filter((p) => p.id.startsWith('builtin:'))
  const userProfiles = profiles.filter((p) => !p.id.startsWith('builtin:'))

  return (
    <div className="space-y-6">
      {/* Group by */}
      <div className="space-y-2">
        <label className="text-sm font-medium">Group by</label>
        <p className="text-xs text-muted-foreground">How test files are organized in the panel.</p>
        <Select value={groupBy} onValueChange={(v) => onGroupByChange(v as GroupBy)}>
          <SelectTrigger className="h-8 text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">None</SelectItem>
            <SelectItem value="path">File path</SelectItem>
            <SelectItem value="label">Labels</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Separator />

      {/* Categories */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="text-sm">Categories</CardTitle>
            <CardDescription>Glob patterns to discover test files.</CardDescription>
          </div>
          <CardAction>
            <div className="flex items-center gap-2">
              {userProfiles.some((p) => p.id === selectedProfile) && (
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => deleteProfile(selectedProfile)} title="Delete profile">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
              {categories.length > 0 && selectedProfile === CUSTOM_VALUE && (
                <Popover open={savePopoverOpen} onOpenChange={setSavePopoverOpen}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <PopoverTrigger asChild>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0">
                          <Save className="h-3.5 w-3.5" />
                        </Button>
                      </PopoverTrigger>
                    </TooltipTrigger>
                    <TooltipContent>Save as profile</TooltipContent>
                  </Tooltip>
                  <PopoverContent className="w-64 p-3" align="end">
                    <form onSubmit={(e) => { e.preventDefault(); const fd = new FormData(e.currentTarget); saveAsProfile(fd.get('name') as string) }} className="flex items-center gap-2">
                      <Input name="name" className="h-8 text-sm" placeholder="Profile name" autoFocus />
                      <Button type="submit" size="sm" className="h-8 shrink-0">Save</Button>
                    </form>
                  </PopoverContent>
                </Popover>
              )}
              <Select value={selectedProfile} onValueChange={handleProfileChange}>
                <SelectTrigger className="h-8 text-sm w-56">
                  <SelectValue placeholder="Select a profile..." />
                </SelectTrigger>
                <SelectContent>
                  {builtinProfiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} — {p.categories.map((c) => c.name).join(', ')}
                    </SelectItem>
                  ))}
                  {userProfiles.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.name} — {p.categories.map((c) => c.name).join(', ')}
                    </SelectItem>
                  ))}
                  <SelectItem value={CUSTOM_VALUE}>Custom</SelectItem>
                </SelectContent>
              </Select>
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={addCategory} title="Add category">
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </div>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {categories.map((cat) => (
            <div key={cat.id} className="flex items-center gap-2">
              <button
                className="h-6 w-6 rounded-full border border-border shrink-0"
                style={{ backgroundColor: cat.color }}
                onClick={() => {
                  const idx = COLORS.indexOf(cat.color)
                  updateCategory(cat.id, 'color', COLORS[(idx + 1) % COLORS.length])
                }}
              />
              <Input
                className="h-8 text-sm flex-1"
                defaultValue={cat.name}
                placeholder="Name"
                onBlur={(e) => {
                  if (e.target.value !== cat.name) updateCategory(cat.id, 'name', e.target.value)
                }}
              />
              <Input
                className="h-8 text-sm flex-1 font-mono"
                defaultValue={cat.pattern}
                placeholder="e.g. **/*.test.ts"
                onBlur={(e) => {
                  if (e.target.value !== cat.pattern) updateCategory(cat.id, 'pattern', e.target.value)
                }}
              />
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => deleteCategory(cat.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Labels */}
      <Card>
        <CardHeader>
          <div>
            <CardTitle className="text-sm">Labels</CardTitle>
            <CardDescription>Manually tag test files.</CardDescription>
          </div>
          <CardAction>
            <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={addLabel} title="Add label">
              <Plus className="h-3.5 w-3.5" />
            </Button>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-3">
          {labels.map((label) => (
            <div key={label.id} className="flex items-center gap-2">
              <button
                className="h-6 w-6 rounded-full border border-border shrink-0"
                style={{ backgroundColor: label.color }}
                onClick={() => {
                  const idx = COLORS.indexOf(label.color)
                  updateLabel(label.id, 'color', COLORS[(idx + 1) % COLORS.length])
                }}
              />
              <Input
                className="h-8 text-sm flex-1"
                defaultValue={label.name}
                placeholder="Label name"
                onBlur={(e) => {
                  if (e.target.value !== label.name) updateLabel(label.id, 'name', e.target.value)
                }}
              />
              <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => deleteLabel(label.id)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
