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
  hashJoinToken,
  decodeJoinToken,
  mintJoinToken,
  verifyJoinToken,
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
  listVisibleComputerIds,
  visibilityClause,
  claimComputer,
  setComputerVisibility,
  grantComputerAccess,
  revokeComputerAccess,
  type ComputerViewer
} from './visibility'
