// Loads React Native's global declarations FIRST in this package's typecheck, before
// anything an import pulls in (tsconfig.json lists this file in `files`, which precede
// `include`). Why the order matters: `import type { AppRouter } from '@slayzone/api'`
// brings the hub's server sources into this program, and both React Native's globals
// and Node's (@types/node) declare `setTimeout` & co. Merged overloads put the LATER
// file's first, so Node's (returning `NodeJS.Timeout`, which the server code relies on:
// `.unref()`) must come after React Native's (returning `number`). Before Expo Router,
// the app's entry `index.ts` (importing `expo`) happened to load them in that order.
/// <reference types="react-native" />
