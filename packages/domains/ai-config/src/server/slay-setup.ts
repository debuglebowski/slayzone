/** Machine-local Slay setup primitives. No DB or hub state. */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { PROVIDER_PATHS, COMPUTER_PROVIDER_PATHS } from '../shared/provider-registry'

export function checkSlayConfigured(projectPath: string, homeDir = homedir()): boolean {
  const files = [
    ...Object.values(PROVIDER_PATHS).flatMap((mapping) =>
      mapping.rootInstructions ? [join(resolve(projectPath), mapping.rootInstructions)] : []
    ),
    ...Object.values(COMPUTER_PROVIDER_PATHS).flatMap((spec) =>
      spec.instructions ? [join(homeDir, spec.baseDir, spec.instructions)] : []
    )
  ]
  return files.some((file) => existsSync(file) && /\bslay\b/i.test(readFileSync(file, 'utf-8')))
}
