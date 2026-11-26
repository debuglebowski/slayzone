# Settings Domain

User preferences and theme management.

## Contracts (shared/)

```typescript
type Theme = 'light' | 'dark'
type ThemePreference = 'light' | 'dark' | 'system'
```

## Electron (electron/)

- `getEffectiveTheme` / `getThemeSource` / `setTheme` - the theme MODE on Electron's `nativeTheme`, persisted in `client.config.json`. Called by main's client host (`app/src/main/client-host-ipc.ts`), never by a hub

## Client (client/)

- `ThemeProvider` / `useTheme()` - Theme context. Turns the stored choice (`app_theme_*` hub settings + this device's light/dark/system mode from its client host) into a preset + variant with `@slayzone/theme-tokens` selection functions, the same ones the mobile app uses. The mode is client-local (ARCHITECTURE.md, "Client-local settings and native events"); the hub's `settings.*Theme` paths only answer constants for older clients
- `LabsSettingsTab` - the labs flags, this device's own (client host `labs.set`)
- `UserSettingsDialog` - Settings panel
- `useViewState` - View preferences (sidebar collapsed, etc.)

## Dependencies

None.
