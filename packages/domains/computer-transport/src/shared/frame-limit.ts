/**
 * The one size limit for a computer-protocol frame, in both directions.
 *
 * A frame is ONE serialized JSON-RPC document — what `DuplexRpc` hands its
 * transport. The limit is in UTF-8 bytes (what a WebSocket text message or an
 * NDJSON line carries), not string characters. It governs:
 *  - hub ↔ computer WebSocket: the hub's `/computers` server (`maxPayload`), the
 *    computer's dialer (`maxPayload`), and both `DuplexRpc` endpoints (send side);
 *  - connector ↔ session host local socket (`computer-runtime` `socketPeer`).
 *
 * Senders refuse a frame over it (`DuplexRpc`): a reply turns into a
 * {@link FRAME_TOO_LARGE_CODE} error for that request, a request is rejected
 * locally, a notification is dropped with a diagnostic. The connection stays up.
 * Receivers that still get one (a non-conforming peer) must close the socket —
 * ws closes 1009 — so the limit sits on BOTH sides.
 *
 * 100 MiB = ws's default `maxPayload`, i.e. what every receiver of an older release
 * enforces. Changing it is a wire change: a sender must never exceed the limit of
 * a receiver it can still meet, so raising it needs a protocol bump.
 *
 * Imports nothing of this domain: `rpc.ts` and `frames.ts` both depend on it.
 *
 * @module computer/shared/frame-limit
 */

import { COMPUTER_FRAME_TOO_LARGE_RPC_CODE } from '@slayzone/platform/computer-frame-limit'

/** Largest serialized frame, in UTF-8 bytes, either direction. */
export const COMPUTER_FRAME_MAX_BYTES = 100 * 1024 * 1024

/**
 * JSON-RPC error code: a frame would exceed the receiver's limit, so it was not
 * sent. On a request, the caller's own request was too large (refused before
 * sending); on a reply, the peer's answer was. Not transient: the same request
 * gets the same answer. Listed as `ComputerTransportErrorCodes.frameTooLarge`. Defined
 * in `@slayzone/platform/computer-frame-limit` so tRPC/REST map it (413) without
 * importing this domain.
 */
export const FRAME_TOO_LARGE_CODE = COMPUTER_FRAME_TOO_LARGE_RPC_CODE
