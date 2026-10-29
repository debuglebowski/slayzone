# @slayzone/theme-tokens

The app's theme presets as plain data, plus the pure logic around them. No DOM, no React, no Node (its `tsconfig.json` has no DOM lib and no ambient types), so the React Native app imports it as-is.

## Exports

**Data** (`src/themes/*.ts`, one file per preset; types in `src/types.ts`):
- `unifiedThemes` — the 14 presets; each has a `dark` and/or `light` variant of `chrome` (37 `ChromeColors`), `terminal` and `editor` colours, as CSS colour strings.
- `getUnifiedTheme`, `getThemeVariant` (missing light → dark, unknown id → `slay`), `getThemeChrome`, `getThemeTerminalColors`, `getThemeEditorColors`.

**Choice** (`src/selection.ts`) — how a client turns the user's hub settings into a preset + variant:
- `DEFAULT_THEME_ID`, `LEGACY_ID_MAP` / `migrateThemeId`, `APP_THEME_SETTING_KEYS`, `LEGACY_THEME_SETTING_KEYS`
- `resolveAppThemeSelection(stored)` → `{ singleThemeId, split, themeIdDark, themeIdLight }`
- `selectChromeThemeId(selection, variant)`, `resolveThemeVariant(preference, system, fallback)`

**Colour conversion** (`src/color.ts`, hand-written) — for clients that cannot read CSS colours:
- `parseColor` (`#rrggbb[aa]`, `rgb[a]()`, `oklch()`; anything else throws), `formatHex`, `toHex`, `withAlpha` (Tailwind `/NN`), `toHexColors`
- `getThemeChromeHex(id, variant)` — a variant's chrome as `#rrggbb[aa]` (converted once per palette)
- `resolveNativeTheme(hubSettings | null, deviceScheme)` → `{ themeId, variant, colors }` — the whole decision for a client without CSS: hub settings + light/dark preference + device scheme → preset, variant, hex chrome (`null` = signed out / not loaded → `slay` in the device scheme)

**First-paint cache** (`src/hub-theme-cache.ts`) — the hub settings a client last read, kept between launches so it paints the user's theme before the hub answers (desktop's counterpart: `@slayzone/settings` `theme-cache.ts`):
- `createHubThemeCache(storage)` → `{ load(hubId), loadLast(), save(hubId, settings), forget(hubId) }` over the platform's `HubThemeCacheStorage` (one text value: `read()`, `write(text)`); format `{ v: 1, last?: hubId, hubs: { [hubId]: HubThemeSettings } }` (`last` = the hub saved most recently, so `loadLast()` paints before the client knows its session; `forget` clears it for that hub); anything unreadable (corrupt, other version, wrong shape, storage that throws) = nothing kept, never thrown
- `pickHubThemeSettings(live, cached)` — live once loaded, else cached

## Consumers

- `@slayzone/ui` re-exports the data names (existing `@slayzone/ui` and `@slayzone/ui/theme-types` imports keep working) and owns the DOM side: `applyChromeColors` / `clearChromeColors` / `getChromeStyleOverrides` paint the ORIGINAL strings as CSS variables.
- `@slayzone/settings` (desktop `ThemeProvider`, first-paint cache) resolves the choice with the selection functions.
- `@slayzone/mobile` paints `resolveNativeTheme(...).colors`, from the signed-in user's hub settings (`src/theme.ts`), and keeps them per hub with `createHubThemeCache` over a file (`src/theme-cache.ts`).

## Rules

- A preset colour must be in a syntax `parseColor` reads: `src/themes.test.ts` converts every theme × variant × chrome/terminal/editor key and fails on anything else. Add the syntax to the converter (with tests) rather than working around it.

## Decision Log

**2026-10-29: Extracted from `@slayzone/ui`**
The presets were TypeScript objects inside the DOM/React UI package, so the mobile app hand-copied the CSS fallback instead (wrong layer: its dark background was not desktop's). Moving the data here gives both clients one source; ui keeps re-exporting so no desktop import changed.

**2026-10-29: Hand-written converter, clamped**
No colour-library dependency for the three syntaxes the presets use (hex, `rgb[a]()`, `oklch()`). An `oklch()` colour outside sRGB is clamped per channel, not CSS Color 4 gamut-mapped (chroma reduction, e.g. lightningcss): the two differ by a few units per channel, only for the saturated `slay` / `slay-special` light colours (destructive, charts).

**2026-10-29: Mobile first-paint cache keeps the inputs, not the colours**
A launch painted `slay` until the hub answered. The cache keeps the hub settings (`HubThemeSettings`) per hub and resolves them again at each launch, so `system` follows the device's light/dark of that launch and the colours are always the current build's presets. Format and validation live here (platform-free, unit-tested); the app only supplies the storage.
