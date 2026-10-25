// Worker half of the dev-only cached React Compiler transform
// (see ./react-compiler-cache.ts). Runs Babel + babel-plugin-react-compiler off
// Vite's main thread. Plain .mjs: worker_threads load it straight from disk, no
// TS transpile step.
//
// `compileReact` reproduces EXACTLY the Babel call @vitejs/plugin-react makes
// for a client module when its babel config is `{ plugins: ['babel-plugin-react-compiler'] }`
// and fast refresh is off (same options object, same parser/generator opts), so
// the emitted code is byte-identical to the uncached path. Sourcemaps are not
// generated: the dev server strips them anyway (strip-dev-sourcemaps), and
// Babel's generated code does not depend on `sourceMaps`.
// verify-react-compiler-cache.mjs (scratch bench) asserts the identity.
import { createRequire } from 'node:module'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'

const appRequire = createRequire(new URL('../package.json', import.meta.url))

let babel
let compilerPlugin
function load() {
  if (!babel) {
    babel = appRequire('@babel/core')
    const mod = appRequire('babel-plugin-react-compiler')
    compilerPlugin = mod.default ?? mod
  }
}

const tsRE = /\.tsx?$/

/**
 * @param {{ code: string, id: string, root: string }} req
 * @returns {string}
 */
export function compileReact({ code, id, root }) {
  load()
  const [filepath] = id.split('?')
  const parserPlugins = []
  if (!filepath.endsWith('.ts')) parserPlugins.push('jsx')
  if (tsRE.test(filepath)) parserPlugins.push('typescript')
  const result = babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    presets: [],
    overrides: [],
    root,
    filename: id,
    sourceFileName: filepath,
    retainLines: false,
    parserOpts: {
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      plugins: parserPlugins
    },
    generatorOpts: {
      importAttributesKeyword: 'with',
      decoratorsBeforeExport: true
    },
    plugins: [compilerPlugin],
    sourceMaps: false
  })
  return result?.code ?? code
}

if (!isMainThread && workerData?.role === 'react-compiler') {
  // Load Babel eagerly so a pool started at server boot is warm by the time
  // the first module request arrives.
  load()
  parentPort.on('message', (msg) => {
    try {
      parentPort.postMessage({ seq: msg.seq, code: compileReact(msg) })
    } catch (err) {
      const e = /** @type {any} */ (err)
      parentPort.postMessage({
        seq: msg.seq,
        error: {
          message: e?.message ?? String(err),
          name: e?.name,
          stack: e?.stack,
          code: e?.code,
          reasonCode: e?.reasonCode,
          loc: e?.loc,
          pos: e?.pos
        }
      })
    }
  })
}
