# Runs every few minutes from a scheduled task. run.ps1 already restarts a
# process that exits; this catches the other failure: a process that is still
# alive but no longer answering, or a task that isn't running at all.

$targets = @(
  @{ Task = 'SmokeRings Backend';  Url = 'http://localhost:4000/' },
  @{ Task = 'SmokeRings Frontend'; Url = 'http://127.0.0.1:5173/' }
)

$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = Join-Path $logDir 'healthcheck.log'

function Write-Log([string]$message) {
  Add-Content -Path $log -Encoding utf8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $message"
}

# Any HTTP answer counts as alive, including a 404: the question is whether
# the process responds, not whether "/" is a real route.
function Test-Alive([string]$url) {
  try {
    Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10 | Out-Null
    return $true
  } catch [System.Net.WebException] {
    return $null -ne $_.Exception.Response
  } catch {
    return $false
  }
}

foreach ($target in $targets) {
  if (Test-Alive $target.Url) { continue }

  # node --watch restarts the backend on every save; don't mistake that for a hang.
  Start-Sleep -Seconds 20
  if (Test-Alive $target.Url) { continue }

  Write-Log "$($target.Task) not answering at $($target.Url); restarting task"
  Stop-ScheduledTask -TaskName $target.Task -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 3
  Start-ScheduledTask -TaskName $target.Task
}
