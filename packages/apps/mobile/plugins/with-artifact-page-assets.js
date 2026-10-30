// @ts-check
/**
 * Expo config plugin: puts the scripts the artifact pages run into the iOS app bundle, so
 * they load inside the artifact web view only and never enter the app's JS bundle. Today
 * one script, mermaid's browser build: a markdown artifact's ```mermaid fences and a
 * `.mmd` artifact draw their diagrams on the phone the way desktop draws them. The
 * version is desktop's — this package declares the same `mermaid` range desktop's
 * packages do, so the workspace resolves one copy for all of them.
 *
 * At prebuild it copies `mermaid/dist/mermaid.min.js` (one self-contained file that sets
 * `globalThis.mermaid`) into the native project and lists it as a resource of the app
 * target; the app reads it at runtime from `Paths.bundle` (src/artifacts/page-assets.ts).
 * The stock `expo-asset` plugin can't do this: it refuses `.js` files.
 */
const fs = require('node:fs')
const path = require('node:path')
const { IOSConfig, withDangerousMod, withXcodeProject } = require('expo/config-plugins')

/** The script's file name in the app bundle (`MERMAID_BUNDLE_FILE` in page-assets.ts). */
const MERMAID_BUNDLE_FILE = 'mermaid.min.js'

/** @param {string} projectRoot */
function mermaidBuildPath(projectRoot) {
  return require.resolve('mermaid/dist/mermaid.min.js', { paths: [projectRoot] })
}

/** @type {import('expo/config-plugins').ConfigPlugin} */
const withArtifactPageAssets = (config) => {
  const copied = withDangerousMod(config, [
    'ios',
    async (c) => {
      const { projectRoot, platformProjectRoot, projectName } = c.modRequest
      if (!projectName) throw new Error('with-artifact-page-assets: no iOS project name')
      fs.copyFileSync(
        mermaidBuildPath(projectRoot),
        path.join(platformProjectRoot, projectName, MERMAID_BUNDLE_FILE)
      )
      return c
    }
  ])
  return withXcodeProject(copied, (c) => {
    const { projectName } = c.modRequest
    if (!projectName) throw new Error('with-artifact-page-assets: no iOS project name')
    const filepath = path.join(projectName, MERMAID_BUNDLE_FILE)
    if (!c.modResults.hasFile(filepath)) {
      IOSConfig.XcodeUtils.addResourceFileToGroup({
        filepath,
        groupName: projectName,
        project: c.modResults,
        isBuildFile: true
      })
    }
    return c
  })
}

module.exports = withArtifactPageAssets
module.exports.MERMAID_BUNDLE_FILE = MERMAID_BUNDLE_FILE
