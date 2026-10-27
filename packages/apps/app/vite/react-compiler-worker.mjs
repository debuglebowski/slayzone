// Worker half of the dev-only cached React Compiler transform
// (see ./react-compiler-cache.ts). Runs Babel + babel-plugin-react-compiler off
// Vite's main thread. Plain .mjs: worker_threads load it straight from disk, no
// TS transpile step.
//
// `compileReact` reproduces EXACTLY the Babel call @rolldown/plugin-babel makes
// for a client module with `presets: [reactCompilerPreset()]` (the compiler pass of
// @slayzone/react-compiler-config): same preset, same options object, same
// per-extension parser plugins — so the emitted code is byte-identical to the
// uncached path. The caller applies the preset's code filter first (a module it
// rejects is not transformed at all). Sourcemaps are not generated: the dev server
// strips them anyway (strip-dev-sourcemaps), and Babel's generated code does not
// depend on `sourceMaps`.
import { createRequire } from 'node:module'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'

const appRequire = createRequire(new URL('../package.json', import.meta.url))

let babel
let compilerPreset
async function load() {
  if (!babel) {
    babel = appRequire('@babel/core')
    const { reactCompilerPreset } = await import('@vitejs/plugin-react')
    compilerPreset = reactCompilerPreset().preset
  }
}

/** @rolldown/plugin-babel's per-extension parser overrides. */
function parserPluginsFor(filepath) {
  if (filepath.endsWith('.jsx')) return ['jsx']
  if (filepath.endsWith('.ts')) return ['typescript']
  if (filepath.endsWith('.tsx')) return ['typescript', 'jsx']
  return []
}

/**
 * @param {{ code: string, id: string }} req
 * @returns {Promise<string>}
 */
export async function compileReact({ code, id }) {
  await load()
  const [filepath] = id.split('?')
  const result = babel.transformSync(code, {
    babelrc: false,
    configFile: false,
    inputSourceMap: false,
    presets: [compilerPreset],
    parserOpts: {
      sourceType: 'module',
      allowAwaitOutsideFunction: true,
      plugins: parserPluginsFor(filepath)
    },
    filename: id,
    sourceMaps: false
  })
  return result?.code ?? code
}

if (!isMainThread && workerData?.role === 'react-compiler') {
  // Load Babel eagerly so a pool started at server boot is warm by the time
  // the first module request arrives.
  void load()
  parentPort.on('message', async (msg) => {
    try {
      parentPort.postMessage({ seq: msg.seq, code: await compileReact(msg) })
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
