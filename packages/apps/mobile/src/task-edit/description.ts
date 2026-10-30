/**
 * A task's description as the phone edits it: the raw markdown desktop wrote, edited as
 * text and saved whole, only when the user says Done. Nothing here rewrites what it was
 * not asked to: the text to edit is desktop's own normalisation (`normalizeDescription`:
 * markdown as stored; a legacy HTML description converted the way desktop's editor
 * converts it on open), and an unchanged text is never written back.
 */
import { normalizeDescription } from '@slayzone/task-contracts'

/** The stored description, as a task row carries it. */
export interface StoredDescription {
  description: string | null
  description_format: 'html' | 'markdown'
}

/** The markdown to show and edit. */
export const editableDescription = (task: StoredDescription): string =>
  normalizeDescription(task.description, task.description_format)

/**
 * The `task.update` fields that save `edited`, started from `original`
 * (`editableDescription`); null = nothing changed, nothing to write. The text goes as
 * typed (the hub stores it as markdown); an emptied description is cleared.
 */
export function descriptionUpdate(
  original: string,
  edited: string
): { description: string | null } | null {
  if (edited === original) return null
  return { description: edited === '' ? null : edited }
}

/** The hub's description is no longer the one editing started from. */
export const hubChanged = (base: StoredDescription, current: StoredDescription): boolean =>
  base.description !== current.description || base.description_format !== current.description_format

const ARTIFACT_PREFIX = 'artifact:'

/** A link to an artifact, as desktop's editor writes it: `[title](artifact:<id>)`. */
export const artifactLink = (artifactId: string, title: string): string =>
  `[${title.replace(/[\\[\]]/g, (c) => `\\${c}`)}](${ARTIFACT_PREFIX}${artifactId})`

/** The artifact a link names (`artifact:<id>`), else null. */
export function artifactIdOf(href: string): string | null {
  if (!href.startsWith(ARTIFACT_PREFIX)) return null
  const id = href.slice(ARTIFACT_PREFIX.length)
  return id || null
}

export interface TextSelection {
  start: number
  end: number
}

/**
 * `insert` in place of `selection` (the cursor), or with no cursor yet on a line of its
 * own at the end. Every other character stays as it was. Returns the new text and the
 * cursor after the insert.
 */
export function insertAt(
  text: string,
  selection: TextSelection | null,
  insert: string
): { text: string; cursor: number } {
  if (!selection) {
    const lead = text === '' || text.endsWith('\n') ? '' : '\n'
    const next = `${text}${lead}${insert}`
    return { text: next, cursor: next.length }
  }
  const start = Math.min(selection.start, selection.end, text.length)
  const end = Math.min(Math.max(selection.start, selection.end), text.length)
  return {
    text: text.slice(0, start) + insert + text.slice(end),
    cursor: start + insert.length
  }
}
