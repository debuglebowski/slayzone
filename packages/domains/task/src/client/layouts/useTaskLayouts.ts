/**
 * The per-user `task_layouts` setting (docs/plans/panel-model.md step 10): layout
 * definitions — the built-ins with the user's overrides, and the user's own.
 *
 * ONE copy for the whole window, shared by every `useTaskLayouts()` (each open task
 * page, Manage layouts, the editor), like `panel_config` (usePanelConfig.ts): one
 * read per change, reloaded on in-window writes and on the hub's settings-changed
 * signal. Read from the default hub, like `panel_config`.
 */
import { useSyncExternalStore } from 'react'
import { hubAllows } from '@slayzone/transport/client'
import type {
  LayoutCapabilities,
  PanelConfig,
  ResolvedLayoutDefinition,
  TaskLayoutsSetting
} from '@slayzone/task-contracts'
import {
  defaultTaskLayoutsSetting,
  parseTaskLayoutsSetting,
  resolveLayoutDefinitions,
  TASK_LAYOUTS_SETTING_KEY
} from '@slayzone/task-contracts'
import { PANEL_KINDS, type PanelKind } from '../panels/registry'
import { getTrpcClient } from '../trpc'

export { TASK_LAYOUTS_SETTING_KEY }
const CHANGE_EVENT = 'task-layouts-changed'
const SETTINGS_CHANGED_PATH = 'notify.onSettingsChanged'

/** What this app renders: every registered kind, several instances each. */
export const CLIENT_LAYOUT_CAPABILITIES: LayoutCapabilities = {
  kinds: Object.keys(PANEL_KINDS) as PanelKind[],
  multiInstance: true
}

interface Snapshot {
  setting: TaskLayoutsSetting
  /** The first read has landed (before it, `setting` is the default). */
  loaded: boolean
}

const taskLayoutsStore = (() => {
  let snapshot: Snapshot = { setting: defaultTaskLayoutsSetting(), loaded: false }
  let raw: string | null | undefined
  const listeners = new Set<() => void>()
  let loading: Promise<void> | null = null
  let reloadAgain = false
  let stopExternal: (() => void) | null = null

  const publish = (nextRaw: string | null): void => {
    raw = nextRaw
    snapshot = { setting: parseTaskLayoutsSetting(nextRaw), loaded: true }
    for (const l of listeners) l()
  }

  const reload = (): Promise<void> => {
    if (loading) {
      reloadAgain = true
      return loading
    }
    loading = getTrpcClient()
      .settings.get.query({ key: TASK_LAYOUTS_SETTING_KEY })
      .then(
        (value) => {
          if (value !== raw || !snapshot.loaded) publish(value ?? null)
        },
        () => {
          /* keep the last-known setting; the next change signal retries */
        }
      )
      .then(() => {
        loading = null
        if (reloadAgain) {
          reloadAgain = false
          return reload()
        }
        return undefined
      })
    return loading
  }

  const onWindowChange = (): void => void reload()

  const start = (): void => {
    void reload()
    window.addEventListener(CHANGE_EVENT, onWindowChange)
    let sub: { unsubscribe: () => void } | null = null
    let stopped = false
    try {
      const client = getTrpcClient()
      void hubAllows(client, SETTINGS_CHANGED_PATH).then((allowed) => {
        if (!allowed || stopped) return
        sub = client.notify.onSettingsChanged.subscribe(undefined, {
          onData: (event: { keys: string[] | null } | undefined) => {
            if (!event?.keys || event.keys.includes(TASK_LAYOUTS_SETTING_KEY)) void reload()
          }
        })
      })
    } catch {
      /* no client yet / subscriptions unsupported — window events still apply */
    }
    stopExternal = () => {
      stopped = true
      window.removeEventListener(CHANGE_EVENT, onWindowChange)
      sub?.unsubscribe()
    }
  }

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      if (listeners.size === 1) start()
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          stopExternal?.()
          stopExternal = null
        }
      }
    },
    get: (): Snapshot => snapshot,
    /** The setting as stored now (reads it when nobody has yet). */
    async load(): Promise<TaskLayoutsSetting> {
      if (!snapshot.loaded) await reload()
      return snapshot.setting
    },
    /** Write `next` (optimistic: every reader sees it at once). */
    async write(next: TaskLayoutsSetting): Promise<void> {
      const value = JSON.stringify(next)
      publish(value)
      await getTrpcClient().settings.set.mutate({ key: TASK_LAYOUTS_SETTING_KEY, value })
      window.dispatchEvent(new CustomEvent(CHANGE_EVENT))
    }
  }
})()

/** The stored setting, read if needed (task creation resolves the default layout). */
export function loadTaskLayoutsSetting(): Promise<TaskLayoutsSetting> {
  return taskLayoutsStore.load()
}

export interface TaskLayoutsApi {
  setting: TaskLayoutsSetting
  loaded: boolean
  /** Apply `fn` to the latest setting and store the result (null = no change). */
  update: (fn: (setting: TaskLayoutsSetting) => TaskLayoutsSetting | null) => Promise<void>
}

async function updateTaskLayouts(
  fn: (setting: TaskLayoutsSetting) => TaskLayoutsSetting | null
): Promise<void> {
  const next = fn(taskLayoutsStore.get().setting)
  if (!next) return
  await taskLayoutsStore.write(next)
}

export function useTaskLayouts(): TaskLayoutsApi {
  const snapshot = useSyncExternalStore(taskLayoutsStore.subscribe, taskLayoutsStore.get)
  return { setting: snapshot.setting, loaded: snapshot.loaded, update: updateTaskLayouts }
}

/** Every layout the user can pick, in display order (see `resolveLayoutDefinitions`). */
export function resolveClientLayouts(
  setting: TaskLayoutsSetting,
  config: PanelConfig
): ResolvedLayoutDefinition[] {
  return resolveLayoutDefinitions(setting, config, CLIENT_LAYOUT_CAPABILITIES)
}

/** The user edited the Classic definition (moved to contracts; re-exported for callers here). */
export { isClassicCustomized } from '@slayzone/task-contracts'
