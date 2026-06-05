import { Globe } from 'lucide-react'
import type { TerminalMode, TerminalModeInfo } from '@slayzone/terminal/shared'

export interface PanelsSettingsTabProps {
  activeTab: string
  navigateTo: (tab: string) => void
  modes: TerminalModeInfo[]
  defaultTerminalMode: TerminalMode
  onDefaultTerminalModeChange: (mode: TerminalMode) => void
}

export interface PanelRowDescriptor {
  icon: typeof Globe
  label: string
  homeToggle: { enabled: boolean; onChange: (v: boolean) => void } | null
  taskToggle: { enabled: boolean; onChange: (v: boolean) => void } | null
  onClick?: () => void
  webSubtitle?: string
  /** Default size shown inline on the row, e.g. "440px" / "1fr" / "50%". */
  sizeLabel?: string
}
