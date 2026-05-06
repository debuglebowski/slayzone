export type VersionErrorCode =
  | 'NOT_FOUND'
  | 'AMBIGUOUS_REF'
  | 'NAMED_IMMUTABLE'
  | 'NAME_TAKEN'
  | 'NAME_RESERVED'
  | 'BLOB_MISSING'
  | 'BLOB_HASH_MISMATCH'
  | 'INVALID_REF'

export class VersionError extends Error {
  readonly code: VersionErrorCode
  readonly details: Record<string, unknown>

  constructor(code: VersionErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'VersionError'
    this.code = code
    this.details = details
  }

  toJSON(): { name: string; code: VersionErrorCode; message: string; details: Record<string, unknown> } {
    return { name: this.name, code: this.code, message: this.message, details: this.details }
  }
}

export function isVersionError(err: unknown): err is VersionError {
  return err instanceof VersionError
}
