import type { SlayzoneDb } from '@slayzone/platform'

export interface RestApiDeps {
  db: SlayzoneDb
  notifyRenderer: () => void
  automationEngine?: { executeManual(id: string): Promise<unknown> }
}
