// Metro for an Expo app inside the pnpm workspace. `getDefaultConfig` already handles the
// monorepo (watches the workspace root, looks in both node_modules). What it cannot know:
// the bundle must hold ONE React instance, and it must be of the React minor that React
// Native's renderer was built for (the renderer embeds its own reconciler; it checks no
// version, but another minor is unsupported). Today the app and the rest of the workspace
// (desktop, web) resolve the same `react`, so this is a safety net: once the workspace's
// `react` moves to a minor this React Native was not built for, pnpm keeps the app's own
// copy beside it, and a shared package (`@slayzone/transport`) importing `react` from its
// own folder would get the workspace copy — a second React, and every hook throws. So
// every `react` / `react-native` request is resolved as if it came from this app, whoever
// asked.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const config = getDefaultConfig(projectRoot)

const SINGLETONS = ['react', 'react-native']
// Resolve as if requested by a file of this app (any one: only its directory counts).
const fromApp = path.join(projectRoot, 'package.json')
const isSingleton = (name) => SINGLETONS.some((s) => name === s || name.startsWith(`${s}/`))
const baseResolve = config.resolver.resolveRequest

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const ctx = isSingleton(moduleName) ? { ...context, originModulePath: fromApp } : context
  return (baseResolve ?? context.resolveRequest)(ctx, moduleName, platform)
}

module.exports = config
