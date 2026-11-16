import type { TaskArtifact } from '@slayzone/task-contracts'

/**
 * Subtitles for a video artifact: `.srt` / `.vtt` artifacts named after it in the
 * same folder (`clip.vtt`, `clip.sv.srt`) are added to its player as text tracks.
 *
 * They are added as cues through the TextTrack API rather than a `<track src>`:
 * a track is fetched in CORS mode, which the `slz-file:` scheme does not serve,
 * and a `blob:` source would need `media-src blob:` in the renderer's CSP.
 */

export interface SubtitleCue {
  /** Seconds. */
  start: number
  end: number
  text: string
}

export interface SubtitleSource {
  artifactId: string
  /** BCP 47 tag from the name (`clip.en-US.vtt`), or null when the name has none. */
  language: string | null
  label: string
}

const TIMESTAMP = String.raw`(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})`
const TIMING = new RegExp(`^\\s*${TIMESTAMP}\\s+-->\\s+${TIMESTAMP}`)

const seconds = (h: string | undefined, m: string, s: string, ms: string): number =>
  Number(h ?? 0) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000

/** Cues of an SRT or WebVTT file. Blocks without a valid timing line are skipped. */
export function parseSubtitles(text: string): SubtitleCue[] {
  const cues: SubtitleCue[] = []
  const blocks = text
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
  for (const block of blocks) {
    const lines = block.split('\n')
    const at = lines.findIndex((l) => l.includes('-->'))
    if (at < 0) continue
    const m = TIMING.exec(lines[at])
    if (!m) continue
    const start = seconds(m[1], m[2], m[3], m[4])
    const end = seconds(m[5], m[6], m[7], m[8])
    if (!(end > start)) continue
    const body = lines
      .slice(at + 1)
      .join('\n')
      .trim()
    if (body) cues.push({ start, end, text: body })
  }
  return cues
}

const SUBTITLE_EXT = /\.(srt|vtt)$/i
const LANGUAGE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/

/**
 * The subtitle artifacts for `video`: same folder, named `<stem>.(srt|vtt)` or
 * `<stem>.<language>.(srt|vtt)` (stem compared case-insensitively). Unlabelled
 * first, then by language.
 */
export function subtitlesFor(
  video: Pick<TaskArtifact, 'id' | 'title' | 'folder_id'>,
  artifacts: readonly Pick<TaskArtifact, 'id' | 'title' | 'folder_id'>[]
): SubtitleSource[] {
  const dot = video.title.lastIndexOf('.')
  const stem = (dot > 0 ? video.title.slice(0, dot) : video.title).toLowerCase()
  const found: SubtitleSource[] = []
  for (const a of artifacts) {
    if (a.id === video.id || a.folder_id !== video.folder_id || !SUBTITLE_EXT.test(a.title))
      continue
    const base = a.title.replace(SUBTITLE_EXT, '')
    if (base.toLowerCase() === stem) {
      found.push({ artifactId: a.id, language: null, label: 'Subtitles' })
      continue
    }
    const langDot = base.lastIndexOf('.')
    if (langDot <= 0 || base.slice(0, langDot).toLowerCase() !== stem) continue
    const language = base.slice(langDot + 1)
    if (LANGUAGE.test(language)) found.push({ artifactId: a.id, language, label: language })
  }
  return found.sort((x, y) =>
    x.language === y.language
      ? 0
      : x.language === null
        ? -1
        : y.language === null
          ? 1
          : x.language.localeCompare(y.language)
  )
}
