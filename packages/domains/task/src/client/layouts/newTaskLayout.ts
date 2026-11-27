import type { CreateTaskInput } from '@slayzone/task-contracts'
import { newTaskLayout } from '@slayzone/task-contracts'

/**
 * `input` with the user's default layout for new tasks (`task_layouts.defaultLayoutId`,
 * docs/plans/panel-model.md step 10). The hub stores it unless the task's template
 * brings a layout. Classic as shipped adds nothing: such a task derives its layout
 * and keeps following Settings → Panels. A failed read creates the task as before.
 *
 * The setting stores load on first use (dynamic import): the create paths that call
 * this stay light, and their tests need no settings client.
 */
export async function withDefaultPanelLayout<T extends CreateTaskInput>(input: T): Promise<T> {
  if (input.defaultPanelLayout !== undefined) return input
  try {
    const [layouts, panels] = await Promise.all([
      import('./useTaskLayouts'),
      import('../usePanelConfig')
    ])
    const [setting, config] = await Promise.all([
      layouts.loadTaskLayoutsSetting(),
      panels.loadPanelConfig()
    ])
    const layout = newTaskLayout(setting, config, layouts.CLIENT_LAYOUT_CAPABILITIES)
    return layout ? { ...input, defaultPanelLayout: layout } : input
  } catch (error) {
    console.warn('[task] reading the default layout failed:', error)
    return input
  }
}
