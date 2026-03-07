import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Input,
  Button,
  Separator
} from '@slayzone/ui'
import { Plus, Trash2, Save, ArrowLeft } from 'lucide-react'
import type { TestCategory, TestProfile, CreateTestCategoryInput } from '../shared/types'

interface CategoryManagerProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  categories: TestCategory[]
  onCategoriesChanged: () => void
  onPatternsChanged: () => void
}

export function CategoryManager({ open, onOpenChange, projectId, categories, onCategoriesChanged, onPatternsChanged }: CategoryManagerProps): React.JSX.Element {
  const [view, setView] = useState<'select' | 'edit'>('select')
  const [profiles, setProfiles] = useState<TestProfile[]>([])
  const [profileName, setProfileName] = useState('')

  useEffect(() => {
    if (open) {
      setView(categories.length > 0 ? 'edit' : 'select')
      window.api.testPanel.getProfiles().then(setProfiles)
    }
  }, [open, categories.length])

  const applyProfile = async (profileId: string) => {
    await window.api.testPanel.applyProfile(projectId, profileId)
    onPatternsChanged()
    onOpenChange(false)
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

  const updateCategory = async (id: string, field: string, value: string | number) => {
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
  }

  const builtinProfiles = profiles.filter((p) => p.id.startsWith('builtin:'))
  const userProfiles = profiles.filter((p) => !p.id.startsWith('builtin:'))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
        {view === 'select' ? (
          <>
            <DialogHeader>
              <DialogTitle>Choose a Profile</DialogTitle>
              <DialogDescription>Select a profile to categorize your test files, or create a custom configuration.</DialogDescription>
            </DialogHeader>

            <div className="space-y-4 mt-2">
              <div className="grid grid-cols-2 gap-3">
                {builtinProfiles.map((p) => (
                  <button
                    key={p.id}
                    className="flex flex-col items-start gap-1 rounded-lg border border-border p-4 text-left hover:bg-muted/50 transition-colors"
                    onClick={() => applyProfile(p.id)}
                  >
                    <span className="text-sm font-medium">{p.name}</span>
                    <span className="text-xs text-muted-foreground">
                      {p.categories.map((c) => c.name).join(', ')}
                    </span>
                  </button>
                ))}
              </div>

              {userProfiles.length > 0 && (
                <>
                  <Separator />
                  <h4 className="text-sm font-medium text-muted-foreground">Your Profiles</h4>
                  <div className="grid grid-cols-2 gap-3">
                    {userProfiles.map((p) => (
                      <div key={p.id} className="flex items-center gap-2">
                        <button
                          className="flex-1 flex flex-col items-start gap-1 rounded-lg border border-border p-4 text-left hover:bg-muted/50 transition-colors"
                          onClick={() => applyProfile(p.id)}
                        >
                          <span className="text-sm font-medium">{p.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {p.categories.map((c) => c.name).join(', ')}
                          </span>
                        </button>
                        <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" onClick={() => deleteProfile(p.id)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                </>
              )}

              <Separator />
              <Button variant="outline" className="w-full" onClick={() => setView('edit')}>
                Custom...
              </Button>
            </div>
          </>
        ) : (
          <>
            <DialogHeader>
              <div className="flex items-center gap-2">
                <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => setView('select')}>
                  <ArrowLeft className="h-4 w-4" />
                </Button>
                <div>
                  <DialogTitle>Test Categories</DialogTitle>
                  <DialogDescription>Define glob patterns to categorize test files.</DialogDescription>
                </div>
              </div>
            </DialogHeader>

            <div className="space-y-3 mt-2">
              {categories.map((cat) => (
                <div key={cat.id} className="flex items-center gap-2">
                  <button
                    className="h-6 w-6 rounded-full border border-border shrink-0"
                    style={{ backgroundColor: cat.color }}
                    onClick={() => {
                      const colors = ['#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899', '#6b7280']
                      const idx = colors.indexOf(cat.color)
                      updateCategory(cat.id, 'color', colors[(idx + 1) % colors.length])
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
                <Separator className="my-3" />
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
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
