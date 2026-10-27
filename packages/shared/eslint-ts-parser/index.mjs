// ESLint's TS/TSX parsing, as flat-config blocks. With babelrc and configFile both
// off, @babel/eslint-parser 8 calls @babel/parser directly and ignores `presets`:
// only `parserOpts.plugins` picks the syntax, so TS vs TSX is chosen here by file
// extension (what @babel/preset-typescript did from the filename under Babel 7).
import parser from '@babel/eslint-parser'

/** @param {string[]} files @param {string[]} plugins */
const block = (files, plugins) => ({
  files,
  languageOptions: {
    parser,
    parserOptions: {
      requireConfigFile: false,
      babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins } }
    }
  }
})

export const tsParserConfigs = [
  block(['**/*.ts'], ['typescript']),
  block(['**/*.tsx'], ['typescript', 'jsx'])
]
