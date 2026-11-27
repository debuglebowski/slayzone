import type { PanelInstance } from '@slayzone/task-contracts'

/** Props every panel kind component takes: which panel instance it renders. */
export interface PanelKindProps {
  /** The instance id (`instance.id`): a primary instance's is its legacy panel id. */
  panelId: string
  instance: PanelInstance
}
