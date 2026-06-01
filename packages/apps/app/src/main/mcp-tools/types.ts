import type { SlayzoneDb } from '@slayzone/platform'

export interface McpToolsDeps {
  db: SlayzoneDb
  notifyRenderer: () => void
}
