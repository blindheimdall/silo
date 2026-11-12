<#
Removes an installed SILO: stops it, removes its shortcuts, its entry in Settings, Apps, and the app folder.
Your data and workspace stay, unless you ask for the data to go with -RemoveData (or type DELETE when asked).
The workspace is never removed here.
#>
param(
  [switch]$RemoveData,
  [switch]$Quiet,
  [switch]$NoRegistry,
  [string]$StartMenuDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  [string]$StartupDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup')
)
$ErrorActionPreference = 'Stop'
function Say([string]$t) { if (-not $Quiet) { Write-Host $t } }
function Full([string]$p) { return [IO.Path]::GetFullPath($p).TrimEnd('\') }
$App = Full (Split-Path -Parent $PSScriptRoot)
# Only a folder the installer made: it has the app and its launch.json.
if (-not (Test-Path (Join-Path $App 'supervisor.mjs')) -or -not (Test-Path (Join-Path $App 'launch.json'))) { throw "This does not look like an installed SILO: $App" }
$launch = Get-Content (Join-Path $App 'launch.json') -Raw | ConvertFrom-Json
$DataDir = Full $launch.dataDir

# Stop it. The supervisor goes first, so the server saves and closes on its own.
$pidFile = Join-Path $DataDir 'silo.pid.json'
if (Test-Path $pidFile) {
  try {
    $p = Get-Content $pidFile -Raw | ConvertFrom-Json
    if ($p.root -and ((Full $p.root) -eq $App)) {
      if ($p.supervisor) { Stop-Process -Id $p.supervisor -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 3
      if ($p.server) { Stop-Process -Id $p.server -Force -ErrorAction SilentlyContinue }
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
  } catch {}
}
# Shortcuts, only the ones that start this SILO.
foreach ($lnk in @((Join-Path $StartMenuDir 'SILO.lnk'), (Join-Path $StartupDir 'SILO.lnk'))) {
  if (Test-Path $lnk) {
    $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
    if ($s.WorkingDirectory -and ((Full $s.WorkingDirectory) -eq $App)) { Remove-Item $lnk -Force; Say "Removed $lnk" }
  }
}
if (-not $NoRegistry) {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SILO'
  if ((Test-Path $key) -and ((Full (Get-ItemProperty $key).InstallLocation) -eq $App)) { Remove-Item $key -Force }
}
$dropData = $RemoveData
if (-not $dropData -and -not $Quiet) { $a = Read-Host "Also delete your data in $DataDir (residents, workflows, keys)? Type DELETE to delete it, or press Enter to keep it"; $dropData = ($a -ceq 'DELETE') }
if ($dropData -and (Test-Path $DataDir)) { Remove-Item $DataDir -Recurse -Force; Say "Deleted $DataDir" } else { Say "Your data stays in $DataDir" }
Say "Your workspace stays in $($launch.workDir)"
Set-Location $env:TEMP
Remove-Item $App -Recurse -Force
Say 'SILO is removed.'
