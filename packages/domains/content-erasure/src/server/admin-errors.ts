export class AdminContentErasureError extends Error {
  constructor(
    readonly code:
      | 'ADMIN_ONLY'
      | 'USER_NOT_FOUND'
      | 'USER_NOT_DISABLED'
      | 'CONFIRMATION_MISMATCH'
      | 'INVALID_COMPUTER_RECEIPT',
    message: string
  ) {
    super(message)
    this.name = 'AdminContentErasureError'
  }
}
