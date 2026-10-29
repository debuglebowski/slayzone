# @slayzone/ui

Radix UI / shadcn-style components with TailwindCSS 4.

## Exports

**Utilities:**
- `cn` - Class name merge utility
- `getTerminalStateStyle` - Terminal state styling

**Components:**
AlertDialog, Button, Calendar, Card, Checkbox, Collapsible, ColorPicker, Command, ContextMenu, Dialog, DropdownMenu, Form, Input, Label, Popover, Select, Separator, Sheet, Sidebar, Skeleton, Switch, Tabs, PanelToggle, Textarea, Tooltip

**Themes:**
- Re-exported from `@slayzone/theme-tokens` (the presets as DOM-free data, shared with the mobile app): `unifiedThemes`, `getUnifiedTheme`, `getThemeVariant`, `getThemeChrome`, `getThemeTerminalColors`, `getThemeEditorColors` and the theme types (also at `@slayzone/ui/theme-types`)
- `applyChromeColors` / `clearChromeColors` / `getChromeStyleOverrides` (`chrome-css-vars.ts`) — a preset's chrome as CSS variables, original colour strings

**Animations:**
- `AnimatedPage` - Page transition wrapper
- `SuccessToast` - Success feedback animation
