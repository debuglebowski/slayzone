import { statfsSync } from 'node:fs'

/** Bytes an unprivileged process can still write on the disk holding `dir` (statfs). */
export function freeDiskBytes(dir: string): number {
  const stat = statfsSync(dir)
  return Number(stat.bavail) * Number(stat.bsize)
}
