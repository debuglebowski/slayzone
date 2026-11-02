/**
 * The terminal is an Expo DOM component (`TerminalDom.tsx`, `'use dom'`): Metro bundles it
 * for the web platform, where `react-native` resolves to `react-native-web`. In a dev
 * bundle the DOM entry (`expo/dom/entry`) also loads `@expo/log-box`, whose web build
 * imports `react-native-web/dist/exports/*` directly — so without `react-native-web`
 * installed the dev DOM bundle fails ("DOM Bundling failed … TerminalDom.tsx") and every
 * terminal pane stays blank, while `expo export` (no log-box) still builds.
 */
import path from 'node:path'

const fromPackage = (pkg: string): string =>
  path.dirname(
    require.resolve(`${pkg}/package.json`, { paths: [require.resolve('expo/package.json')] })
  )

describe('DOM component bundle dependencies', () => {
  it('resolves react-native-web from the app (Metro aliases react-native to it on web)', () => {
    expect(() => require.resolve('react-native-web/package.json')).not.toThrow()
  })

  it("resolves what the dev DOM entry's log-box imports from react-native-web", () => {
    const logBox = fromPackage('@expo/log-box')
    expect(() =>
      require.resolve('react-native-web/dist/exports/NativeEventEmitter', { paths: [logBox] })
    ).not.toThrow()
  })
})
