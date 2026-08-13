# CI Release Notes

Electron + pnpm monorepo + electron-builder has many sharp edges. This documents what we hit.

## electron-builder version

**Use v25.x, not v26.x.** The v26 Node.js module collector OOMs on monorepos (even with 4GB heap). v25 uses a Go-based collector (`app-builder` binary) that works fine.

## pnpm layout

`.npmrc` must have `node-linker=hoisted`. Without it, domain packages can't resolve transitive deps (typecheck fails) and electron-builder chokes on the `.pnpm` virtual store.

## Workspace packages

electron-builder's module collector follows `workspace:*` deps from `package.json`, resolves symlinks to source dirs, then fails because those dirs are outside the app directory. Fix: strip `@slayzone/*` from `package.json` before running electron-builder. These are already bundled by electron-vite into `out/`.

```yaml
- name: Strip workspace deps (bundled by electron-vite)
  run: node -e "const fs=require('fs'),p='packages/apps/app/package.json',pkg=JSON.parse(fs.readFileSync(p));Object.keys(pkg.dependencies).filter(k=>k.startsWith('@slayzone/')).forEach(k=>delete pkg.dependencies[k]);fs.writeFileSync(p,JSON.stringify(pkg,null,2)+'\n')"
```

## Electron version detection

With hoisted layout, electron lives at repo root `node_modules/`, not app's. electron-builder can't find it. Extract explicitly:

```yaml
- run: echo "ELECTRON_VERSION=$(node -p "require('electron/package.json').version")" >> $GITHUB_ENV
- run: electron-builder --mac --arm64 -c.electronVersion=$ELECTRON_VERSION
```

## Scoped package name in artifacts

`${name}` in `artifactName` resolves to `@slayzone/app`, creating a subdirectory that breaks `hdiutil`. Use `${productName}` (resolves to `SlayZone`).

## Python setuptools

macOS computers have Python 3.12+ which removed `distutils`. electron-builder 25.x's bundled node-gyp needs it:

```yaml
- run: pip3 install --break-system-packages setuptools
```

## Repository field

electron-builder can't detect the GitHub repo from a monorepo subdirectory (`.git` is at root). Add `"repository": "github:owner/repo"` to the app's `package.json`.
