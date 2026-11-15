import { describe, expect, it } from 'vitest'
import {
  fileUrlToSlzFileUrl,
  parseSlzFileUrl,
  slzFileUrlToFileUrl,
  SLZ_FILE_PREFIX,
  toArtifactFileUrl,
  toSlzFileUrl,
  toSlzSourceUrl
} from './slz-file-url'

describe('fileUrlToSlzFileUrl', () => {
  it('rewrites empty-host file URL into the slz-file scheme', () => {
    expect(fileUrlToSlzFileUrl('file:///Users/me/page.html')).toBe(
      'slz-file://app/Users/me/page.html'
    )
  })

  it('heals a URL corrupted by one bad round-trip', () => {
    expect(fileUrlToSlzFileUrl('file://app/Users/me/page.html')).toBe(
      'slz-file://app/Users/me/page.html'
    )
  })

  it('heals a URL corrupted by repeated bad round-trips', () => {
    expect(fileUrlToSlzFileUrl('file://appappapp/Users/me/page.html')).toBe(
      'slz-file://app/Users/me/page.html'
    )
  })

  it('leaves non-file URLs untouched', () => {
    expect(fileUrlToSlzFileUrl('https://example.com')).toBe('https://example.com')
  })
})

describe('slzFileUrlToFileUrl', () => {
  it('strips scheme + sentinel host back to empty-host file URL', () => {
    expect(slzFileUrlToFileUrl('slz-file://app/Users/me/page.html')).toBe(
      'file:///Users/me/page.html'
    )
  })

  it('passes non-matching URLs through unchanged', () => {
    expect(slzFileUrlToFileUrl('https://example.com')).toBe('https://example.com')
  })

  it('round-trips without prepending app (regression: file://app... bug)', () => {
    const original = 'file:///Users/me/page.html'
    const forward = fileUrlToSlzFileUrl(original)
    const back = slzFileUrlToFileUrl(forward)
    expect(back).toBe(original)
    // A second open must not accumulate `app`.
    expect(slzFileUrlToFileUrl(fileUrlToSlzFileUrl(back))).toBe(original)
  })
})

describe('toSlzFileUrl', () => {
  it('round-trips with slzFileUrlToFileUrl for absolute paths', () => {
    expect(slzFileUrlToFileUrl(toSlzFileUrl('/Users/me/page.html'))).toBe(
      'file:///Users/me/page.html'
    )
  })
})

describe('source URLs (files on a hub or a computer)', () => {
  const workspace = {
    kind: 'workspace' as const,
    hubId: 'hub-1',
    rootPath: '/home/ann/proj',
    taskId: 't1',
    computerId: 'c1'
  }

  it('round-trips a workspace file, keeping the relative path hierarchical', () => {
    const url = toSlzSourceUrl(workspace, 'docs/a b/index.html', 3, 'dark')
    expect(url.startsWith(`${SLZ_FILE_PREFIX}/@src/`)).toBe(true)
    expect(url).toContain('/docs/a%20b/index.html?v=3&theme=dark')
    expect(parseSlzFileUrl(url)).toEqual({
      kind: 'source',
      source: workspace,
      relPath: 'docs/a b/index.html'
    })
  })

  it('resolves a relative reference inside an HTML page to a sibling of the same source', () => {
    const page = toSlzSourceUrl(workspace, 'site/index.html')
    const asset = new URL('img/logo.png', page.replace('slz-file:', 'http:')).href.replace(
      'http:',
      'slz-file:'
    )
    expect(parseSlzFileUrl(asset)).toEqual({
      kind: 'source',
      source: workspace,
      relPath: 'site/img/logo.png'
    })
  })

  it('round-trips an artifact', () => {
    const source = {
      kind: 'artifact' as const,
      hubId: 'local',
      artifactId: 'a1',
      name: 'report.pdf'
    }
    const url = toSlzSourceUrl(source, 'report.pdf')
    expect(parseSlzFileUrl(url)).toEqual({ kind: 'source', source, relPath: 'report.pdf' })
  })

  it('survives non-ASCII root paths', () => {
    const source = { ...workspace, rootPath: '/home/åsa/projekt ü' }
    expect(parseSlzFileUrl(toSlzSourceUrl(source, 'x.png'))).toMatchObject({ source })
  })

  it('parses a plain local path as local', () => {
    expect(parseSlzFileUrl(toSlzFileUrl('/Users/me/a b.png', 1))).toEqual({
      kind: 'local',
      path: '/Users/me/a b.png'
    })
  })

  it('refuses a malformed or escaping source', () => {
    const good = toSlzSourceUrl(workspace, 'a.txt')
    const token = good.split('/')[4]
    expect(parseSlzFileUrl(`${SLZ_FILE_PREFIX}/@src/not-base64!/a.txt`)).toBeNull()
    expect(parseSlzFileUrl(`${SLZ_FILE_PREFIX}/@src/${token}`)).toBeNull()
    expect(parseSlzFileUrl(`${SLZ_FILE_PREFIX}/@src/${token}/a/%2E%2E/%2E%2E/x`)).toBeNull()
    expect(parseSlzFileUrl(`${SLZ_FILE_PREFIX}/@src/${token}/a/..%2F..%2Fx`)).toBeNull()
    const bad = btoa(JSON.stringify({ kind: 'workspace', hubId: 'h' }))
    expect(parseSlzFileUrl(`${SLZ_FILE_PREFIX}/@src/${bad}/a.txt`)).toBeNull()
    expect(parseSlzFileUrl('slz-file://evil/Users/me/a.png')).toBeNull()
  })
})

describe('toArtifactFileUrl', () => {
  it('names the hub and artifact, answering to the stored file name', () => {
    const url = toArtifactFileUrl('h1', 'a1', '/hub/artifacts/t1/a1.html', 2, 'light')
    expect(url).toContain('?v=2&theme=light')
    expect(parseSlzFileUrl(url)).toEqual({
      kind: 'source',
      source: { kind: 'artifact', hubId: 'h1', artifactId: 'a1', name: 'a1.html' },
      relPath: 'a1.html'
    })
  })

  it('is the plain local path outside a hub scope', () => {
    expect(toArtifactFileUrl(null, 'a1', '/Users/me/a1.png', 1)).toBe(
      toSlzFileUrl('/Users/me/a1.png', 1)
    )
  })
})
