# Stops and removes the scheduled tasks registered by install.ps1.
foreach ($taskName in 'SmokeRings Healthcheck', 'SmokeRings Backend', 'SmokeRings Frontend') {
  Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  "removed: $taskName"
}
