export const DOWNLOAD_BASE = 'https://github.com/debuglebowski/SlayZone/releases/latest/download/'

export const MAC_ARM64_URL = DOWNLOAD_BASE + 'SlayZone-arm64.dmg'
export const MAC_X64_URL = DOWNLOAD_BASE + 'SlayZone-x64.dmg'
// Per-arch installers. The release no longer ships the combined x64+arm64 SlayZone-setup.exe.
export const WIN_X64_URL = DOWNLOAD_BASE + 'SlayZone-setup-x64.exe'
export const WIN_ARM64_URL = DOWNLOAD_BASE + 'SlayZone-setup-arm64.exe'
export const LINUX_URL = DOWNLOAD_BASE + 'SlayZone-x86_64.AppImage'

export const DEFAULT_DOWNLOAD_URL = MAC_ARM64_URL
