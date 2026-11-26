import { useState } from 'react'
import type { TaskLayout } from '@slayzone/task-contracts'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  useStableCallback
} from '@slayzone/ui'
import { PANEL_KINDS, type PanelCloseConfirm } from '../panels/registry'
import { isRenderableKind } from './panelTabMeta'

interface UsePanelCloseRequestOptions {
  layout: TaskLayout
  /** Close the tab for real (hide a primary instance, remove any other). */
  closeTab: (instanceId: string) => void
  /** Whether an instance's agent session runs right now. */
  isSessionLive: (instanceId: string) => Promise<boolean>
}

/**
 * Closing a panel tab (×, ⌘W, the tab menu): asks the kind's `onCloseRequest`
 * first and shows its confirmation, if any, before closing. Render `dialog`.
 */
export function usePanelCloseRequest({
  layout,
  closeTab,
  isSessionLive
}: UsePanelCloseRequestOptions): {
  requestClose: (instanceId: string) => void
  dialog: React.JSX.Element
} {
  const [pending, setPending] = useState<{
    instanceId: string
    confirm: PanelCloseConfirm
  } | null>(null)

  const requestClose = useStableCallback((instanceId: string) => {
    const instance = layout.instances[instanceId]
    if (!instance) return
    const ask = isRenderableKind(instance.kind)
      ? PANEL_KINDS[instance.kind].onCloseRequest
      : undefined
    if (!ask) {
      closeTab(instanceId)
      return
    }
    ask({ panelId: instanceId, isSessionLive: () => isSessionLive(instanceId) }).then(
      (confirm) => {
        if (confirm) setPending({ instanceId, confirm })
        else closeTab(instanceId)
      },
      (error: unknown) => {
        console.warn('[task] close request check failed; closing anyway:', error)
        closeTab(instanceId)
      }
    )
  })

  const dialog = (
    <AlertDialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) setPending(null)
      }}
    >
      <AlertDialogContent data-testid="panel-close-confirm">
        <AlertDialogHeader>
          <AlertDialogTitle>{pending?.confirm.title}</AlertDialogTitle>
          <AlertDialogDescription>{pending?.confirm.description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={() => {
              if (pending) closeTab(pending.instanceId)
              setPending(null)
            }}
          >
            {pending?.confirm.confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )

  return { requestClose, dialog }
}
