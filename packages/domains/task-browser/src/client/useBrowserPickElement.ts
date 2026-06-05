import { useCallback, useEffect, useState } from 'react'
import { buildDomElementSnippet, type PickedDomPayload } from './dom-picker'
import { DOM_PICKER_SCRIPT, DOM_PICKER_CANCEL_SCRIPT } from './dom-picker-runtime'
import type { BrowserTabPlaceholderHandle } from './BrowserTabPlaceholder'

interface UseBrowserPickElementParams {
  activeActions: BrowserTabPlaceholderHandle['actions'] | undefined
  extensionsManagerOpen: boolean
  canUseDomPicker: boolean
  multiDeviceMode: boolean
  onElementSnippet?: (snippet: string) => void
}

export function useBrowserPickElement({
  activeActions,
  extensionsManagerOpen,
  canUseDomPicker,
  multiDeviceMode,
  onElementSnippet
}: UseBrowserPickElementParams) {
  const [isPickingElement, setIsPickingElement] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)

  const cancelPickElement = useCallback(async () => {
    if (!activeActions) return
    try {
      await activeActions.executeJs(DOM_PICKER_CANCEL_SCRIPT)
    } catch {
      // ignore cancellation errors
    }
    setIsPickingElement(false)
  }, [activeActions])

  useEffect(() => {
    if (!extensionsManagerOpen || !isPickingElement) return
    void cancelPickElement()
  }, [extensionsManagerOpen, isPickingElement, cancelPickElement])

  // Escape should always cancel picker mode, even when focus is outside webview.
  useEffect(() => {
    if (!isPickingElement) return

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      event.stopPropagation()
      void cancelPickElement()
    }

    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [isPickingElement, cancelPickElement])

  const startPickElement = useCallback(async () => {
    if (
      extensionsManagerOpen ||
      !canUseDomPicker ||
      multiDeviceMode ||
      isPickingElement ||
      !activeActions
    )
      return

    setIsPickingElement(true)
    setPickError(null)
    try {
      const payload = (await activeActions.executeJs(DOM_PICKER_SCRIPT)) as PickedDomPayload | null
      if (!payload) {
        setIsPickingElement(false)
        return
      }
      const snippet = buildDomElementSnippet(payload)
      onElementSnippet?.(snippet)
      setIsPickingElement(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to start element picker'
      setPickError(message)
      setIsPickingElement(false)
    }
  }, [extensionsManagerOpen, canUseDomPicker, isPickingElement, multiDeviceMode, activeActions])

  const handlePickElement = useCallback(() => {
    if (isPickingElement) {
      void cancelPickElement()
      return
    }
    void startPickElement()
  }, [isPickingElement, cancelPickElement, startPickElement])

  useEffect(() => {
    return () => {
      if (!isPickingElement) return
      void cancelPickElement()
    }
  }, [isPickingElement, cancelPickElement])

  return {
    isPickingElement,
    pickError,
    cancelPickElement,
    startPickElement,
    handlePickElement
  }
}
