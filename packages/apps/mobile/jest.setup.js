// react-native-safe-area-context renders nothing until its native view reports the
// window's insets, which never happens in Node. Its own jest mock provides them.
// biome-ignore lint/correctness/noUndeclaredVariables: jest's global, in its setup file
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default
)

// react-native-webview needs its native half (a TurboModule) as soon as it is imported,
// and any suite that mounts the routes imports it. Every suite gets the test stand-in,
// a host view that keeps every prop (src/artifacts/webview-mock.tsx).
// biome-ignore lint/correctness/noUndeclaredVariables: jest's global, in its setup file
jest.mock('react-native-webview', () => require('./src/artifacts/webview-mock'))
