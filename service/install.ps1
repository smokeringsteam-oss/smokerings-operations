# Registers the scheduled tasks that keep the app running across crashes and
# reboots. Run from an elevated PowerShell; safe to re-run (it replaces the
# existing tasks). To remove: uninstall.ps1.

$user = "$env:USERDOMAIN\$env:USERNAME"
$powershell = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$run = Join-Path $PSScriptRoot 'run.ps1'
$healthcheck = Join-Path $PSScriptRoot 'healthcheck.ps1'

# S4U: runs whether or not anyone is logged in, without storing a password.
$appPrincipal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited
# The health check stops and starts the other tasks, which needs elevation.
$checkPrincipal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Highest

$appSettings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

foreach ($name in 'backend', 'frontend') {
  $taskName = 'SmokeRings ' + (Get-Culture).TextInfo.ToTitleCase($name)
  $action = New-ScheduledTaskAction -Execute $powershell `
    -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$run`" -Name $name"
  Register-ScheduledTask -TaskName $taskName -Force `
    -Action $action -Trigger (New-ScheduledTaskTrigger -AtStartup) `
    -Principal $appPrincipal -Settings $appSettings `
    -Description "Keeps the Smoke Rings $name running (service/run.ps1)." | Out-Null
  "registered: $taskName"
}

$checkAction = New-ScheduledTaskAction -Execute $powershell `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$healthcheck`""
$checkTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(5) `
  -RepetitionInterval (New-TimeSpan -Minutes 5)
$checkSettings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 4) `
  -MultipleInstances IgnoreNew -StartWhenAvailable `
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName 'SmokeRings Healthcheck' -Force `
  -Action $checkAction -Trigger $checkTrigger `
  -Principal $checkPrincipal -Settings $checkSettings `
  -Description 'Restarts the Smoke Rings tasks if they stop answering (service/healthcheck.ps1).' | Out-Null
'registered: SmokeRings Healthcheck'

Start-ScheduledTask -TaskName 'SmokeRings Backend'
Start-ScheduledTask -TaskName 'SmokeRings Frontend'
'started backend and frontend'
