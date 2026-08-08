import http from 'http'
import { AddressInfo } from 'net'

let serverPromise: Promise<{ host: string; port: number }> | undefined

const HTML = (title: string, body: string) =>
  `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`

function startServer(): Promise<{ host: string; port: number }> {
  if (serverPromise) return serverPromise
  serverPromise = new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = req.url || '/'
      if (url.startsWith('/slow')) {
        const ms = Number(new URL(url, 'http://x').searchParams.get('ms') ?? 1500)
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
          res.end(HTML('Slow Page', '<h1>Slow Page</h1>'))
        }, ms)
        return
      }
      if (url.startsWith('/redirect')) {
        const to = new URL(url, 'http://x').searchParams.get('to') || '/'
        res.writeHead(302, { location: to })
        res.end()
        return
      }
      // A page that actually declares a favicon, plus the icon itself.
      //
      // Deliberately its OWN route rather than a link in the shared `HTML`
      // template: adding `<link rel=icon>` to every fixture page would make
      // every browser spec issue an extra request, which the specs that count
      // requests or assert load-completion would notice.
      if (url.startsWith('/favicon.ico')) {
        // Smallest valid GIF — enough for a real fetch to succeed.
        res.writeHead(200, { 'content-type': 'image/gif' })
        res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'))
        return
      }
      if (url.startsWith('/favicon-page')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          `<!doctype html><html><head><title>Favicon Page</title>` +
            `<link rel="icon" href="/favicon.ico"></head>` +
            `<body><h1>Favicon Page</h1></body></html>`
        )
        return
      }
      if (url.startsWith('/title-')) {
        const name = decodeURIComponent(url.slice('/title-'.length).split('?')[0])
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(HTML(name, `<h1>${name}</h1>`))
        return
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(HTML('Test Page', '<h1>Test Page</h1><p>Local e2e fixture.</p>'))
    })
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({ host: '127.0.0.1', port: addr.port })
    })
    process.once('exit', () => {
      try {
        server.close()
      } catch {}
    })
  })
  return serverPromise
}

export async function getTestServer(): Promise<{ host: string; port: number; baseUrl: string }> {
  const { host, port } = await startServer()
  return { host, port, baseUrl: `http://${host}:${port}` }
}

export async function getTestUrl(path = '/'): Promise<string> {
  const { baseUrl } = await getTestServer()
  return `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`
}

export const TEST_HOST_MATCH = '127.0.0.1'
