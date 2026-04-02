import type { CreateTaskDraft } from './types'

function normalizeLinkText(linkText?: string): string {
  return (linkText ?? '').replace(/\s+/g, ' ').trim()
}

export function buildCreateTaskDraftFromBrowserLink(url: string, linkText?: string): CreateTaskDraft {
  const normalizedLinkText = normalizeLinkText(linkText)

  return {
    title: normalizedLinkText ? `Link: ${normalizedLinkText}` : '',
    description: url,
  }
}
