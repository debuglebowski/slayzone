/**
 * The transports recognise a computer's own-policy refusal by the platform's copy of
 * its code (`COMPUTER_REFUSED_RPC_CODE`, platform/path-scope), so tRPC answers it as
 * CONFLICT and REST as 409 without importing this domain (review 2, B3). The copy
 * must stay the wire's code, and an `RpcError` carrying it must be recognised.
 */
import { describe, expect, it } from 'vitest'
import { COMPUTER_REFUSED_RPC_CODE, isComputerRefusal } from '@slayzone/platform/path-scope'
import { ComputerTransportErrorCodes } from './frames'
import { RpcError } from './rpc'

describe('computer refusal code', () => {
  it("is the wire's refusedByComputer, and an RpcError with it is a refusal", () => {
    expect(COMPUTER_REFUSED_RPC_CODE).toBe(ComputerTransportErrorCodes.refusedByComputer)
    expect(
      isComputerRefusal(new RpcError(ComputerTransportErrorCodes.refusedByComputer, 'no'))
    ).toBe(true)
    expect(isComputerRefusal(new RpcError(ComputerTransportErrorCodes.projectNotPlaced, 'p'))).toBe(
      false
    )
  })
})
