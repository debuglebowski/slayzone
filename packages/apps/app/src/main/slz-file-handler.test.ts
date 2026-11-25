import { describe, expect, it, vi } from 'vitest'
import {
  toHtmlArtifactPreviewUrl,
  toSlzFileUrl,
  toSlzSourceUrl,
  type SlzFileSource
} from '@slayzone/platform/slz-file-url'
import { withArtifactPreviewMode } from '@slayzone/platform/artifact-controls'
import { createSlzFileHandler } from './slz-file-handler'

const HOME = '/Users/me'
const workspace: SlzFileSource = {
  kind: 'workspace',
  hubId: 'remote-1',
  rootPath: '/home/ann/proj',
  taskId: 't1'
}

function setup(over: Partial<Parameters<typeof createSlzFileHandler>[0]> = {}) {
  const fetch = vi.fn(async () => new Response('remote-bytes', { status: 200 }))
  const readFile = vi.fn(async () => Buffer.from('local-bytes'))
  const handler = createSlzFileHandler({
    homeDir: HOME,
    resolveHub: async (id) =>
      id === 'remote-1' ? { origin: 'https://hub.example', token: 'tok' } : null,
    fetch: fetch as unknown as typeof globalThis.fetch,
    readFile,
    ...over
  })
  return { handler, fetch, readFile }
}

const req = (url: string, headers?: Record<string, string>) => new Request(url, { headers })

describe('isolated HTML artifact URLs', () => {
  it('serves the artifact from its hub with its preview theme and sandbox', async () => {
    const { handler, fetch, readFile } = setup()
    const url = await toHtmlArtifactPreviewUrl('remote-1', 'a1', '/hub/report.html', 2, 'dark')
    const res = await handler(req(url))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(res.headers.get('content-security-policy')).toBe(
      'sandbox allow-scripts allow-same-origin'
    )
    expect(await res.text()).toContain('color-scheme:dark')
    expect(fetch).toHaveBeenCalledWith(
      'https://hub.example/api/artifacts/a1/content',
      expect.anything()
    )
    expect(readFile).not.toHaveBeenCalled()
  })

  it('refuses to serve another artifact, a workspace, or a disk path under an artifact origin', async () => {
    const { handler, fetch, readFile } = setup()
    const original = new URL(await toHtmlArtifactPreviewUrl('remote-1', 'a1', '/report.html'))
    const origin = `${original.protocol}//${original.host}`
    const otherArtifact = new URL(await toHtmlArtifactPreviewUrl('remote-1', 'a2', '/report.html'))
    const otherHub = new URL(await toHtmlArtifactPreviewUrl('remote-2', 'a1', '/report.html'))
    const workspaceFile = new URL(toSlzSourceUrl(workspace, 'report.html'))
    for (const path of [
      otherArtifact.pathname,
      otherHub.pathname,
      workspaceFile.pathname,
      `${HOME}/report.html`
    ]) {
      expect((await handler(req(origin + path))).status).toBe(403)
    }
    expect(fetch).not.toHaveBeenCalled()
    expect(readFile).not.toHaveBeenCalled()
  })
})

describe('local URLs', () => {
  it('serves a file under home with its mime type', async () => {
    const { handler, readFile } = setup()
    const res = await handler(req(toSlzFileUrl(`${HOME}/a.png`)))
    expect(readFile).toHaveBeenCalledWith(`${HOME}/a.png`)
    expect(res.headers.get('content-type')).toBe('image/png')
    expect(await res.text()).toBe('local-bytes')
  })

  it('refuses a path outside home without reading it', async () => {
    const { handler, readFile } = setup()
    const res = await handler(req(toSlzFileUrl('/etc/passwd')))
    expect(readFile).not.toHaveBeenCalled()
    expect(await res.text()).toContain('Path outside home directory')
  })

  it('refuses a foreign host', async () => {
    const { handler } = setup()
    expect((await handler(req('slz-file://other/Users/me/a.png'))).status).toBe(403)
  })
})

describe('source URLs', () => {
  it('fetches a workspace file from its hub with the bearer, never from disk', async () => {
    const { handler, fetch, readFile } = setup()
    const res = await handler(req(toSlzSourceUrl(workspace, 'site/index.html')))
    expect(readFile).not.toHaveBeenCalled()
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    const u = new URL(url)
    expect(u.origin + u.pathname).toBe('https://hub.example/api/files/raw')
    expect(Object.fromEntries(u.searchParams)).toEqual({
      rootPath: '/home/ann/proj',
      path: 'site/index.html',
      taskId: 't1'
    })
    expect(new Headers(init.headers).get('authorization')).toBe('Bearer tok')
    expect(res.headers.get('content-type')).toBe('text/html')
    expect(await res.text()).toBe('remote-bytes')
  })

  it('fetches an artifact from the hub and drops its download disposition', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('%PDF', {
          headers: {
            'content-type': 'application/octet-stream',
            'content-disposition': 'attachment; filename="r.pdf"',
            'set-cookie': 'x=1'
          }
        })
    )
    const { handler } = setup({ fetch: fetch as unknown as typeof globalThis.fetch })
    const res = await handler(
      req(
        toSlzSourceUrl(
          { kind: 'artifact', hubId: 'remote-1', artifactId: 'a 1', name: 'r.pdf' },
          'r.pdf'
        )
      )
    )
    expect((fetch.mock.calls[0] as unknown as [string])[0]).toBe(
      'https://hub.example/api/artifacts/a%201/content'
    )
    expect(res.headers.get('content-type')).toBe('application/pdf')
    expect(res.headers.get('content-disposition')).toBeNull()
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  it('answers only to the artifact own name, not to relative references inside it', async () => {
    const { handler, fetch } = setup()
    const source = {
      kind: 'artifact' as const,
      hubId: 'remote-1',
      artifactId: 'a1',
      name: 'p.html'
    }
    const res = await handler(req(toSlzSourceUrl(source, 'logo.png')))
    expect(fetch).not.toHaveBeenCalled()
    expect(await res.text()).toContain('File not found')
  })

  it('forwards Range and passes a partial response through', async () => {
    const fetch = vi.fn(
      async () =>
        new Response('ab', {
          status: 206,
          headers: { 'content-range': 'bytes 0-1/10', 'accept-ranges': 'bytes' }
        })
    )
    const { handler } = setup({ fetch: fetch as unknown as typeof globalThis.fetch })
    const res = await handler(req(toSlzSourceUrl(workspace, 'a.pdf'), { range: 'bytes=0-1' }))
    const init = (fetch.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect(new Headers(init.headers).get('range')).toBe('bytes=0-1')
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 0-1/10')
  })

  it('applies the forced HTML theme to a remote page', async () => {
    const fetch = vi.fn(async () => new Response('<html><head></head><body>x</body></html>'))
    const { handler } = setup({ fetch: fetch as unknown as typeof globalThis.fetch })
    const res = await handler(req(toSlzSourceUrl(workspace, 'a.html', 1, 'dark')))
    const text = await res.text()
    expect(text).toContain('x</body>')
    expect(text.length).toBeGreaterThan('<html><head></head><body>x</body></html>'.length)
  })

  it('shows the hub refusal instead of the bytes', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ ok: false, code: 'FILE_NOT_FOUND', error: 'No such file' }, { status: 404 })
    )
    const { handler } = setup({ fetch: fetch as unknown as typeof globalThis.fetch })
    const text = await (await handler(req(toSlzSourceUrl(workspace, 'gone.png')))).text()
    expect(text).toContain('File not found')
    expect(text).toContain('No such file')
  })

  it('says the hub is unavailable when it is unknown or unreachable', async () => {
    const { handler } = setup()
    const unknown = await handler(req(toSlzSourceUrl({ ...workspace, hubId: 'gone' }, 'a.png')))
    expect(await unknown.text()).toContain('Hub unavailable')

    const down = setup({
      fetch: (async () => {
        throw new TypeError('fetch failed')
      }) as unknown as typeof globalThis.fetch
    })
    const res = await down.handler(req(toSlzSourceUrl(workspace, 'a.png')))
    expect(await res.text()).toContain('Hub unavailable')
  })
})

describe('artifact controls runtime', () => {
  const PAGE =
    '<html><head></head><body><p>s</p><slay-artifact-controls></slay-artifact-controls></body></html>'
  const RUNTIME = 'id="slz-artifact-controls-runtime"'

  it('injects the screen and controls runtimes into a local page, by URL mode', async () => {
    const { handler } = setup({ readFile: vi.fn(async () => Buffer.from(PAGE)) })
    const url = toSlzFileUrl(`${HOME}/a.html`, 1, 'dark')
    const plain = await (await handler(req(url))).text()
    expect(plain).not.toContain(RUNTIME)
    const screen = await (
      await handler(req(withArtifactPreviewMode(url, { kind: 'screen' })))
    ).text()
    expect(screen).toContain(RUNTIME)
    expect(screen).toContain('color-scheme:dark')
    const controls = await (
      await handler(req(withArtifactPreviewMode(url, { kind: 'controls', position: 'right' })))
    ).text()
    expect(controls).toContain(RUNTIME)
    expect(controls).toContain('"right"')
  })

  it('injects into an artifact served by its hub and drops the stale length', async () => {
    const fetch = vi.fn(
      async () => new Response(PAGE, { headers: { 'content-length': String(PAGE.length) } })
    )
    const { handler } = setup({ fetch: fetch as unknown as typeof globalThis.fetch })
    const url = await toHtmlArtifactPreviewUrl('remote-1', 'a1', '/hub/report.html', 2)
    const res = await handler(
      req(withArtifactPreviewMode(url, { kind: 'controls', position: 'top' }))
    )
    expect(await res.text()).toContain(RUNTIME)
    expect(res.headers.get('content-length')).toBeNull()
  })

  it('leaves files other than HTML alone', async () => {
    const { handler } = setup()
    const url = withArtifactPreviewMode(toSlzFileUrl(`${HOME}/a.png`), { kind: 'screen' })
    expect(await (await handler(req(url))).text()).toBe('local-bytes')
  })
})
