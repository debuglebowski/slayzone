import {
  FolderPlus,
  History,
  Home,
  Megaphone,
  PanelRight,
  Settings,
  SquarePen,
  Zap,
  type LucideIcon
} from 'lucide-react'
import type { ActionId, FilterKind, SearchItem } from './SearchDialog.types'

export const MAX_RESULTS = 50
export const MAX_RECENT = 4

export const FILTERS: { id: FilterKind; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'actions', label: 'Actions' },
  { id: 'files', label: 'Files' },
  { id: 'tasks', label: 'Tasks' },
  { id: 'projects', label: 'Projects' }
]

export const KIND_WEIGHT: Record<SearchItem['kind'], number> = {
  action: 1.05,
  file: 1.0,
  task: 0.95,
  project: 0.9
}

export const BASENAME_BOOST = 1.5

export const ACTION_DEFS: {
  id: ActionId
  label: string
  sublabel: string
  shortcutId?: string
  featured?: boolean
}[] = [
  {
    id: 'new-task',
    label: 'New task',
    sublabel: 'Create a task',
    shortcutId: 'new-task',
    featured: true
  },
  {
    id: 'new-temp-task',
    label: 'New temporary task',
    sublabel: 'Open a scratch terminal',
    shortcutId: 'new-temp-task',
    featured: true
  },
  {
    id: 'reopen-closed-tab',
    label: 'Reopen last closed tab',
    sublabel: 'Restore the most recently closed task',
    shortcutId: 'reopen-closed-tab',
    featured: true
  },
  { id: 'add-project', label: 'Add project', sublabel: 'Add a project folder' },
  { id: 'go-home', label: 'Go to home', sublabel: 'Switch to the home tab', shortcutId: 'go-home' },
  {
    id: 'toggle-global-agent-panel',
    label: 'Toggle global agent panel',
    sublabel: 'Show or hide the global agent side panel',
    shortcutId: 'global-agent-panel'
  },
  { id: 'open-changelog', label: 'Open changelog', sublabel: "What's new in SlayZone" },
  {
    id: 'open-settings',
    label: 'Open settings',
    sublabel: 'App settings',
    shortcutId: 'global-settings',
    featured: true
  }
]

export const ACTION_ICONS: Record<ActionId, LucideIcon> = {
  'new-task': SquarePen,
  'new-temp-task': Zap,
  'reopen-closed-tab': History,
  'add-project': FolderPlus,
  'go-home': Home,
  'toggle-global-agent-panel': PanelRight,
  'open-changelog': Megaphone,
  'open-settings': Settings
}
