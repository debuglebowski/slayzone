import { Cpu, FileCode, GitCompare, Globe, Paperclip, Settings2, SquareTerminal } from 'lucide-react'
import type { PanelConfig, PanelView } from '@slayzone/task/shared'
import { isPanelEnabled, panelLayoutFallback } from '@slayzone/task/shared'
import type { PanelRowDescriptor } from './panels-settings.types'

/** Format a panel's effective default layout size for the row badge. */
export function layoutSizeLabel(orderId: string, panelConfig: PanelConfig): string {
  const l = panelConfig.layout?.[orderId] ?? panelLayoutFallback(orderId)
  return l.unit === 'px' ? `${l.value}px` : l.unit === 'pct' ? `${l.value}%` : `${l.value}fr`
}

export function buildPanelRowDescriptors(
  panelConfig: PanelConfig,
  navigateTo: (tab: string) => void,
  togglePanel: (id: string, view: PanelView, enabled: boolean) => void
): Map<string, PanelRowDescriptor> {
  const m = new Map<string, PanelRowDescriptor>()
  m.set('terminal', {
    icon: SquareTerminal,
    label: 'Agent',
    homeToggle: null,
    taskToggle: {
      enabled: isPanelEnabled(panelConfig, 'terminal', 'task'),
      onChange: (c) => togglePanel('terminal', 'task', c)
    },
    onClick: () => navigateTo('panels/terminal')
  })
  m.set('browser', {
    icon: Globe,
    label: 'Browser',
    homeToggle: null,
    taskToggle: {
      enabled: isPanelEnabled(panelConfig, 'browser', 'task'),
      onChange: (c) => togglePanel('browser', 'task', c)
    },
    onClick: () => navigateTo('panels/browser')
  })
  m.set('editor', {
    icon: FileCode,
    label: 'Editor',
    homeToggle: {
      enabled: isPanelEnabled(panelConfig, 'editor', 'home'),
      onChange: (c) => togglePanel('editor', 'home', c)
    },
    taskToggle: {
      enabled: isPanelEnabled(panelConfig, 'editor', 'task'),
      onChange: (c) => togglePanel('editor', 'task', c)
    },
    onClick: () => navigateTo('panels/editor')
  })
  m.set('artifacts', {
    icon: Paperclip,
    label: 'Artifacts',
    homeToggle: null,
    taskToggle: {
      enabled: isPanelEnabled(panelConfig, 'artifacts', 'task'),
      onChange: (c) => togglePanel('artifacts', 'task', c)
    },
    onClick: () => navigateTo('panels/artifacts')
  })
  m.set('git', {
    icon: GitCompare,
    label: 'Git',
    homeToggle: {
      enabled: isPanelEnabled(panelConfig, 'git', 'home'),
      onChange: (c) => togglePanel('git', 'home', c)
    },
    taskToggle: {
      enabled: isPanelEnabled(panelConfig, 'diff', 'task'),
      onChange: (c) => togglePanel('diff', 'task', c)
    },
    onClick: () => navigateTo('panels/git')
  })
  m.set('settings', {
    icon: Settings2,
    label: 'Settings',
    homeToggle: null,
    taskToggle: {
      enabled: isPanelEnabled(panelConfig, 'settings', 'task'),
      onChange: (c) => togglePanel('settings', 'task', c)
    },
    onClick: () => navigateTo('panels/settings')
  })
  m.set('processes', {
    icon: Cpu,
    label: 'Processes',
    homeToggle: {
      enabled: isPanelEnabled(panelConfig, 'processes', 'home'),
      onChange: (c) => togglePanel('processes', 'home', c)
    },
    taskToggle: {
      enabled: isPanelEnabled(panelConfig, 'processes', 'task'),
      onChange: (c) => togglePanel('processes', 'task', c)
    },
    onClick: () => navigateTo('panels/processes')
  })
  for (const wp of panelConfig.webPanels) {
    m.set(wp.id, {
      icon: Globe,
      label: wp.name,
      homeToggle: null,
      taskToggle: {
        enabled: isPanelEnabled(panelConfig, wp.id, 'task'),
        onChange: (c) => togglePanel(wp.id, 'task', c)
      },
      onClick: () => navigateTo(`panels/${wp.id}`),
      webSubtitle: wp.baseUrl
    })
  }
  for (const [orderId, d] of m) d.sizeLabel = layoutSizeLabel(orderId, panelConfig)
  return m
}
