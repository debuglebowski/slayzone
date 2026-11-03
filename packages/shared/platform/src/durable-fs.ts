import { closeSync, fsyncSync, openSync, promises as fsAsync } from 'node:fs'

/**
 * Open flags for a handle whose only job is to fsync an existing regular file.
 *
 * Windows: Node's fsync is FlushFileBuffers, which requires GENERIC_WRITE, so a
 * read-only handle fails EPERM. The file must therefore not carry the read-only
 * attribute — give private copies an owner-writable mode before flushing them.
 * POSIX: fsync accepts any descriptor; demanding write access there would only
 * make read-only files unsyncable. Read at call time, not import time.
 */
const flushFlags = () => (process.platform === 'win32' ? 'r+' : 'r')

/** Flush a regular file's data and metadata to stable storage. Directories: not here. */
export function fsyncFileSync(file: string): void {
  const fd = openSync(file, flushFlags())
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

/** Async {@link fsyncFileSync}. */
export async function fsyncFile(file: string): Promise<void> {
  const handle = await fsAsync.open(file, flushFlags())
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}
