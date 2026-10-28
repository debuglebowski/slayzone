import type { CriteriaType } from './types'

export function stripAnsi(str: string): string {
  return str
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b\[[?0-9;:]*[ -/]*[@-~]/g, '') // CSI sequences (incl. private modes like ?2026)
    .replace(/\x1b[()][AB012]/g, '') // Character set sequences
    .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f]/g, '') // Control characters
}

export function checkCriteria(output: string, type: CriteriaType, pattern: string): boolean {
  const stripped = stripAnsi(output)
  switch (type) {
    case 'contains':
      return stripped.includes(pattern)
    case 'not-contains':
      return !stripped.includes(pattern)
    case 'regex':
      try {
        return new RegExp(pattern).test(stripped)
      } catch {
        return false
      }
  }
}
