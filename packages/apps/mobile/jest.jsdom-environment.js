// The app's test environment (jest-expo's iOS one), plus jsdom for the suites that run
// web pages and parse documents for real: `@jest-environment ./jest.jsdom-environment.js`.
// jsdom's dependencies are ES modules, which Node 24 requires natively but jest's module
// registry (CommonJS) cannot load, so the environment — loaded by Node itself — hands
// the suite jsdom's API as `globalThis.__jsdom` (src/artifacts/export/testing-web-view.ts).
const { testEnvironment } = require('jest-expo/ios/jest-preset')
const jsdom = require('jsdom')

const NativeEnvironment = require(testEnvironment)

class JsdomEnvironment extends NativeEnvironment {
  constructor(config, context) {
    super(config, context)
    this.global.__jsdom = { JSDOM: jsdom.JSDOM, VirtualConsole: jsdom.VirtualConsole }
  }
}

module.exports = JsdomEnvironment
