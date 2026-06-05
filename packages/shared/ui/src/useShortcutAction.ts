import { useEffect, useRef } from 'react'
import { shortcutDefinitions, registry, type ShortcutScope } from '@slayzone/shortcuts'
import { useShortcutStore } from './useShortcutStore'

interface DynamicOpts {
  id: string
  keys: string
  scope: ShortcutScope
}

interface Options {
  enabled?: boolean
}

/**
 * Register a shortcut handler with the centralized dispatcher.
 *
 * Static mode — looks up keys from definitions + user customization:
 *   useShortcutAction('editor-save', () => save())
 *
 * Dynamic mode — explicit keys + scope (e.g. web panel shortcuts):
 *   useShortcutAction({ id: 'web:figma', keys: 'mod+y', scope: 'task' }, () => toggle())
 */
export function useShortcutAction(
  idOrOpts: string | DynamicOpts,
  handler: () => boolean | void,
  options?: Options
): void {
  const handlerRef = useRef(handler)
  useEffect(() => {
    handlerRef.current = handler
  })

  const enabled = options?.enabled ?? true

  // For static mode, resolve keys reactively from the store
  const isStatic = typeof idOrOpts === 'string'
  const id = isStatic ? idOrOpts : idOrOpts.id
  const storeOverride = useShortcutStore((s) => (isStatic ? s.overrides[id] : undefined))

  let keys: string
  let scope: ShortcutScope
  if (isStatic) {
    const def = shortcutDefinitions.find((d) => d.id === id)
    keys = storeOverride ?? def?.defaultKeys ?? ''
    scope = def?.scope ?? 'global'
  } else {
    keys = idOrOpts.keys
    scope = idOrOpts.scope
  }

  useEffect(() => {
    if (!keys) return

    const unsub = registry.register({
      id,
      scope,
      keys,
      handler: () => handlerRef.current(),
      enabled
    })
    return unsub
  }, [id, keys, scope, enabled])
}
