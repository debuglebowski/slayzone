import { useState, useEffect, useRef } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Input,
  Button,
  Separator,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@slayzone/ui'
import { Plus, Trash2, Save } from 'lucide-react'
import type { TestCategory, TestProfile, CreateTestCategoryInput, TestLabel } from '../shared/types'

interface CategoryManagerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  categories: TestCategory[]
  labels: TestLabel[]
  onCategoriesChanged: () => void
  onPatternsChanged: () => void
  onLabelsChanged: () => void
}

const CUSTOM_VALUE = '__custom__'
const COLORS = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280']

const DEFAULT_STARTER_LABELS = [
  { name: 'Core', color: '#3b82f6' },
  { name: 'Advanced', color: '#8b5cf6' },
  { name: 'Experimental', color: '#f97316' },
]

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

export function CategoryManager({ open, onOpenChange, projectId, categories, labels, onCategoriesChanged, onPatternsChanged, onLabelsChanged }: CategoryManagerProps): React.JSX.Element {
  const [profiles, setProfiles] = useState<TestProfile[]>([])
  const [profileName, setProfileName] = useState('')
  const [labelsInitialized, setLabelsInitialized] = useState(false)

  useEffect(() => {
    if (open) {
      window.api.testPanel.getProfiles().then(setProfiles)
    }
    if (!open) setLabelsInitialized(false)
  }, [open])

  const selectedProfile = matchProfile(categories, profiles)

  useEffect(() => {
    if (open && labels.length === 0 && !labelsInitialized) {
      setLabelsInitialized(true)
      ;(async () => {
        for (const starter of DEFAULT_STARTER_LABELS) {
          await window.api.testPanel.createLabel({ project_id: projectId, name: starter.name, color: starter.color })
        }
        onLabelsChanged()
      })()
    }
  }, [open, labels.length, labelsInitialized, projectId, onLabelsChanged])

  const handleProfileChange = async (value: string) => {
    if (value !== CUSTOM_VALUE && value !== '') {
      await window.api.testPanel.applyProfile(projectId, value)
      onPatternsChanged()
    }
  }

  const addCategory = async () => {
    const input: CreateTestCategoryInput = {
      project_id: projectId,
      name: 'New Category',
      pattern: '**/*.test.ts'
    }
    await window.api.testPanel.createCategory(input)
    onPatternsChanged()
  }

  const categoryIdsRef = useRef(new Set<string>())
  useEffect(() => {
    categoryIdsRef.current = new Set(categories.map((c) => c.id))
  }, [categories])

  const updateCategory = async (id: string, field: string, value: string | number) => {
    // Guard against stale onBlur from unmounted inputs (e.g. after profile switch)
    if (!categoryIdsRef.current.has(id)) return
    await window.api.testPanel.updateCategory({ id, [field]: value })
    if (field === 'pattern') onPatternsChanged()
    else onCategoriesChanged()
  }

  const deleteCategory = async (id: string) => {
    await window.api.testPanel.deleteCategory(id)
    onPatternsChanged()
  }

  const saveAsProfile = async () => {
    if (!profileName.trim()) return
    const profile: TestProfile = {
      id: crypto.randomUUID(),
      name: profileName.trim(),
      categories: categories.map((c) => ({ name: c.name, pattern: c.pattern, color: c.color }))
    }
    await window.api.testPanel.saveProfile(profile)
    setProfiles(await window.api.testPanel.getProfiles())
    setProfileName('')
  }

  const deleteProfile = async (id: string) => {
    await window.api.testPanel.deleteProfile(id)
    setProfiles(await window.api.testPanel.getProfiles())
    // profile match is derived, no state to reset
  }

  const addLabel = async () => {
    await window.api.testPanel.createLabel({ project_id: projectId, name: 'New Label' })
    onLabelsChanged()
  }

  const updateLabel = async (id: string, field: string, value: string | number) => {
    await window.api.testPanel.updateLabel({ id, [field]: value })
    onLabelsChanged()
  }

  const deleteLabel = async (id: string) => {
    await window.api.testPanel.deleteLabel(id)
    onLabelsChanged()
  }

  const builtinProfiles = profiles.filter((p) => p.id.startsWith('builtin:'))
  const userProfiles = profiles.filter((p) => !p.id.startsWith('builtin:'))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Test Settings</DialogTitle>
          <DialogDescription>Configure categories and labels for organizing test files.</DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="categories" className="gap-6">
          <TabsList className="w-full">
            <TabsTrigger value="categories">Categories</TabsTrigger>
            <TabsTrigger value="labels">Labels</TabsTrigger>
          </TabsList>

          <TabsContent value="categories">
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Select value={selectedProfile} onValueChange={handleProfileChange}>
                  <SelectTrigger className="h-8 text-sm flex-1">
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
                {userProfiles.some((p) => p.id === selectedProfile) && (
                  <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => deleteProfile(selectedProfile)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                )}
              </div>

              <div className="space-y-3">
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

                <Button variant="outline" size="sm" className="w-full" onClick={addCategory}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add Category
                </Button>
              </div>

              {categories.length > 0 && (
                <>
                  <Separator />
                  <div className="flex items-center gap-2">
                    <Input
                      className="h-8 text-sm flex-1"
                      value={profileName}
                      onChange={(e) => setProfileName(e.target.value)}
                      placeholder="Save as profile..."
                      onKeyDown={(e) => { if (e.key === 'Enter') saveAsProfile() }}
                    />
                    <Button variant="outline" size="sm" onClick={saveAsProfile} disabled={!profileName.trim()}>
                      <Save className="h-3.5 w-3.5 mr-1" /> Save
                    </Button>
                  </div>
                </>
              )}
            </div>
          </TabsContent>

          <TabsContent value="labels">
            <div className="space-y-3">
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

              <Button variant="outline" size="sm" className="w-full" onClick={addLabel}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Label
              </Button>
            </div>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
