param(
  [Parameter(Mandatory = $true)]
  [string]$ExtensionId
)

$ErrorActionPreference = "Stop"

$HostName = "com.browser_companion.codex_bridge"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$BridgePath = Join-Path $ScriptDir "bridge.js"
$ManifestPath = Join-Path $ScriptDir "host-manifest.generated.json"
$NodePath = (Get-Command node).Source

$LauncherPath = Join-Path $ScriptDir "bridge-launcher.cmd"
@"
@echo off
"$NodePath" "$BridgePath"
"@ | Set-Content -Encoding ASCII $LauncherPath

$Manifest = @{
  name = $HostName
  description = "Browser Companion local Codex bridge"
  path = $LauncherPath
  type = "stdio"
  allowed_origins = @("chrome-extension://$ExtensionId/")
}

$Manifest | ConvertTo-Json -Depth 10 | Set-Content -Encoding ASCII $ManifestPath

$RegistryPath = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"
New-Item -Path $RegistryPath -Force | Out-Null
Set-ItemProperty -Path $RegistryPath -Name "(default)" -Value $ManifestPath

Write-Host "Browser Companion native host registered for Chrome extension $ExtensionId"
Write-Host "Manifest: $ManifestPath"
