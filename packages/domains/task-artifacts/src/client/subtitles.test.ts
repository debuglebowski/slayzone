import { describe, expect, it } from 'vitest'
import type { TaskArtifact } from '@slayzone/task-contracts'
import { parseSubtitles, subtitlesFor } from './subtitles'

describe('parseSubtitles', () => {
  it('reads SRT: numbered blocks, comma milliseconds, multi-line text', () => {
    const srt =
      '﻿1\r\n00:00:01,000 --> 00:00:02,500\r\nHello\r\nthere\r\n\r\n2\r\n00:01:02,250 --> 01:00:03,000\r\n<i>Bye</i>\r\n'
    expect(parseSubtitles(srt)).toEqual([
      { start: 1, end: 2.5, text: 'Hello\nthere' },
      { start: 62.25, end: 3603, text: '<i>Bye</i>' }
    ])
  })

  it('reads WebVTT: header, notes, cue ids, settings and short timestamps', () => {
    const vtt = [
      'WEBVTT - a title',
      '',
      'NOTE made by hand',
      '',
      'intro',
      '00:01.000 --> 00:02.000 align:start position:10%',
      'First',
      '',
      '00:00:03.500 --> 00:00:04.000',
      'Second'
    ].join('\n')
    expect(parseSubtitles(vtt)).toEqual([
      { start: 1, end: 2, text: 'First' },
      { start: 3.5, end: 4, text: 'Second' }
    ])
  })

  it('skips blocks without a usable timing line', () => {
    expect(
      parseSubtitles('1\nnot a time\nText\n\n00:00:05,000 --> 00:00:04,000\nbackwards')
    ).toEqual([])
  })
})

describe('subtitlesFor', () => {
  const art = (id: string, title: string, folder_id: string | null = null) =>
    ({ id, title, folder_id }) as TaskArtifact
  const video = art('v', 'Clip.mp4')

  it('pairs a video with same-named .vtt/.srt artifacts in its folder, language from the name', () => {
    const all = [
      video,
      art('a', 'Clip.vtt'),
      art('b', 'Clip.sv.srt'),
      art('c', 'clip.en-US.vtt'),
      art('d', 'Clip.notes.txt'),
      art('e', 'Other.vtt'),
      art('f', 'Clip.vtt', 'folder-2')
    ]
    expect(subtitlesFor(video, all)).toEqual([
      { artifactId: 'a', language: null, label: 'Subtitles' },
      { artifactId: 'c', language: 'en-US', label: 'en-US' },
      { artifactId: 'b', language: 'sv', label: 'sv' }
    ])
  })

  it('a video with no subtitle siblings has none', () => {
    expect(subtitlesFor(video, [video, art('x', 'readme.md')])).toEqual([])
  })
})
