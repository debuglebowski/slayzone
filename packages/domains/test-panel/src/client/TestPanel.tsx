import { useState, useEffect, useCallback, useRef } from 'react'
import { Settings, RefreshCw, ChevronRight } from 'lucide-react'
import { Button, Collapsible, CollapsibleTrigger, CollapsibleContent } from '@slayzone/ui'
import type { TestCategory, ScanResult } from '../shared/types'
import { TestFileRow } from './TestFileRow'
import { CategoryManager } from './CategoryManager'

interface TestPanelProps {
  projectId: string | null
  projectPath: string | null
}

export function TestPanel({ projectId, projectPath }: TestPanelProps): React.JSX.Element {
  const [categories, setCategories] = useState<TestCategory[]>([])
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [managerOpen, setManagerOpen] = useState(false)
  const requestIdRef = useRef(0)

  const reloadCategories = useCallback(async () => {
    if (!projectId) return
    const id = ++requestIdRef.current
    const cats = await window.api.testPanel.getCategories(projectId)
    if (requestIdRef.current === id) setCategories(cats)
  }, [projectId])

  const rescanFiles = useCallback(async () => {
    if (!projectId || !projectPath) return
    const id = ++requestIdRef.current
    setLoading(true)
    try {
      const [cats, scan] = await Promise.all([
        window.api.testPanel.getCategories(projectId),
        window.api.testPanel.scanFiles(projectPath, projectId)
      ])
      if (requestIdRef.current === id) {
        setCategories(cats)
        setScanResult(scan)
      }
    } finally {
      if (requestIdRef.current === id) setLoading(false)
    }
  }, [projectId, projectPath])

  useEffect(() => { rescanFiles() }, [rescanFiles])

  const filesByCategory = new Map<string, string[]>()
  if (scanResult) {
    for (const cat of categories) filesByCategory.set(cat.id, [])
    for (const match of scanResult.matches) {
      const arr = filesByCategory.get(match.categoryId)
      if (arr) arr.push(match.path)
    }
  }

  if (!projectId || !projectPath) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a project to view tests
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 shrink-0">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold">Tests</h2>
          {scanResult && (
            <span className="text-xs text-muted-foreground">
              {scanResult.matches.length} matched / {scanResult.totalScanned} scanned
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={rescanFiles} disabled={loading}>
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setManagerOpen(true)}>
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {categories.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-2">
            <p className="text-sm text-muted-foreground">No test categories configured</p>
            <Button variant="outline" size="sm" onClick={() => setManagerOpen(true)}>
              Configure Categories
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 space-y-1">
          {categories.map((cat) => {
            const files = filesByCategory.get(cat.id) ?? []
            return (
              <Collapsible key={cat.id} defaultOpen>
                <CollapsibleTrigger className="flex items-center gap-2 w-full px-2 py-1.5 rounded hover:bg-muted/50 group">
                  <ChevronRight className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-90" />
                  <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
                  <span className="text-sm font-medium">{cat.name}</span>
                  <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                    {files.length}
                  </span>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="pl-7 space-y-2 py-1">
                    {files.map((path) => (
                      <TestFileRow key={path} path={path} />
                    ))}
                    {files.length === 0 && (
                      <p className="text-xs text-muted-foreground px-2 py-1">No matching files</p>
                    )}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </div>
      )}

      <CategoryManager
        open={managerOpen}
        onOpenChange={setManagerOpen}
        projectId={projectId}
        categories={categories}
        onCategoriesChanged={reloadCategories}
        onPatternsChanged={rescanFiles}
      />
    </div>
  )
}
