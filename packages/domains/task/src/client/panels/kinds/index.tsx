import type { ComponentType } from 'react'
import type { PanelKind } from '../registry'
import type { PanelKindProps } from './types'
import { AgentKind } from './AgentKind'
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
  git: GitKind,
  settings: SettingsKind,
  processes: ProcessesKind
} satisfies Record<PanelKind, ComponentType<PanelKindProps>>

export type { PanelKindProps } from './types'
