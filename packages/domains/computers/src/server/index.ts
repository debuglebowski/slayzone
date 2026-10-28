export {
  registerComputer,
  registerOrReplaceComputer,
  deterministicLocalComputerId,
  retireStaleLocalComputers,
  getComputer,
  listComputers,
  touchComputerLastSeen,
  revokeComputer,
  unrevokeComputer,
  deleteComputer,
  setTaskComputer,
  setProjectDefaultComputer,
  setComputerOwner,
  resolveTaskComputerId,
  resolveTaskComputerIdOrDefault,
  type RegisterComputerInput
} from './store'
export {
  JOIN_TOKEN_PREFIX,
  DEFAULT_JOIN_TOKEN_TTL_MS,
  MAX_JOIN_TOKEN_TTL_MS,
  JOIN_TOKEN_TTL_TOO_LONG,
  JoinTokenTtlError,
  isAllowedJoinTokenTtl,
  hashJoinToken,
  decodeJoinToken,
  mintJoinToken,
  verifyJoinToken,
  auditJoinTokenRedeemRefused,
  recordJoinTokenRedeemed,
  type JoinTokenPayload,
  type MintJoinTokenInput,
  type MintedJoinToken,
  type VerifyJoinTokenResult
} from './join-tokens'
// Shared local-computer identity constant — re-exported through the server barrel
// so sidecar composition (which already imports from '@slayzone/computers/server')
// reads it from one place. Single source of truth for the local computer's name.
export { DEFAULT_LOCAL_COMPUTER_NAME } from '../shared'

export { recordComputerProjectPaths, resolveProjectByPath } from './project-paths'

export {
  reconcileMachineForComputer,
  pruneAnonymousEmptyMachines,
  renameMachine,
  pickMachineWinner,
  machinesByHostId,
  type MachineRecord
} from './machines'

export {
  assertComputerVisible,
  isComputerVisible,
  isComputerOwnedBy,
  ownsEveryComputerOnHost,
  listVisibleComputerIds,
  visibilityClause,
  claimComputer,
  setComputerVisibility,
  grantComputerAccess,
  revokeComputerAccess,
  type ComputerViewer
} from './visibility'

// The `computers` router, mounted by `@slayzone/api` at `computers`, its host seams
// (the live gateway registry; api's management-access policy) and the join-token
// mint decision it shares with the REST route.
export { computersRouter, type ComputersRouter, type ComputersMounts } from './computers-router'
export {
  setComputersDeps,
  getComputersDeps,
  getComputersDepsOrNull,
  type ComputersDeps,
  type ComputerGateway
} from './computers-deps'
export {
  setComputersRouterDeps,
  getComputersRouterDeps,
  type ComputersRouterDeps,
  type ComputerManagerAccess
} from './computers-router-deps'
export {
  decideJoinTokenMint,
  isJoinTokenRefusedError,
  JoinTokenRefusedError,
  JOIN_TOKEN_OWNER_REQUIRED,
  JOIN_TOKEN_OWNER_UNKNOWN,
  JOIN_TOKEN_OWNER_DISABLED,
  JOIN_TOKEN_OWNER_UNSUPPORTED,
  type JoinTokenRefusalCode,
  type JoinTokenAccount,
  type FindJoinTokenAccount,
  type JoinTokenMintDecision
} from './join-token-policy'
