import type { TaskArtifact } from '@slayzone/task-contracts'
import { extensionBadge, isPlayableOnDevice, looksBinary, viewerKindOf } from './viewer-kind'

const a = (title: string, render_mode: TaskArtifact['render_mode'] = null) =>
  ({ title, render_mode }) as TaskArtifact

describe('viewerKindOf', () => {
  it("picks desktop's renderer: the title's extension, unless the artifact overrides it", () => {
    expect(viewerKindOf(a('notes.md'))).toBe('markdown')
    expect(viewerKindOf(a('report.html'))).toBe('html')
    expect(viewerKindOf(a('logo.svg'))).toBe('svg')
    expect(viewerKindOf(a('flow.mmd'))).toBe('mermaid')
    expect(viewerKindOf(a('shot.HEIC'))).toBe('image')
    expect(viewerKindOf(a('spec.pdf'))).toBe('pdf')
    expect(viewerKindOf(a('clip.MP4'))).toBe('video')
    expect(viewerKindOf(a('clip.webm'))).toBe('video')
    expect(viewerKindOf(a('voice.flac'))).toBe('audio')
    expect(viewerKindOf(a('bundle.zip'))).toBe('archive')
    expect(viewerKindOf(a('face.ttf'))).toBe('font')
    // A patch is shown as its source, as before it had its own desktop mode.
    expect(viewerKindOf(a('fix.diff'))).toBe('code')
    expect(viewerKindOf(a('main.ts'))).toBe('code')
    expect(viewerKindOf(a('data.csv'))).toBe('code')
    expect(viewerKindOf(a('notes.txt'))).toBe('markdown')
    expect(viewerKindOf(a('README'))).toBe('markdown')
    expect(viewerKindOf(a('page.html', 'code'))).toBe('code')
    expect(viewerKindOf(a('notes.md', 'html-preview'))).toBe('html')
  })
})

describe('looksBinary', () => {
  it('spots bytes that are not text (NULs, or mostly replacement characters)', () => {
    expect(looksBinary('# Title\n\nSome text — with ünïcode ✓')).toBe(false)
    expect(looksBinary('PK\u0003\u0004\u0000\u0000rest')).toBe(true)
    expect(looksBinary('���ab��')).toBe(true)
    expect(looksBinary('')).toBe(false)
  })
})

describe('extensionBadge', () => {
  it("is the title's extension, upper case, without the dot", () => {
    expect(extensionBadge('notes.md')).toBe('MD')
    expect(extensionBadge('archive.tar.gz')).toBe('GZ')
    expect(extensionBadge('README')).toBe('')
    expect(extensionBadge('.env')).toBe('')
  })
})

describe('isPlayableOnDevice', () => {
  it("knows the containers iOS's player can't open (desktop's Chromium can)", () => {
    for (const title of ['clip.webm', 'song.ogg', 'song.OGA', 'memo.opus', 'film.mkv', 'x.ogv']) {
      expect(isPlayableOnDevice(title)).toBe(false)
    }
    for (const title of [
      'clip.mp4',
      'clip.mov',
      'clip.m4v',
      'a.mp3',
      'a.m4a',
      'a.wav',
      'a.flac',
      'a.aac'
    ]) {
      expect(isPlayableOnDevice(title)).toBe(true)
    }
  })
})
