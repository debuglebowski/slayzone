import { lazy, Suspense } from 'react'
import { LayoutGrid, ListTree } from 'lucide-react'
import type { SidebarView } from './types'
import { ProjectsRailView } from './ProjectsRailView'

const TreeView = lazy(() => import('./TreeView').then((m) => ({ default: m.TreeView })))

export const viewRegistry: SidebarView[] = [
  {
    id: 'projects',
    label: 'Projects',
    icon: LayoutGrid,
    width: 'w-18',
    footerLayout: 'vertical',
    render: (ctx) => <ProjectsRailView {...ctx} />
  },
  {
    id: 'tree',
    label: 'Tree',
    icon: ListTree,
    width: 'w-96',
    footerLayout: 'horizontal',
    resizable: true,
    defaultWidth: 384,
    minWidth: 220,
    maxWidth: 720,
    render: (ctx) => (
      <Suspense fallback={<div className="flex-1 animate-pulse bg-sidebar" />}>
        <TreeView {...ctx} />
      </Suspense>
    )
  }
]

export const getView = (id: string): SidebarView =>
  viewRegistry.find((v) => v.id === id) ?? viewRegistry[0]
