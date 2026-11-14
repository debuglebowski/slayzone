/**
 * The computer protocol's "frame too large" refusal, as the transports see it.
 *
 * A frame over the hub ↔ computer limit is never sent (`DuplexRpc`,
 * `@slayzone/computer-transport/shared` frame-limit): a reply becomes an `RpcError`
 * with this code for that one request, a request is rejected before sending. The
 * code is DEFINED here — computer-transport's `ComputerTransportErrorCodes.frameTooLarge`
 * re-exports it — so tRPC and REST can recognise it without importing that domain.
 *
 * @module platform/computer-frame-limit
 */

/** JSON-RPC error code of a refused oversized frame (`frameTooLarge`). */
export const COMPUTER_FRAME_TOO_LARGE_RPC_CODE = -32008

/** The stable code a client gets for it (tRPC `data.appCode`, REST `code`). */
export const COMPUTER_FRAME_TOO_LARGE = 'COMPUTER_FRAME_TOO_LARGE'

/**
 * Is `err` a refused oversized frame (an `RpcError` with
 * {@link COMPUTER_FRAME_TOO_LARGE_RPC_CODE})? Structural, as it crosses module copies.
 * Not transient: the same request is refused again — tRPC `PAYLOAD_TOO_LARGE`, REST 413,
 * with the message naming the method and both sizes.
 */
export function isComputerFrameTooLarge(err: unknown): err is Error & { code: number } {
  return (
    err instanceof Error &&
    err.name === 'RpcError' &&
    (err as { code?: unknown }).code === COMPUTER_FRAME_TOO_LARGE_RPC_CODE
  )
}
