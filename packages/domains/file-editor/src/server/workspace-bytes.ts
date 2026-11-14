/**
 * The raw-byte read contract, hub-safe (no fs): what a slice read returns, its size
 * cap, and the containment error — shared by the in-process read (`file-ops`), the
 * routed one (computer-transport) and the hub's `GET /api/files/raw`, which must
 * not import `file-ops` (lint:server-boundary).
 */

/**
 * Largest slice one raw byte read returns. Mirrored by computer-transport's
 * `FS_READ_BYTES_MAX_CHUNK` (the wire cap; frames cannot import this package) —
 * the routed and in-process reads must chunk identically.
 */
export const WORKSPACE_READ_BYTES_MAX_CHUNK = 256 * 1024

/** One slice of a file, plus what identifies the version it was read from. */
export interface ReadBytesResult {
  bytes: Uint8Array
  /** Size of the WHOLE file. */
  size: number
  mtimeMs: number
  /** The slice reaches the end of the file. */
  eof: boolean
}

/** A root-relative path that resolves outside its root. Message unchanged from the plain Error it was. */
export class PathTraversalError extends Error {
  constructor() {
    super('Path traversal denied')
    this.name = 'PathTraversalError'
  }
}

/** `instanceof`, plus a structural match for an error that crossed a module copy. */
export function isPathTraversalError(err: unknown): err is PathTraversalError {
  return (
    err instanceof PathTraversalError || (err instanceof Error && err.name === 'PathTraversalError')
  )
}
