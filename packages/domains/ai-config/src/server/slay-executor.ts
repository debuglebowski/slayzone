import { refuseNoComputer } from '@slayzone/platform/hub-switch-refusal'

export interface SlayTarget {
  projectPath: string
  projectId?: string
  taskId?: string
}
export interface SlayExecutor {
  checkConfigured(input: SlayTarget): Promise<boolean> | boolean
  setup(
    input: SlayTarget
  ): Promise<{ ok: boolean; error?: string }> | { ok: boolean; error?: string }
}
/** Until the hub wires its routing: `slay` runs on computers — none, "connect a computer". */
let executor: SlayExecutor = {
  checkConfigured: () => refuseNoComputer({ op: 'slay.check' }),
  setup: () => refuseNoComputer({ op: 'slay.init' })
}
export function setSlayExecutor(value: SlayExecutor): void {
  executor = value
}
export function getSlayExecutor(): SlayExecutor {
  return executor
}
