import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useTRPC } from '@slayzone/transport/client'
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
  PopoverTrigger
} from '@slayzone/ui'
import { Plus, Trash2, Save } from 'lucide-react'
import type { TestCategory, TestProfile, CreateTestCategoryInput } from '../shared/types'

type GroupBy = 'none' | 'path' | 'label'

interface TestsTabProps {
  projectId: string
  groupBy: GroupBy
  onGroupByChange: (value: GroupBy) => void
}

const CUSTOM_VALUE = '__custom__'
const COLORS = [
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#3b82f6',
  '#8b5cf6',
  '#ec4899',
  '#6b7280'
]

function matchProfile(categories: TestCategory[], profiles: TestProfile[]): string {
  for (const p of profiles) {
    if (p.categories.length !== categories.length) continue
    const match = p.categories.every(
      (pc, i) =>
        categories[i] &&
        pc.name === categories[i].name &&
        pc.pattern === categories[i].pattern &&
        pc.color === categories[i].color
    )
    if (match) return p.id
  }
  return CUSTOM_VALUE
}

export function TestsTab({
  projectId,
  groupBy,
  onGroupByChange
}: TestsTabProps): React.JSX.Element {
  const trpc = useTRPC()
  const queryClient = useQueryClient()

  const categoriesQuery = useQuery(trpc.testPanel.getCategories.queryOptions({ projectId }))
  const labelsQuery = useQuery(trpc.testPanel.getLabels.queryOptions({ projectId }))
  const profilesQuery = useQuery(trpc.testPanel.getProfiles.queryOptions())

  const categories = categoriesQuery.data ?? []
  const labels = labelsQuery.data ?? []
  const profiles = profilesQuery.data ?? []

  const invalidateCategories = () =>
    queryClient.invalidateQueries(trpc.testPanel.getCategories.queryFilter({ projectId }))
  const invalidateLabels = () =>
    queryClient.invalidateQueries(trpc.testPanel.getLabels.queryFilter({ projectId }))
  const invalidateProfiles = () =>
    queryClient.invalidateQueries(trpc.testPanel.getProfiles.queryFilter())

  const applyProfileMutation = useMutation(
    trpc.testPanel.applyProfile.mutationOptions({
      onSuccess: () => {
        invalidateCategories()
        invalidateLabels()
        invalidateProfiles()
      }
    })
  )
  const createCategoryMutation = useMutation(
    trpc.testPanel.createCategory.mutationOptions({
      onSuccess: () => {
        invalidateCategories()
        invalidateLabels()
        invalidateProfiles()
      }
    })
  )
  const updateCategoryMutation = useMutation(
    trpc.testPanel.updateCategory.mutationOptions({
      onSuccess: () => {
        invalidateCategories()
        invalidateLabels()
        invalidateProfiles()
      }
    })
  )
  const deleteCategoryMutation = useMutation(
    trpc.testPanel.deleteCategory.mutationOptions({
      onSuccess: () => {
        invalidateCategories()
        invalidateLabels()
        invalidateProfiles()
      }
    })
  )
  const saveProfileMutation = useMutation(
    trpc.testPanel.saveProfile.mutationOptions({
      onSuccess: () => invalidateProfiles()
    })
  )
  const deleteProfileMutation = useMutation(
    trpc.testPanel.deleteProfile.mutationOptions({
      onSuccess: () => invalidateProfiles()
    })
  )
  const createLabelMutation = useMutation(
    trpc.testPanel.createLabel.mutationOptions({
      onSuccess: () => {
        invalidateCategories()
        invalidateLabels()
        invalidateProfiles()
      }
    })
  )
  const updateLabelMutation = useMutation(
    trpc.testPanel.updateLabel.mutationOptions({
      onSuccess: () => {
        invalidateCategories()
        invalidateLabels()
        invalidateProfiles()
      }
    })
  )
  const deleteLabelMutation = useMutation(
    trpc.testPanel.deleteLabel.mutationOptions({
      onSuccess: () => {
        invalidateCategories()
        invalidateLabels()
        invalidateProfiles()
      }
    })
  )

  const selectedProfile = matchProfile(categories, profiles)

  const handleProfileChange = async (value: string) => {
    if (value !== CUSTOM_VALUE && value !== '') {
      await applyProfileMutation.mutateAsync({ projectId, profileId: value })
    }
  }

  const addCategory = async () => {
    const input: CreateTestCategoryInput = {
      project_id: projectId,
      name: 'New Category',
      pattern: '**/*.test.ts'
    }
    await createCategoryMutation.mutateAsync(input)
  }

  const categoryIdsRef = useRef(new Set<string>())
  useEffect(() => {
    categoryIdsRef.current = new Set(categories.map((c) => c.id))
  }, [categories])

  const updateCategory = async (id: string, field: string, value: string | number) => {
    if (!categoryIdsRef.current.has(id)) return
    await updateCategoryMutation.mutateAsync({ id, [field]: value })
  }

  const deleteCategory = async (id: string) => {
    await deleteCategoryMutation.mutateAsync({ id })
  }

  const [savePopoverOpen, setSavePopoverOpen] = useState(false)

  const saveAsProfile = async (name: string) => {
    if (!name.trim()) return
    const profile: TestProfile = {
      id: crypto.randomUUID(),
      name: name.trim(),
      categories: categories.map((c) => ({ name: c.name, pattern: c.pattern, color: c.color }))
    }
    await saveProfileMutation.mutateAsync(profile)
    setSavePopoverOpen(false)
  }

  const deleteProfile = async (id: string) => {
    await deleteProfileMutation.mutateAsync({ id })
  }

  const addLabel = async () => {
    await createLabelMutation.mutateAsync({ project_id: projectId, name: 'New Label' })
  }

  const updateLabel = async (id: string, field: string, value: string | number) => {
    await updateLabelMutation.mutateAsync({ id, [field]: value })
  }

  const deleteLabel = async (id: string) => {
    await deleteLabelMutation.mutateAsync({ id })
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
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 shrink-0"
                  onClick={() => deleteProfile(selectedProfile)}
                  title="Delete profile"
                >
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
                    <form
                      onSubmit={(e) => {
                        e.preventDefault()
                        const fd = new FormData(e.currentTarget)
                        saveAsProfile(fd.get('name') as string)
                      }}
                      className="flex items-center gap-2"
                    >
                      <Input
                        name="name"
                        className="h-8 text-sm"
                        placeholder="Profile name"
                        autoFocus
                      />
                      <Button type="submit" size="sm" className="h-8 shrink-0">
                        Save
                      </Button>
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
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={addCategory}
                title="Add category"
              >
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
                  if (e.target.value !== cat.pattern)
                    updateCategory(cat.id, 'pattern', e.target.value)
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => deleteCategory(cat.id)}
              >
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
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 shrink-0"
              onClick={addLabel}
              title="Add label"
            >
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
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 shrink-0"
                onClick={() => deleteLabel(label.id)}
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  )
}
