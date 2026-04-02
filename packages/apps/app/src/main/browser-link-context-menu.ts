export interface BrowserLinkContextMenuInput {
  linkURL: string
  linkText: string
}

export type BrowserLinkContextMenuAction =
  | 'create-task-from-link'
  | 'open-link-in-new-tab'
  | 'copy-link'
  | 'open-link-externally'

export interface BrowserLinkContextMenuItem {
  action: BrowserLinkContextMenuAction
  label: string
}

export function normalizeBrowserLinkContextMenuInput(
  input: BrowserLinkContextMenuInput
): BrowserLinkContextMenuInput {
  return {
    linkURL: input.linkURL.trim(),
    linkText: input.linkText.trim(),
  }
}

export function buildBrowserLinkContextMenuItems(
  input: BrowserLinkContextMenuInput
): BrowserLinkContextMenuItem[] {
  const normalized = normalizeBrowserLinkContextMenuInput(input)
  const url = normalized.linkURL
  if (!/^https?:\/\//i.test(url)) return []

  return [
    { action: 'create-task-from-link', label: 'Create Task From Link' },
    { action: 'open-link-in-new-tab', label: 'Open Link in New Tab' },
    { action: 'copy-link', label: 'Copy Link' },
    { action: 'open-link-externally', label: 'Open Link Externally' },
  ]
}
