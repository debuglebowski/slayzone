import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { vi } from 'vitest'

/**
 * Windows flush semantics on any host. Node's fsync on Windows is FlushFileBuffers,
 * which needs GENERIC_WRITE: fsync of a handle opened read-only fails EPERM
 * (ERROR_ACCESS_DENIED). POSIX accepts any descriptor, so a mac/Linux run never
 * sees it. This reports `process.platform` as win32 (so win32 branches run) and
 * rejects fsync on read-only sync fds and FileHandles. Returns the restore function.
 */
export function emulateWindowsFsync(): () => void {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
  const readOnly = new Set<number>()
  const isReadOnly = (flags: unknown) =>
    flags === undefined ||
    flags === null ||
    flags === 'r' ||
    flags === 'rs' ||
    flags === 'sr' ||
    (typeof flags === 'number' && (flags & 3) === fs.constants.O_RDONLY)
  const denied = (syscall: string) =>
    Object.assign(new Error(`EPERM: operation not permitted, ${syscall}`), {
      code: 'EPERM',
      errno: -1,
      syscall
    })
  const openSync = fs.openSync
  const closeSync = fs.closeSync
  const fsyncSync = fs.fsyncSync
  const openAsync = fs.promises.open
  const spies = [
    vi.spyOn(fs, 'openSync').mockImplementation(((
      file: fs.PathLike,
      flags?: fs.OpenMode,
      mode?: fs.Mode
    ) => {
      const fd = openSync(file, flags ?? 'r', mode)
      if (isReadOnly(flags)) readOnly.add(fd)
      return fd
    }) as typeof fs.openSync),
    vi.spyOn(fs, 'closeSync').mockImplementation((fd) => {
      readOnly.delete(fd)
      closeSync(fd)
    }),
    vi.spyOn(fs, 'fsyncSync').mockImplementation((fd) => {
      if (readOnly.has(fd)) throw denied('fsync')
      fsyncSync(fd)
    }),
    vi.spyOn(fs.promises, 'open').mockImplementation((async (
      file: fs.PathLike,
      flags?: fs.OpenMode,
      mode?: fs.Mode
    ) => {
      const handle = await openAsync(file, flags ?? 'r', mode)
      if (isReadOnly(flags)) handle.sync = () => Promise.reject(denied('fsync'))
      return handle
    }) as typeof fs.promises.open)
  ]
  syncBuiltinESMExports()
  return () => {
    for (const spy of spies) spy.mockRestore()
    syncBuiltinESMExports()
    Object.defineProperty(process, 'platform', platform)
  }
}
