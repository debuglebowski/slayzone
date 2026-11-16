import { useEffect, useRef, useState } from 'react'
import { useHubId } from '@slayzone/transport/client'
import { toArtifactFileUrl } from '@slayzone/platform/slz-file-url'
import { parseSubtitles, type SubtitleSource } from './subtitles'

/** Media elements whose text tracks were added (tracks can't be removed, only added once). */
const WITH_TRACKS = new WeakSet<HTMLMediaElement>()

/**
 * Chromium's native video or audio player over the slz-file URL. The bytes come
 * through main's slz-file handler from the hub, which answers `Range`, so the
 * player can read an mp4's index from the end of the file and seek without
 * fetching it whole.
 */
export function MediaPlayerViewer({
  kind,
  artifactId,
  contentVersion,
  getFilePath,
  subtitles = [],
  readSubtitle
}: {
  kind: 'video' | 'audio'
  artifactId: string
  contentVersion: number
  getFilePath: (id: string) => Promise<string | null>
  /** Text tracks for a video (`subtitlesFor`), each read through `readSubtitle`. */
  subtitles?: readonly SubtitleSource[]
  /** A subtitle artifact's text; null when it is not text. */
  readSubtitle?: (id: string) => Promise<string | null>
}) {
  const hubId = useHubId()
  const [src, setSrc] = useState<string | null>(null)
  // The source the player refused, so a newer version of the file gets a fresh try.
  const [failedSrc, setFailedSrc] = useState<string | null>(null)
  const mediaRef = useRef<HTMLVideoElement & HTMLAudioElement>(null)
  const subtitlesKey = subtitles.map((s) => `${s.artifactId}:${s.label}`).join('|')

  useEffect(() => {
    getFilePath(artifactId).then((p) => {
      if (p) setSrc(toArtifactFileUrl(hubId, artifactId, p, contentVersion))
    })
  }, [hubId, artifactId, contentVersion, getFilePath])

  // Task tabs hide in <Activity>, which keeps this element in the DOM: pause on
  // hide (effect cleanup) so a tab nobody is looking at never keeps playing sound.
  useEffect(() => {
    const media = mediaRef.current
    return () => media?.pause()
  }, [src, subtitlesKey])

  // Subtitles: cues through the TextTrack API (see subtitles.ts for why not
  // `<track src>`). The element is keyed on the subtitle set, so a changed set
  // gets a fresh element; WITH_TRACKS keeps a re-run from adding them twice.
  useEffect(() => {
    const media = mediaRef.current
    if (!media || !readSubtitle || subtitles.length === 0 || WITH_TRACKS.has(media)) return
    if (typeof media.addTextTrack !== 'function') return
    let cancelled = false
    Promise.all(
      subtitles.map((s) =>
        readSubtitle(s.artifactId).then(
          (text) => ({ source: s, cues: parseSubtitles(text ?? '') }),
          () => null
        )
      )
    ).then((loaded) => {
      if (cancelled || WITH_TRACKS.has(media)) return
      WITH_TRACKS.add(media)
      let first = true
      for (const entry of loaded) {
        if (!entry || entry.cues.length === 0) continue
        const track = media.addTextTrack(
          'subtitles',
          entry.source.label,
          entry.source.language ?? ''
        )
        for (const cue of entry.cues) track.addCue(new VTTCue(cue.start, cue.end, cue.text))
        track.mode = first ? 'showing' : 'hidden'
        first = false
      }
    })
    return () => {
      cancelled = true
    }
  }, [src, subtitles, readSubtitle])

  if (!src)
    return (
      <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
        Loading...
      </div>
    )
  if (failedSrc === src)
    return (
      <div
        data-testid={`artifact-${kind}-error`}
        className="flex-1 flex items-center justify-center px-6 text-center text-xs text-muted-foreground"
      >
        This {kind} can't be played here: its format or codec isn't supported. Download it to open
        it in another app.
      </div>
    )

  return (
    <div className="flex-1 min-h-0 flex items-center justify-center bg-muted/20 overflow-hidden px-6">
      {kind === 'video' ? (
        <video
          key={`${src}|${subtitlesKey}`}
          ref={mediaRef}
          data-testid="artifact-video"
          src={src}
          controls
          preload="metadata"
          className="max-w-full max-h-full"
          onError={() => setFailedSrc(src)}
        />
      ) : (
        <audio
          key={src}
          ref={mediaRef}
          data-testid="artifact-audio"
          src={src}
          controls
          preload="metadata"
          className="w-full max-w-xl"
          onError={() => setFailedSrc(src)}
        />
      )}
    </div>
  )
}
