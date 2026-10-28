import type { TypedEmitter } from '@slayzone/platform/events'

// Automations-changed bus — fires when the AutomationEngine mutates automations
// (manual run, trigger fire, CRUD). Backs the `automations.onChanged` sub. The
// emitter is owned by the host, injected here (`setAutomationsEvents()` from the
// composition root) so the router and the still-live `automations:changed`
// webContents.send share one instance (dual-emit).
export type AutomationsEventMap = {
  /** Any automation data change — renderer invalidates affected queries. No payload. */
  changed: []
}

let automationsEvents: TypedEmitter<AutomationsEventMap> | null = null

export function setAutomationsEvents(ev: TypedEmitter<AutomationsEventMap>): void {
  automationsEvents = ev
}

export function getAutomationsEvents(): TypedEmitter<AutomationsEventMap> {
  if (!automationsEvents)
    throw new Error(
      'automationsEvents not initialized — call setAutomationsEvents() in main host first'
    )
  return automationsEvents
}
