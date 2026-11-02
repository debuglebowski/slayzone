import { clientAddress } from '@slayzone/platform/client-address'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { computerUpgradeStatusSchema } from '@slayzone/computers/shared'

/** Machine-authenticated reporting; never contributes to computer liveness. */
export function createComputerUpgradeStatusHandler(deps: {
  authorize(key: string): Promise<string | null>
  save(id: string, status: unknown): Promise<void>
}) {
  const limits = new Map<string, { start: number; count: number }>()
  const allow = (key: string, max: number): boolean => {
    const now = Date.now()
    if (limits.size >= 10000)
      for (const [id, entry] of limits) if (now - entry.start >= 60_000) limits.delete(id)
    if (limits.size >= 10000 && !limits.has(key)) return false
    let entry = limits.get(key)
    if (!entry || now - entry.start >= 60_000) {
      entry = { start: now, count: 0 }
      limits.set(key, entry)
    }
    return ++entry.count <= max
  }
  return (req: IncomingMessage, res: ServerResponse): boolean => {
    if (req.url !== '/api/computers/upgrade-status' || req.method !== 'PUT') return false
    const respond = (code: number): void => {
      if (!res.headersSent) res.writeHead(code, { 'content-type': 'application/json' }).end('{}')
    }
    if (Number(req.headers['content-length']) > 16384) {
      respond(413)
      req.resume()
      return true
    }
    const bearer = req.headers.authorization?.match(/^Bearer ([^\s]{1,4096})$/)?.[1]
    if (!bearer) {
      respond(401)
      req.resume()
      return true
    }
    const chunks: Buffer[] = []
    let bytes = 0
    const deadline = setTimeout(() => {
      respond(408)
      req.destroy()
    }, 10_000)
    req.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 16384) {
        respond(413)
        req.destroy()
      } else chunks.push(chunk)
    })
    req.on('error', () => {
      clearTimeout(deadline)
      respond(400)
    })
    req.on('end', () => {
      clearTimeout(deadline)
      if (res.headersSent) return
      void (async () => {
        const ip = clientAddress(req) ?? 'unknown'
        const failure = limits.get('ip:' + ip)
        if (failure && Date.now() - failure.start < 60_000 && failure.count >= 60) {
          respond(429)
          return
        }
        const id = await deps.authorize(bearer)
        if (!id) {
          allow('ip:' + ip, 60)
          respond(401)
          return
        }
        if (!allow('computer:' + id, 60)) {
          respond(429)
          return
        }
        let raw: unknown
        try {
          raw = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        } catch {
          respond(400)
          return
        }
        const parsed = computerUpgradeStatusSchema.safeParse(raw)
        if (!parsed.success) {
          respond(400)
          return
        }
        await deps.save(id, parsed.data)
        respond(204)
      })().catch(() => respond(503))
    })
    return true
  }
}
