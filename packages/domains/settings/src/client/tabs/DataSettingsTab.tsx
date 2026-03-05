import { useState, useEffect } from 'react'
import { FolderOpen } from 'lucide-react'
import { Button, IconButton, Input, Label, Select, SelectContent, SelectItem, SelectTrigger, SelectValue, toast } from '@slayzone/ui'
import { SettingsTabIntro } from './SettingsTabIntro'

export function DataSettingsTab() {
  const [projects, setProjects] = useState<Array<{ id: string; name: string }>>([])
  const [exportProjectId, setExportProjectId] = useState('')
  const [importedProjects, setImportedProjects] = useState<Array<{ id: string; name: string; path: string }>>([])

  useEffect(() => {
    window.api.db.getProjects().then(setProjects)
  }, [])

  return (
    <div className="space-y-6">
      <SettingsTabIntro
        title="Import & Export"
        description="Back up your local data or migrate tasks between projects. Data is exported as a .slay file for portability."
      />
      <div className="space-y-3">
        <Label className="text-base font-semibold">Export</Label>
        <div className="flex items-center gap-3">
          <Select value={exportProjectId} onValueChange={setExportProjectId}>
            <SelectTrigger className="w-full max-w-sm">
              <SelectValue placeholder="Select project" />
            </SelectTrigger>
            <SelectContent>
              {projects.map((p) => (
                <SelectItem key={p.id} value={p.id}>{p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            variant="outline"
            disabled={!exportProjectId}
            onClick={async () => {
              const result = await window.api.exportImport.exportProject(exportProjectId)
              if (result.canceled) return
              if (result.success) toast.success(`Exported to ${result.path}`)
              else toast.error(`Export failed: ${result.error}`)
            }}
          >
            Export Project
          </Button>
        </div>
      </div>

      <div className="space-y-3">
        <Label className="text-base font-semibold">Import</Label>
        <Button
          variant="outline"
          onClick={async () => {
            const result = await window.api.exportImport.import()
            if (result.canceled) return
            if (result.success) {
              toast.success(`Imported ${result.projectCount} project(s), ${result.taskCount} task(s)`)
              if (result.importedProjects?.length) {
                setImportedProjects(result.importedProjects.map((p: any) => ({ ...p, path: '' })))
              }
            } else {
              toast.error(`Import failed: ${result.error}`)
            }
          }}
        >
          Import .slay
        </Button>
      </div>

      {importedProjects.length > 0 && (
        <div className="space-y-3">
          <Label className="text-base font-semibold">Set Project Paths</Label>
          {importedProjects.map((p, i) => (
            <div key={p.id} className="space-y-1">
              <span className="text-sm font-medium">{p.name}</span>
              <div className="flex items-center gap-2">
                <Input
                  className="flex-1 max-w-lg"
                  placeholder="/path/to/repo"
                  value={p.path}
                  onChange={(e) => {
                    setImportedProjects((prev: any[]) =>
                      prev.map((proj, j) => (j === i ? { ...proj, path: e.target.value } : proj))
                    )
                  }}
                />
                <IconButton
                  type="button"
                  variant="outline"
                  aria-label="Browse folder"
                  onClick={async () => {
                    const result = await window.api.dialog.showOpenDialog({
                      title: 'Select Project Directory',
                      defaultPath: p.path || undefined,
                      properties: ['openDirectory']
                    })
                    if (!result.canceled && result.filePaths[0]) {
                      setImportedProjects((prev: any[]) =>
                        prev.map((proj, j) => (j === i ? { ...proj, path: result.filePaths[0] } : proj))
                      )
                    }
                  }}
                >
                  <FolderOpen className="size-4" />
                </IconButton>
              </div>
            </div>
          ))}
          <div className="flex gap-2">
            <Button
              onClick={async () => {
                for (const p of importedProjects) {
                  if (p.path.trim()) {
                    await window.api.db.updateProject({ id: p.id, path: p.path.trim() })
                  }
                }
                const saved = importedProjects.filter((p) => p.path.trim()).length
                if (saved > 0) toast.success(`Set paths for ${saved} project(s)`)
                setImportedProjects([])
              }}
            >
              Save Paths
            </Button>
            <Button variant="ghost" onClick={() => setImportedProjects([])}>
              Skip
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
