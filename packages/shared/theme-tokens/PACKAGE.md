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

## Consumers

- `@slayzone/ui` re-exports the data names (existing `@slayzone/ui` and `@slayzone/ui/theme-types` imports keep working) and owns the DOM side: `applyChromeColors` / `clearChromeColors` / `getChromeStyleOverrides` paint the ORIGINAL strings as CSS variables.
- `@slayzone/settings` (desktop `ThemeProvider`, first-paint cache) resolves the choice with the selection functions.
- `@slayzone/mobile` paints `resolveNativeTheme(...).colors`, from the signed-in user's hub settings (`src/theme.ts`).

## Rules

- A preset colour must be in a syntax `parseColor` reads: `src/themes.test.ts` converts every theme × variant × chrome/terminal/editor key and fails on anything else. Add the syntax to the converter (with tests) rather than working around it.

## Decision Log

**2026-10-29: Extracted from `@slayzone/ui`**
The presets were TypeScript objects inside the DOM/React UI package, so the mobile app hand-copied the CSS fallback instead (wrong layer: its dark background was not desktop's). Moving the data here gives both clients one source; ui keeps re-exporting so no desktop import changed.

**2026-10-29: Hand-written converter, clamped**
No colour-library dependency for the three syntaxes the presets use (hex, `rgb[a]()`, `oklch()`). An `oklch()` colour outside sRGB is clamped per channel, not CSS Color 4 gamut-mapped (chroma reduction, e.g. lightningcss): the two differ by a few units per channel, only for the saturated `slay` / `slay-special` light colours (destructive, charts).
