// @ts-check
/**
 * Expo config plugin: puts the scripts the artifact pages run into the iOS app bundle, so
 * they load inside the artifact web view only and never enter the app's JS bundle:
 *
 * - mermaid's browser build: a markdown artifact's ```mermaid fences and a `.mmd`
 *   artifact draw their diagrams on the phone the way desktop draws them. The version is
 *   desktop's — this package declares the same `mermaid` range desktop's packages do, so
 *   the workspace resolves one copy for all of them.
 * - html2canvas's browser build (`html2canvas-pro`, pinned): the export draws an html
 *   artifact's pages with it, to print them as pictures.
 *
 * At prebuild it copies each (one self-contained file that sets a global) into the
 * native project and lists it as a resource of the app target; the app reads it at
 * runtime from `Paths.bundle` (src/artifacts/page-assets.ts). The stock `expo-asset`
 * plugin can't do this: it refuses `.js` files.
 */
const fs = require('node:fs')
const path = require('node:path')
const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins')

/** The scripts' file names in the app bundle (the same names in page-assets.ts). */
const MERMAID_BUNDLE_FILE = 'mermaid.min.js'
const HTML2CANVAS_BUNDLE_FILE = 'html2canvas-pro.min.js'

/**
 * Each bundled script: its file name in the app bundle, and where its build is.
 * `html2canvas-pro` exports only its module entry points: its browser build is the
 * file beside its CommonJS entry (`dist/`).
 * @type {{ file: string, build: (projectRoot: string) => string }[]}
 */
const PAGE_ASSETS = [
  {
    file: MERMAID_BUNDLE_FILE,
    build: (projectRoot) => require.resolve('mermaid/dist/mermaid.min.js', { paths: [projectRoot] })
  },
  {
    file: HTML2CANVAS_BUNDLE_FILE,
    build: (projectRoot) =>
      path.join(
        path.dirname(require.resolve('html2canvas-pro', { paths: [projectRoot] })),
        'html2canvas-pro.min.js'
      )
  }
]

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withArtifactPageAssets = (config) => {
  const copied = withDangerousMod(config, [
    'ios',
    async (c) => {
      const { projectRoot, platformProjectRoot, projectName } = c.modRequest
      if (!projectName) throw new Error('with-artifact-page-assets: no iOS project name')
      for (const asset of PAGE_ASSETS) {
        fs.copyFileSync(
          asset.build(projectRoot),
          path.join(platformProjectRoot, projectName, asset.file)
        )
      }
      return c
    }
  ])
  return withXcodeProject(copied, (c) => {
    const { projectName } = c.modRequest
    if (!projectName) throw new Error('with-artifact-page-assets: no iOS project name')
    for (const asset of PAGE_ASSETS) {
      const filepath = path.join(projectName, asset.file)
      if (!c.modResults.hasFile(filepath)) {
        IOSConfig.XcodeUtils.addResourceFileToGroup({
          filepath,
          groupName: projectName,
          project: c.modResults,
          isBuildFile: true
        })
      }
    }
    return c
  })
}

module.exports = withArtifactPageAssets
module.exports.MERMAID_BUNDLE_FILE = MERMAID_BUNDLE_FILE
module.exports.HTML2CANVAS_BUNDLE_FILE = HTML2CANVAS_BUNDLE_FILE
module.exports.PAGE_ASSETS = PAGE_ASSETS
