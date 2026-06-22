# register-deeplink.ps1 — register the `slayzone://` URL scheme for the current
# user so Windows routes OAuth callbacks to slayzone-deeplink.ps1 (which POSTs
# them to the running sidecar). Per-user (HKCU) → no admin required. Idempotent.
#
# A packaged fork build should do the system-wide equivalent under
# HKLM\Software\Classes from its installer (see README.md). This mirrors the Linux
# `.desktop` + `xdg-mime default` registration step.
[CmdletBinding()]
param(
  # Path to the handler. Defaults to slayzone-deeplink.ps1 next to this script.
  [string]$HandlerPath = (Join-Path $PSScriptRoot 'slayzone-deeplink.ps1')
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $HandlerPath)) {
  throw "handler not found: $HandlerPath"
}
$resolved = (Resolve-Path -LiteralPath $HandlerPath).Path

$root = 'HKCU:\Software\Classes\slayzone'

# Scheme root: the empty `URL Protocol` value is what marks a key as a URL-scheme
# handler for Windows (its presence, not its value, is the signal).
New-Item -Path $root -Force | Out-Null
Set-ItemProperty -Path $root -Name '(Default)' -Value 'URL:SlayZone Protocol'
Set-ItemProperty -Path $root -Name 'URL Protocol' -Value ''

# shell\open\command: launch the handler via Windows PowerShell (powershell.exe
# is present on all Win10+; pwsh may not be). "%1" is the full slayzone:// URL,
# quoted so the `&` between OAuth params stays one argv, not a command separator.
$cmdKey = "$root\shell\open\command"
New-Item -Path $cmdKey -Force | Out-Null
$command = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$resolved`" `"%1`""
Set-ItemProperty -Path $cmdKey -Name '(Default)' -Value $command

Write-Host "Registered slayzone:// -> $resolved (per-user)."
Write-Host "Verify:  Start-Process 'slayzone://auth/callback?code=TESTCODE'"
