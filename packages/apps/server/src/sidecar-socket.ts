import { createServer, type Server, type Socket } from 'node:net'
import { mkdirSync, unlinkSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

// Unix-domain-socket JSON-RPC 2.0 server — the JS half of the chromium fork's
// C++ `slayzone::SidecarClient` (patches/chromium/0003 + 0030). The shell
// connects to `$SLAYZONE_RUNTIME_DIR/sidecar.sock` and speaks LSP framing
// (`Content-Length: N\r\n\r\n{json}`). It sends `sidecar.hello` on connect,
// `sidecar.ping` every 30s, and — crucially — forwards `slayzone://` OAuth
// deep-links via `auth:deep-link` ({ url }). This server answers the keepalive
// handshakes and routes `auth:deep-link` to `onAuthDeepLink`, which the sidecar
// turns into an `app.auth.onCallback` push to the renderer.
//
// Standalone-only: the Electron host has no chromium shell, so server.ts starts
// this exclusively in the non-supervised (fork) boot. Best-effort throughout —
// if the socket can't bind, the C++ side simply reports "not connected" and
// retries; nothing else in the sidecar depends on it.

const MAX_FRAME_BYTES = 1024 * 1024 // mirror the C++ kMaxRecvBuffer ceiling

export interface SidecarSocketServer {
  socketPath: string
  close: () => Promise<void>
}

/** Resolve the socket path the same way the C++ shim does (ResolveSocketPath). */
export function resolveSidecarSocketPath(runtimeDir?: string): string {
  const override = runtimeDir ?? process.env.SLAYZONE_RUNTIME_DIR
  if (override && override.trim()) return join(override, 'sidecar.sock')
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'SlayZone', 'run', 'sidecar.sock')
  }
  const xdg = process.env.XDG_RUNTIME_DIR
  if (xdg && xdg.trim()) return join(xdg, 'slayzone', 'sidecar.sock')
  // Last resort — keep it under the home dir so it's writable.
  return join(homedir(), '.slayzone', 'run', 'sidecar.sock')
}

interface JsonRpcMessage {
  jsonrpc?: string
  id?: number | string | null
  method?: string
  params?: Record<string, unknown>
}

/** `Content-Length: N\r\n\r\n{json}` — identical framing to the C++ FrameMessage. */
function frame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8')
  return Buffer.concat([header, body])
}

export function startSidecarSocketServer(opts: {
  onAuthDeepLink: (url: string) => void
  log?: (msg: string) => void
  runtimeDir?: string
}): SidecarSocketServer {
  const log = opts.log ?? (() => {})
  const socketPath = resolveSidecarSocketPath(opts.runtimeDir)

  try {
    mkdirSync(dirname(socketPath), { recursive: true })
  } catch {
    /* parent dir best-effort */
  }
  // A stale socket file from a crashed prior run makes listen() throw EADDRINUSE.
  try {
    if (existsSync(socketPath)) unlinkSync(socketPath)
  } catch {
    /* ignore */
  }

  const sockets = new Set<Socket>()

  const handleConnection = (socket: Socket): void => {
    sockets.add(socket)
    let buffer = Buffer.alloc(0)

    const respond = (id: JsonRpcMessage['id'], result: unknown): void => {
      if (id === undefined || id === null) return // notification — no reply
      try {
        socket.write(frame({ jsonrpc: '2.0', id, result }))
      } catch {
        /* peer gone */
      }
    }
    const respondError = (id: JsonRpcMessage['id'], code: number, message: string): void => {
      if (id === undefined || id === null) return
      try {
        socket.write(frame({ jsonrpc: '2.0', id, error: { code, message } }))
      } catch {
        /* peer gone */
      }
    }

    const dispatch = (msg: JsonRpcMessage): void => {
      const { method, id, params } = msg
      switch (method) {
        case 'sidecar.hello':
          respond(id, { ok: true, version: 'sidecar-js-1' })
          return
        case 'sidecar.ping':
          respond(id, { ok: true })
          return
        case 'auth:deep-link': {
          const url = typeof params?.url === 'string' ? params.url : ''
          if (url) {
            try {
              opts.onAuthDeepLink(url)
            } catch (e) {
              log(`auth:deep-link handler threw: ${String(e)}`)
            }
          }
          respond(id, { ok: true })
          return
        }
        default:
          if (method) respondError(id, -32601, `method not found: ${method}`)
      }
    }

    // Consume as many complete LSP frames as the buffer holds.
    const drain = (): void => {
      for (;;) {
        const headerEnd = buffer.indexOf('\r\n\r\n')
        if (headerEnd === -1) break
        const headers = buffer.subarray(0, headerEnd).toString('latin1')
        const match = /Content-Length:\s*(\d+)/i.exec(headers)
        if (!match) {
          // Malformed header block — skip it to recover (mirrors the C++).
          buffer = buffer.subarray(headerEnd + 4)
          continue
        }
        const bodyLen = Number(match[1])
        if (!Number.isFinite(bodyLen) || bodyLen > MAX_FRAME_BYTES) {
          buffer = buffer.subarray(headerEnd + 4)
          continue
        }
        if (buffer.length < headerEnd + 4 + bodyLen) break // incomplete — wait for more
        const body = buffer.subarray(headerEnd + 4, headerEnd + 4 + bodyLen).toString('utf8')
        buffer = buffer.subarray(headerEnd + 4 + bodyLen)
        let msg: JsonRpcMessage | null = null
        try {
          msg = JSON.parse(body) as JsonRpcMessage
        } catch {
          log('dropped unparseable frame body')
        }
        if (msg && typeof msg === 'object') dispatch(msg)
      }
    }

    socket.on('data', (chunk) => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk])
      if (buffer.length > MAX_FRAME_BYTES * 2) {
        log('recv buffer overflow; resetting connection')
        buffer = Buffer.alloc(0)
        socket.destroy()
        return
      }
      drain()
    })
    socket.on('error', () => {
      /* peer reset — connection cleanup runs on 'close' */
    })
    socket.on('close', () => {
      sockets.delete(socket)
    })
  }

  const server: Server = createServer(handleConnection)
  server.on('error', (err) => {
    log(`sidecar socket server error: ${String(err)}`)
  })
  server.listen(socketPath, () => {
    log(`sidecar socket listening at ${socketPath}`)
  })

  return {
    socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) {
          try {
            s.destroy()
          } catch {
            /* ignore */
          }
        }
        sockets.clear()
        server.close(() => {
          try {
            if (existsSync(socketPath)) unlinkSync(socketPath)
          } catch {
            /* ignore */
          }
          resolve()
        })
      })
  }
}
