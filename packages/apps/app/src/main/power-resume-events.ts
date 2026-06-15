import { TypedEmitter } from '@slayzone/platform/events'
import type { PowerResumeEventMap } from '@slayzone/transport/server'

/**
 * Host `powerMonitor 'resume'` events. Electron's powerMonitor is host-only, but
 * the AutomationEngine (which runs cron catchup after wake) lives in the side-car
 * post-cutover. The host emits here; the capability bridge forwards it to the
 * side-car, which calls `automationEngine.runCatchup()`. Same module-singleton
 * pattern as menu-events / notify-renderer.
 */
export const powerResumeEvents = new TypedEmitter<PowerResumeEventMap>()
