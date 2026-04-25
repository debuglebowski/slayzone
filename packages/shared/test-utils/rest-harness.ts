/**
 * Mount an Express app on an ephemeral port for REST integration tests.
 * Uses node's native fetch — no supertest dependency.
 *
 * Usage:
 *   import express from 'express'
 *   const app = express()
 *   app.use(express.json())
 *   registerCreateTaskRoute(app, { db, notifyRenderer: () => {} })
 *   const h = await mountRestApp(app)
 *   const res = await h.request('POST', '/api/tasks', { ... })
 *   await h.close()
 */
import { createServer, type Server } from 'node:http'
import type { Express } from 'express'

export interface RestHarness {
  port: number
  url: string
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<{
    status: number
    body: T
  }>
  close(): Promise<void>
}

export async function mountRestApp(app: Express): Promise<RestHarness> {
  const server: Server = createServer(app)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('Bad server address')
  const port = addr.port
  const url = `http://127.0.0.1:${port}`

  return {
    port,
    url,
    async request<T>(method: string, path: string, body?: unknown) {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined
      })
      const text = await res.text()
      let parsed: unknown = text
      try { parsed = text ? JSON.parse(text) : null } catch { /* keep text */ }
      return { status: res.status, body: parsed as T }
    },
    async close() {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}
