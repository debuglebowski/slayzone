/** The app supplies its own self-contained bundle; domains never import this entry. */
import { fileURLToPath } from 'node:url'
export function computerStorageWorkerEntry(): string {
  if (typeof __filename === 'string' && __filename.endsWith('.cjs')) return __filename
  return fileURLToPath(new URL('../dist/bin.cjs', import.meta.url))
}
