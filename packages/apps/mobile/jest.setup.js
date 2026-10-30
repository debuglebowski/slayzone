// react-native-safe-area-context renders nothing until its native view reports the
// window's insets, which never happens in Node. Its own jest mock provides them.
// biome-ignore lint/correctness/noUndeclaredVariables: jest's global, in its setup file
jest.mock(
  'react-native-safe-area-context',
  () => require('react-native-safe-area-context/jest/mock').default
)
