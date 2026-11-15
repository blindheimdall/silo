<#
Runs SILO when the computer starts, before anyone signs in, as a scheduled task of your own account. The supervisor
keeps it running and starts it again after a crash. Schedules, webhooks, forms and talk channels then work on a
computer nobody is signed in to.

  -Install    register the task (needs a PowerShell window opened as administrator)
  -Uninstall  remove it (administrator too)
  -Status     say whether it is there and running (no rights needed)
  -DryRun     with -Install: show what would be registered and change nothing
  -Start      with -Install: start it now, not only at the next start of the computer
  -Dir        the SILO folder (default: the folder above this script)
  -Node       node.exe to run (default: the one on PATH)
  -TaskName   the name of the task (default: SILO)

The task runs as you, without your password being stored (Windows calls this S4U): it reaches the internet and your
own files, but not network shares, and it shows no windows, so desktop and browser residents need you signed in.
One SILO runs per data folder: when you sign in and SILO starts there too, the second one sees the first and stops.
#>
param(
  [switch]$Install,
  [switch]$Uninstall,
  [switch]$Status,
  [switch]$DryRun,
  [switch]$Start,
  [string]$Dir = (Split-Path -Parent $PSScriptRoot),
  [string]$Node = '',
  [string]$TaskName = 'SILO'
)
$ErrorActionPreference = 'Stop'
if ($TaskName -notmatch '^[\w .-]{1,60}$') { throw 'Give a task name of letters, digits, spaces, dots and dashes.' }
function Admin { return ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }
function Find-Task { return Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue | Select-Object -First 1 }

if (-not ($Install -or $Uninstall -or $Status)) { $Status = $true }

if ($Status) {
  $t = Find-Task
  if (-not $t) { [pscustomobject]@{ installed = $false; task = $TaskName } | ConvertTo-Json -Compress; exit 0 }
  $a = $t.Actions | Select-Object -First 1
  [pscustomobject]@{ installed = $true; task = $TaskName; state = [string]$t.State; user = [string]$t.Principal.UserId; logon = [string]$t.Principal.LogonType; execute = [string]$a.Execute; arguments = [string]$a.Arguments; dir = [string]$a.WorkingDirectory } | ConvertTo-Json -Compress
  exit 0
}

if ($Uninstall) {
  $t = Find-Task
  if (-not $t) { Write-Host "There is no task called $TaskName."; exit 0 }
  if (-not (Admin)) { throw 'Open PowerShell as administrator to remove the task.' }
  # Stopping the task ends the supervisor; it closes SILO, which saves first.
  if ([string]$t.State -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Write-Host "SILO no longer starts with the computer. It still starts when you sign in, if that is on."
  exit 0
}

$Dir = [IO.Path]::GetFullPath($Dir).TrimEnd('\')
if (-not (Test-Path (Join-Path $Dir 'supervisor.mjs'))) { throw "$Dir is not a SILO folder: it has no supervisor.mjs." }
if (-not $Node) { $cmd = Get-Command node.exe -ErrorAction SilentlyContinue; if ($cmd) { $Node = $cmd.Source } }
if (-not $Node -or -not (Test-Path $Node)) { throw 'Node.js was not found. Install Node.js 22 or newer, or give its path with -Node.' }
$version = (& $Node --version) -replace '^v', ''
if ([int]($version.Split('.')[0]) -lt 22) { throw "SILO needs Node.js 22 or newer; $Node is $version." }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute $Node -Argument '"supervisor.mjs" --service' -WorkingDirectory $Dir
$trigger = New-ScheduledTaskTrigger -AtStartup
$trigger.Delay = 'PT30S'
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew

if ($DryRun) {
  [pscustomobject]@{ task = $TaskName; user = $user; logon = 'S4U'; runLevel = 'Limited'; trigger = 'at startup, 30 seconds later'; execute = $Node; arguments = '"supervisor.mjs" --service'; dir = $Dir; restart = '3 times, 1 minute apart'; timeLimit = 'none' } | ConvertTo-Json
  exit 0
}
if (-not (Admin)) { throw 'Open PowerShell as administrator to register the task: Windows asks for that to run a task while nobody is signed in.' }
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Starts SILO with the computer, before anyone signs in.' -Force | Out-Null
Write-Host "SILO starts with the computer from now on, as $user, from $Dir."
if ($Start) { Start-ScheduledTask -TaskName $TaskName; Write-Host 'Started. Open http://127.0.0.1:3000 in a minute, or the port SILO uses.' }
else { Write-Host 'It starts at the next start of the computer. Add -Start to start it now.' }
