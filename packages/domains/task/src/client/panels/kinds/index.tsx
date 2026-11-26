import type { ComponentType } from 'react'
import type { PanelInstance } from '@slayzone/task-contracts'
import type { PanelKind } from '../registry'
import type { PanelKindProps } from './types'
import { AgentKind } from './AgentKind'
import { AgentProviderMenu } from './AgentProviderMenu'
import { ArtifactKind } from './ArtifactKind'
import { DescriptionKind, DetailsKind, SubtasksKind } from './TaskSectionKinds'
import { BrowserKind } from './BrowserKind'
import { WebKind } from './WebKind'
import { EditorKind } from './EditorKind'
import { ArtifactsKind } from './ArtifactsKind'
import { GitKind } from './GitKind'
import { SettingsKind } from './SettingsKind'
import { ProcessesKind } from './ProcessesKind'
import { TerminalInstanceKind } from './TerminalInstanceKind'

/** The primary agent (`terminal`) is the task's main agent pane; any other agent instance shows its own terminal groups. */
function AgentPanelKind(props: PanelKindProps): React.JSX.Element {
  return props.instance.id === 'terminal' ? (
    <AgentKind {...props} />
  ) : (
    <TerminalInstanceKind {...props} />
  )
}

/** The component of each panel kind (its metadata: PANEL_KINDS in ../registry). */
export const PANEL_KIND_COMPONENTS = {
  agent: AgentPanelKind,
  terminal: TerminalInstanceKind,
  browser: BrowserKind,
  web: WebKind,
  editor: EditorKind,
  artifacts: ArtifactsKind,
  artifact: ArtifactKind,
  git: GitKind,
  settings: SettingsKind,
  description: DescriptionKind,
  subtasks: SubtasksKind,
  details: DetailsKind,
  processes: ProcessesKind
} satisfies Record<PanelKind, ComponentType<PanelKindProps>>

/** What a kind's tab accessory gets: the instance, and whether its tab is the active one. */
export interface PanelTabAccessoryProps {
  instance: PanelInstance
  selected: boolean
}

/** An agent tab's provider picker: on the active tab only (docs/plans/panel-model.md step 12). */
function AgentTabAccessory({
  instance,
  selected
}: PanelTabAccessoryProps): React.JSX.Element | null {
  return selected ? <AgentProviderMenu instance={instance} variant="tab" /> : null
}

/** Extra controls a kind puts on its tab in a tab strip, beside the name. */
export const PANEL_TAB_ACCESSORIES: Partial<
  Record<PanelKind, ComponentType<PanelTabAccessoryProps>>
> = {
  agent: AgentTabAccessory
}

export type { PanelKindProps } from './types'
