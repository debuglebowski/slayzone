// Metro for an Expo app inside the pnpm workspace. `getDefaultConfig` already handles the
// monorepo (watches the workspace root, looks in both node_modules). What it cannot know:
// React Native's renderer only runs against the EXACT `react` version it was built for,
// while the rest of the workspace (desktop, web) uses a newer `react` that pnpm hoists to
// the root. A shared package (`@slayzone/transport`) importing `react` from its own folder
// would get that root copy — a second React, and every hook throws. So every `react` /
// `react-native` request is resolved as if it came from this app, whoever asked.
const path = require('node:path')
const { getDefaultConfig } = require('expo/metro-config')

const projectRoot = __dirname
const config = getDefaultConfig(projectRoot)

const SINGLETONS = ['react', 'react-native']
const fromApp = path.join(projectRoot, 'index.ts')
const isSingleton = (name) => SINGLETONS.some((s) => name === s || name.startsWith(`${s}/`))
const baseResolve = config.resolver.resolveRequest

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const ctx = isSingleton(moduleName) ? { ...context, originModulePath: fromApp } : context
  return (baseResolve ?? context.resolveRequest)(ctx, moduleName, platform)
}

module.exports = config
