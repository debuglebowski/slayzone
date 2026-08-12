export {
  registerRunner,
  registerOrReplaceRunner,
  deterministicLocalRunnerId,
  retireStaleLocalRunners,
  getRunner,
  listRunners,
  touchRunnerLastSeen,
  revokeRunner,
  setTaskRunner,
  setProjectDefaultRunner,
  setRunnerOwner,
  resolveTaskRunnerId,
  resolveTaskRunnerIdOrDefault,
  type RegisterRunnerInput
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
// Shared local-runner identity constant — re-exported through the server barrel
// so sidecar composition (which already imports from '@slayzone/computers/server')
// reads it from one place. Single source of truth for the local runner's name.
export { DEFAULT_LOCAL_RUNNER_NAME } from '../shared'

export { recordRunnerProjectPaths, resolveProjectByPath } from './project-paths'
