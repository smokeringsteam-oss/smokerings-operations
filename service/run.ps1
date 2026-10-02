# Keeps one half of the app running forever. Launched by the scheduled tasks
# that install.ps1 registers; not meant to be run by hand while those tasks
# are active (the ports are fixed, so a second copy just fails to bind).
param(
  [Parameter(Mandatory)][ValidateSet('backend', 'frontend')][string]$Name
)

$repo = Split-Path $PSScriptRoot -Parent
Set-Location $repo

# The task runs without a login session, so don't rely on the user's PATH.
$env:Path = "C:\Program Files\nodejs;$env:Path"

$commands = @{
  backend  = 'node --watch server/index.js'
  frontend = 'node node_modules/vite/bin/vite.js'
}
$command = $commands[$Name]

$logDir = Join-Path $PSScriptRoot 'logs'
New-Item -ItemType Directory -Force $logDir | Out-Null
$log = "service\logs\$Name.log"

function Write-Log([string]$message) {
  Add-Content -Path $log -Encoding utf8 -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] [service] $message"
}

while ($true) {
  # Keep one previous log; rotate only between runs, when nothing holds the file.
  if ((Test-Path $log) -and (Get-Item $log).Length -gt 10MB) {
    Move-Item -Force $log "service\logs\$Name.previous.log"
  }

  Write-Log "starting: $command"
  # cmd does the redirection: PowerShell 5.1 would wrap every stderr line in
  # an error record.
  cmd /c "$command >> $log 2>&1"
  Write-Log "exited with code $LASTEXITCODE; restarting in 5s"
  Start-Sleep -Seconds 5
}
