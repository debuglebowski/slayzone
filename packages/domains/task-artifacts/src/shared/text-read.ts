/**
 * What the in-app editor gets when it opens an artifact as text: the text, or the
 * reason it is not shown as text.
 *
 * The editor used to read every non-image/pdf artifact whole as UTF-8 and hand it
 * to a text surface. A binary file (an unknown extension falls back to markdown)
 * froze the window for seconds in the rich-text editor, and a single keystroke
 * autosaved the decoded text over the original bytes.
 */
export type ArtifactTextRead =
  /** Valid UTF-8 text. `size` is its byte length on disk. */
  | { kind: 'text'; content: string; size: number }
  /** Not UTF-8 text (NUL bytes, or invalid UTF-8): showing or saving it as text would change it. */
  | { kind: 'binary'; size: number }
  /** Over ARTIFACT_TEXT_MAX_BYTES: not read at all. */
  | { kind: 'too-large'; size: number }

/** Largest file the editor opens as text. Above it the file is not read. */
export const ARTIFACT_TEXT_MAX_BYTES = 64 * 1024 * 1024

/**
 * Largest markdown file opened in the rich-text editor (or the split view's
 * rendered pane) without asking. Measured 2026-11-15: a report-shaped document
 * blocks the window ~0.3 s at 100 KB and ~0.7 s at 250 KB while Milkdown parses and
 * lays it out; 2 MB crashed the renderer. Larger documents open as source, with a
 * button to open them as rich text anyway.
 */
export const RICH_TEXT_MAX_BYTES = 200 * 1024
