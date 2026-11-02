import { getAiConfigOps } from './ai-config-ops'

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
let executor: SlayExecutor = {
  checkConfigured: ({ projectPath }) => getAiConfigOps().checkSlayConfigured(projectPath),
  setup: ({ projectPath, projectId }) => getAiConfigOps().setupSlay(projectPath, projectId)
}
export function setSlayExecutor(value: SlayExecutor): void {
  executor = value
}
export function getSlayExecutor(): SlayExecutor {
  return executor
}
