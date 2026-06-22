# unregister-deeplink.ps1 — remove the per-user `slayzone://` scheme handler that
# register-deeplink.ps1 installed (clean uninstall / re-test). Per-user, no admin.
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$root = 'HKCU:\Software\Classes\slayzone'
if (Test-Path -LiteralPath $root) {
  Remove-Item -LiteralPath $root -Recurse -Force
  Write-Host 'Unregistered slayzone:// (per-user).'
}
else {
  Write-Host 'slayzone:// not registered for this user; nothing to do.'
}
