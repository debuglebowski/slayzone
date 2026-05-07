import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { getTrpcVanillaClient } from '@slayzone/transport/client'
import { Settings, RefreshCw, ChevronRight } from 'lucide-react'
import { Button, Card, Collapsible, CollapsibleTrigger, CollapsibleContent } from '@slayzone/ui'
import type { TestCategory, ScanResult, TestLabel, TestFileLabel, TestFileNote } from '../shared/types'
import { TestFileRow } from './TestFileRow'

interface TestPanelProps {
  projectId: string | null
  projectPath: string | null
  groupBy: 'none' | 'path' | 'label'
  onOpenSettings: () => void
}

interface DirNode {
  name: string
  children: Map<string, DirNode>
  files: string[]
}

function buildPathTree(paths: string[]): DirNode {
  const root: DirNode = { name: '', children: new Map(), files: [] }
  for (const p of paths) {
    const parts = p.split('/')
    parts.pop()
    let node = root
    for (const dir of parts) {
      if (!node.children.has(dir)) {
        node.children.set(dir, { name: dir, children: new Map(), files: [] })
      }
      node = node.children.get(dir)!
    }
    node.files.push(p)
  }
  return root
}

function collapseTree(node: DirNode): DirNode {
  // Collapse single-child directories
  const collapsed = new Map<string, DirNode>()
  for (const [name, child] of node.children) {
    let current = child
    let combinedName = name
    while (current.children.size === 1 && current.files.length === 0) {
      const [nextName, nextChild] = current.children.entries().next().value!
      combinedName += '/' + nextName
      current = nextChild
    }
    collapsed.set(combinedName, collapseTree({ ...current, name: combinedName }))
  }
  return { ...node, children: collapsed }
}

export function TestPanel({ projectId, projectPath, groupBy, onOpenSettings }: TestPanelProps): React.JSX.Element {
  const [categories, setCategories] = useState<TestCategory[]>([])
  const [scanResult, setScanResult] = useState<ScanResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [labels, setLabels] = useState<TestLabel[]>([])
  const [fileLabels, setFileLabels] = useState<TestFileLabel[]>([])
  const [fileNotes, setFileNotes] = useState<TestFileNote[]>([])
  const requestIdRef = useRef(0)

  const fileLabelMap = useMemo(() => {
    const map = new Map<string, Set<string>>()
    for (const fl of fileLabels) {
      if (!map.has(fl.file_path)) map.set(fl.file_path, new Set())
      map.get(fl.file_path)!.add(fl.label_id)
    }
    return map
  }, [fileLabels])

  const fileNoteMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const fn of fileNotes) map.set(fn.file_path, fn.note)
    return map
  }, [fileNotes])

  const reloadLabels = useCallback(async () => {
    if (!projectId) return
    const id = ++requestIdRef.current
    const [lbls, fls, fns] = await Promise.all([
      getTrpcVanillaClient().testPanel.getLabels.query({ projectId: projectId }),
      getTrpcVanillaClient().testPanel.getFileLabels.query({ projectId: projectId }),
      getTrpcVanillaClient().testPanel.getFileNotes.query({ projectId: projectId })
    ])
    if (requestIdRef.current === id) {
      setLabels(lbls)
      setFileLabels(fls)
      setFileNotes(fns)
    }
  }, [projectId])

  const rescanFiles = useCallback(async () => {
    if (!projectId || !projectPath) return
    const id = ++requestIdRef.current
    setLoading(true)
    try {
      const [cats, scan, lbls, fls, fns] = await Promise.all([
        getTrpcVanillaClient().testPanel.getCategories.query({ projectId: projectId }),
        getTrpcVanillaClient().testPanel.scanFiles.query({ projectPath, projectId }),
        getTrpcVanillaClient().testPanel.getLabels.query({ projectId: projectId }),
        getTrpcVanillaClient().testPanel.getFileLabels.query({ projectId: projectId }),
        getTrpcVanillaClient().testPanel.getFileNotes.query({ projectId: projectId })
      ])
      if (requestIdRef.current === id) {
        setCategories(cats)
        setScanResult(scan)
        setLabels(lbls)
        setFileLabels(fls)
        setFileNotes(fns)
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

  const handleToggleLabel = async (filePath: string, labelId: string) => {
    if (!projectId) return
    await getTrpcVanillaClient().testPanel.toggleFileLabel.mutate({ projectId, filePath, labelId })
    reloadLabels()
  }

  const handleSetNote = async (filePath: string, note: string) => {
    if (!projectId) return
    await getTrpcVanillaClient().testPanel.setFileNote.mutate({ projectId, filePath, note })
    reloadLabels()
  }

  if (!projectId || !projectPath) {
    return (
      <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
        Select a project to view tests
      </div>
    )
  }

  const getFileLabelsForPath = (path: string): TestLabel[] => {
    const ids = fileLabelMap.get(path)
    if (!ids) return []
    return labels.filter((l) => ids.has(l.id))
  }

  const renderFileRow = (path: string) => (
    <TestFileRow
      key={path}
      path={path}
      note={fileNoteMap.get(path) ?? ''}
      fileLabels={getFileLabelsForPath(path)}
      labels={labels}
      onToggleLabel={(id) => handleToggleLabel(path, id)}
      onNoteChange={(note) => handleSetNote(path, note)}
      onManageLabels={onOpenSettings}
    />
  )

  const renderFiles = (files: string[]) => {
    if (files.length === 0) {
      return <p className="text-xs text-muted-foreground px-2 py-1">No matching files</p>
    }
    return <>{[...files].sort().map((path) => renderFileRow(path))}</>
  }

  const renderLabelComboGroups = (files: string[]) => {
    // Group by exact label combination — "Core + Terminal" ≠ "Core"
    const groups = new Map<string, { labelIds: string[]; files: string[] }>()
    const unlabeled: string[] = []

    for (const path of files) {
      const ids = fileLabelMap.get(path)
      if (ids && ids.size > 0) {
        const sorted = [...ids].sort()
        const key = sorted.join('+')
        if (!groups.has(key)) groups.set(key, { labelIds: sorted, files: [] })
        groups.get(key)!.files.push(path)
      } else {
        unlabeled.push(path)
      }
    }

    // Sort groups by first label's sort_order
    const labelIndex = new Map(labels.map((l) => [l.id, l]))
    const sortedGroups = [...groups.values()].sort((a, b) => {
      const aFirst = labelIndex.get(a.labelIds[0])
      const bFirst = labelIndex.get(b.labelIds[0])
      return (aFirst?.sort_order ?? 0) - (bFirst?.sort_order ?? 0)
    })

    return (
      <>
        {sortedGroups.map((group) => {
          const groupLabels = group.labelIds.map((id) => labelIndex.get(id)).filter(Boolean) as TestLabel[]
          const name = groupLabels.map((l) => l.name).join(' + ')
          const key = group.labelIds.join('+')
          return (
            <Collapsible key={key} defaultOpen>
              <CollapsibleTrigger asChild>
                <Card className="flex-row items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted/50 group/trigger">
                  <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90" />
                  <div className="flex items-center gap-1">
                    {groupLabels.map((l) => (
                      <div key={l.id} className="h-2 w-2 rounded-full shrink-0" style={{ backgroundColor: l.color }} />
                    ))}
                  </div>
                  <span className="text-xs font-medium">{name}</span>
                  <span className="text-xs text-muted-foreground">{group.files.length}</span>
                </Card>
              </CollapsibleTrigger>
              <CollapsibleContent>
                <div className="ml-3 border-l border-border pl-3 flex flex-col gap-2 pt-2 pb-1">
                  {renderFiles(group.files)}
                </div>
              </CollapsibleContent>
            </Collapsible>
          )
        })}
        {unlabeled.length > 0 && (
          <Collapsible defaultOpen>
            <CollapsibleTrigger asChild>
              <Card className="flex-row items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted/50 group/trigger">
                <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90" />
                <div className="h-2 w-2 rounded-full shrink-0 border border-dashed border-muted-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Unlabeled</span>
                <span className="text-xs text-muted-foreground">{unlabeled.length}</span>
              </Card>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <div className="ml-3 border-l border-border pl-3 flex flex-col gap-2 pt-2 pb-1">
                {renderFiles(unlabeled)}
              </div>
            </CollapsibleContent>
          </Collapsible>
        )}
      </>
    )
  }

  const renderFileList = (files: string[]) => {
    if (files.length === 0) {
      return <p className="text-xs text-muted-foreground px-2 py-1">No matching files</p>
    }

    if (groupBy === 'none') return <div className="flex flex-col gap-2">{renderFiles(files)}</div>
    if (groupBy === 'label') return <div className="flex flex-col gap-2">{renderLabelComboGroups(files)}</div>

    // Path grouping
    const tree = collapseTree(buildPathTree(files))
    return <div className="flex flex-col gap-2">{renderDirNode(tree, true)}</div>
  }

  const renderDirNode = (node: DirNode, isRoot: boolean): React.ReactNode => {
    const leafContent = (
      <div className="flex flex-col gap-2">
        {node.files.length > 0 && <div className="flex flex-col gap-2">{renderFiles(node.files)}</div>}
        {Array.from(node.children.values()).map((child) => renderDirNode(child, false))}
      </div>
    )

    if (isRoot) return leafContent

    return (
      <Collapsible key={node.name} defaultOpen>
        <CollapsibleTrigger asChild>
          <Card className="flex-row items-center gap-1.5 px-3 py-1.5 cursor-pointer hover:bg-muted/50 group/trigger">
            <ChevronRight className="h-3 w-3 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90" />
            <span className="text-xs font-medium text-muted-foreground">{node.name}/</span>
          </Card>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="ml-3 border-l border-border pl-3 pt-2 pb-1">
            {leafContent}
          </div>
        </CollapsibleContent>
      </Collapsible>
    )
  }

  const singleCategory = categories.length === 1

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
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onOpenSettings}>
            <Settings className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {categories.length === 0 ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-2">
            <p className="text-sm text-muted-foreground">No test categories configured</p>
            <Button variant="outline" size="sm" onClick={onOpenSettings}>
              Configure Categories
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-3 flex flex-col gap-2">
          {categories.map((cat) => {
            const files = filesByCategory.get(cat.id) ?? []
            if (singleCategory) {
              return <React.Fragment key={cat.id}>{renderFileList(files)}</React.Fragment>
            }
            return (
              <Collapsible key={cat.id} defaultOpen>
                <CollapsibleTrigger asChild>
                  <Card className="flex-row items-center gap-2 px-3 py-1.5 cursor-pointer hover:bg-muted/50 group/trigger">
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 transition-transform group-data-[state=open]/trigger:rotate-90" />
                    <div className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: cat.color }} />
                    <span className="text-sm font-medium">{cat.name}</span>
                    <span className="text-xs text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                      {files.length}
                    </span>
                  </Card>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="ml-3 border-l border-border pl-3 pt-2 pb-1">
                    {renderFileList(files)}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </div>
      )}

    </div>
  )
}
