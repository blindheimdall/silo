<#
Installs SILO for the current Windows user. No administrator rights are needed.

  -InstallDir      where the app goes (default: %LOCALAPPDATA%\Programs\SILO)
  -DataDir         residents, workflows, keys and logs (default: %LOCALAPPDATA%\SILO\data)
  -WorkDir         the shared workspace (default: Documents\SILO workspace)
  -Port            the local port (default: 3000)
  -FromData        copy an existing SILO data folder into the new, empty data folder
  -StartAtSignIn   start SILO when you sign in to Windows (asked when not given)
  -NoStartAtSignIn do not ask, and do not start at sign-in
  -NoShortcuts     no Start menu shortcut
  -NoRegistry      not listed in Settings, Apps
  -NoLaunch        do not start SILO at the end
  -Quiet           ask nothing; anything not given is left out
Run it again to update an installed SILO: your data stays where it is.
#>
param(
  [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\SILO'),
  [string]$DataDir = (Join-Path $env:LOCALAPPDATA 'SILO\data'),
  [string]$WorkDir = (Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'SILO workspace'),
  [int]$Port = 3000,
  [string]$FromData = '',
  [switch]$StartAtSignIn,
  [switch]$NoStartAtSignIn,
  [switch]$NoShortcuts,
  [switch]$NoRegistry,
  [switch]$NoLaunch,
  [switch]$Quiet,
  [string]$StartMenuDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
  [string]$StartupDir = (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup')
)
$ErrorActionPreference = 'Stop'
$Source = (Resolve-Path (Split-Path -Parent $PSScriptRoot)).Path
function Say([string]$t) { if (-not $Quiet) { Write-Host $t } }
function Ask([string]$q) { if ($Quiet) { return $false }; $a = Read-Host "$q (y/n)"; return ($a -match '^(y|yes|d|da)$') }
function Full([string]$p) { return [IO.Path]::GetFullPath($p).TrimEnd('\') }
function Inside([string]$child, [string]$parent) { $c = (Full $child) + '\'; $p = (Full $parent) + '\'; return $c.StartsWith($p, [StringComparison]::OrdinalIgnoreCase) }
function WriteText([string]$file, [string]$text) { [IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding $false)) }
function Shortcut([string]$file, [string]$target, [string]$arguments, [string]$dir, [string]$icon) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $file) | Out-Null
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($file)
  $s.TargetPath = $target; $s.Arguments = $arguments; $s.WorkingDirectory = $dir; $s.WindowStyle = 7; $s.Description = 'SILO'
  if (Test-Path $icon) { $s.IconLocation = $icon }
  $s.Save()
}

Say 'SILO installer'
if (-not (Test-Path (Join-Path $Source 'server.mjs')) -or -not (Test-Path (Join-Path $Source 'supervisor.mjs'))) { throw "Run this installer from the SILO folder. $Source has no server.mjs." }
$InstallDir = Full $InstallDir
# Installing again over a SILO keeps its folders and port, unless new ones are given.
$oldLaunch = Join-Path $InstallDir 'launch.json'
if (Test-Path $oldLaunch) {
  try {
    $l = Get-Content $oldLaunch -Raw | ConvertFrom-Json
    if (-not $PSBoundParameters.ContainsKey('DataDir') -and $l.dataDir) { $DataDir = $l.dataDir }
    if (-not $PSBoundParameters.ContainsKey('WorkDir') -and $l.workDir) { $WorkDir = $l.workDir }
    if (-not $PSBoundParameters.ContainsKey('Port') -and $l.port) { $Port = [int]$l.port }
  } catch {}
}
$DataDir = Full $DataDir; $WorkDir = Full $WorkDir
if ((Full $Source) -eq $InstallDir -or (Inside $InstallDir $Source) -or (Inside $Source $InstallDir)) { throw 'Pick an install folder outside the SILO folder you install from.' }
if ((Inside $DataDir $InstallDir) -or (Inside $WorkDir $InstallDir)) { throw 'Keep the data and workspace folders outside the install folder, so updates never touch them.' }
# A folder with other things in it is never used: updating mirrors the app into it.
if ((Test-Path $InstallDir) -and (Get-ChildItem -Force $InstallDir | Select-Object -First 1) -and -not (Test-Path (Join-Path $InstallDir 'supervisor.mjs'))) { throw "$InstallDir already holds other files. Pick an empty folder." }

# Node.js 22 or newer.
$node = Get-Command node -ErrorAction SilentlyContinue
$ok = $false
if ($node) { $v = ((& $node.Source --version) -replace '^v', '') -replace '[^\d.].*$', ''; $ok = ([version]$v -ge [version]'22.0') }
if (-not $ok) {
  Say 'SILO needs Node.js 22 or newer.'
  if ((Get-Command winget -ErrorAction SilentlyContinue) -and (Ask 'Install Node.js LTS now with winget? winget shows its own terms first.')) {
    winget install --id OpenJS.NodeJS.LTS -e
    $env:Path = [Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [Environment]::GetEnvironmentVariable('Path', 'User')
    $node = Get-Command node -ErrorAction SilentlyContinue
  }
  if (-not $node) { throw 'Install Node.js 22 or newer from https://nodejs.org, or with: winget install OpenJS.NodeJS.LTS. Then run this installer again.' }
}
$nodeExe = $node.Source

# An installed SILO that runs is stopped first, so its files can be replaced.
$pidFile = Join-Path $DataDir 'silo.pid.json'
if (Test-Path $pidFile) {
  try {
    $p = Get-Content $pidFile -Raw | ConvertFrom-Json
    if ($p.root -and ((Full $p.root) -eq $InstallDir)) {
      Say 'Stopping the SILO that runs from this folder...'
      if ($p.supervisor) { Stop-Process -Id $p.supervisor -ErrorAction SilentlyContinue }
      Start-Sleep -Seconds 3
      if ($p.server) { Stop-Process -Id $p.server -Force -ErrorAction SilentlyContinue }
    }
  } catch {}
}

# The app. Data, workspace, tests and build output are never copied.
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
$skipDirs = 'data', 'workspace', 'node_modules', 'tests', 'dist', '.git', '.claude', '.vscode' | ForEach-Object { Join-Path $Source $_ }
& robocopy $Source $InstallDir /MIR /XD @skipDirs /XF (Join-Path $Source 'launch.json') *.log /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the app failed (robocopy $LASTEXITCODE)." }
New-Item -ItemType Directory -Force -Path $DataDir, $WorkDir | Out-Null
# The updater's list of installed files is from before this copy, so it starts over.
Remove-Item (Join-Path $DataDir 'update\installed.json') -Force -ErrorAction SilentlyContinue
$version = (Get-Content (Join-Path $InstallDir 'package.json') -Raw | ConvertFrom-Json).version
WriteText (Join-Path $InstallDir 'launch.json') ((@{ dataDir = $DataDir; workDir = $WorkDir; port = $Port; installed = (Get-Date -Format 'yyyy-MM-dd'); version = $version } | ConvertTo-Json))

# Data from an earlier SILO, only into an empty data folder. The old folder stays as it is.
$hasData = (Test-Path (Join-Path $DataDir 'state.json')) -or (Test-Path (Join-Path $DataDir 'state.db'))
$oldData = Join-Path $Source 'data'
if (-not $FromData -and -not $hasData -and (Test-Path (Join-Path $oldData 'state.json')) -and (Ask "Copy your residents, workflows and keys from $oldData? That folder stays as it is.")) { $FromData = $oldData }
if ($FromData) {
  if ($hasData) { Say "The data folder $DataDir already has a SILO in it, so nothing was copied into it." }
  else {
    & robocopy (Full $FromData) $DataDir /E /XD logs update /XF silo.pid.json /NFL /NDL /NJH /NJS /NP /R:1 /W:1 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "Copying the data failed (robocopy $LASTEXITCODE)." }
    Say "Copied your data into $DataDir."
  }
}

$icon = Join-Path $InstallDir 'public\silo.ico'
$supervisor = '"' + (Join-Path $InstallDir 'supervisor.mjs') + '"'
if (-not $NoShortcuts) { Shortcut (Join-Path $StartMenuDir 'SILO.lnk') $nodeExe ($supervisor + ' --open') $InstallDir $icon; Say 'Added SILO to the Start menu.' }
$atSignIn = $StartAtSignIn -or (-not $NoStartAtSignIn -and (Ask 'Start SILO when you sign in to Windows? You can change it later in System.'))
if ($atSignIn) { Shortcut (Join-Path $StartupDir 'SILO.lnk') $nodeExe $supervisor $InstallDir $icon; Say 'SILO starts when you sign in.' }

if (-not $NoRegistry) {
  $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\SILO'
  New-Item -Path $key -Force | Out-Null
  $size = [int]((Get-ChildItem $InstallDir -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
  $values = @{ DisplayName = 'SILO'; DisplayVersion = $version; Publisher = 'SILO'; InstallLocation = $InstallDir; DisplayIcon = $icon; UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\installer\uninstall.ps1`""; QuietUninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\installer\uninstall.ps1`" -Quiet" }
  foreach ($k in $values.Keys) { Set-ItemProperty -Path $key -Name $k -Value $values[$k] }
  foreach ($k in 'NoModify', 'NoRepair') { Set-ItemProperty -Path $key -Name $k -Value 1 -Type DWord }
  Set-ItemProperty -Path $key -Name EstimatedSize -Value $size -Type DWord
}

Say ''
Say "SILO $version is installed in $InstallDir"
Say "Data: $DataDir"
Say "Workspace: $WorkDir"
Say "Open it at http://127.0.0.1:$Port"
if (-not $NoLaunch) { Start-Process -FilePath $nodeExe -ArgumentList ($supervisor + ' --open') -WorkingDirectory $InstallDir -WindowStyle Minimized }
