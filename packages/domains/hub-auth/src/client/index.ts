// `@slayzone/hub-auth/client` — the hub sign-in client every SlayZone client shares:
// desktop main, the CLI, the web shell's pure parts, and a future React Native app.
//
// PLATFORM-NEUTRAL: no `node:*`, no Electron, no DOM globals (`purity.test.ts` holds
// that). It needs only the WHATWG `URL`/`URLSearchParams`, `setTimeout` and, for the
// fetch transport, `AbortController`. HTTP is injected (`HubTransport`): Node clients
// pass `nodeHubTransport` from `@slayzone/hub-auth/client-node`.

export {
  createFetchHubTransport,
  HUB_TRANSPORT_TIMEOUT,
  HubTransportTimeoutError,
  isHubTransportTimeout,
  transportErrorText,
  type HubFetch,
  type HubHttpRequest,
  type HubHttpResponse,
  type HubTransport
} from './transport'
export {
  DEVICE_CODE_GRANT_TYPE,
  HUB_AUTH_PATHS,
  HUB_DEVICE_CLIENT_IDS,
  type HubDeviceClientId
} from './protocol'
export {
  fetchHubHealth,
  healthProbeOf,
  HUB_BROWSER_SIGN_IN_UNKNOWN,
  hubBrowserSignInOf,
  probeHubHealth,
  signInMethodsOf,
  type HubBrowserSignIn,
  type HubHealthProbe,
  type HubHealthRead,
  type HubSignInMethods
} from './health'
export { signInWithPassword, type HubPasswordSignInResult } from './password'
export {
  isHubOwnPage,
  requestDeviceCode,
  waitForDeviceToken,
  type DeviceTokenWaitOptions,
  type HubDeviceCode,
  type HubDeviceCodeResult,
  type HubDeviceTokenResult
} from './device'
export { fetchSessionEmail } from './session'
export type { HubTokenStore } from './token-store'
export {
  SIGN_IN_ERROR_PARAMS,
  signInErrorFrom,
  signInErrorMessage,
  type SignInError
} from './sign-in-error'
