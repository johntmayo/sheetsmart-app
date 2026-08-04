# Manual smoke test for the Conflict Inbox apply flow: take one open conflict,
# write the captain value to the master copy, then confirm it resolved.
param(
  [string]$BaseUrl = 'http://localhost:3001'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\smoke-common.ps1"
$session = Connect-SheetSmart -BaseUrl $BaseUrl

$open = Invoke-RestMethod -Uri "$BaseUrl/api/conflicts?status=open" -WebSession $session
Write-Host "open conflicts: $($open.Count)"
$target = $open | Select-Object -First 1
Write-Host ("applying #{0}: {1} / {2}  master='{3}'  captain='{4}'" -f `
  $target.id, $target.resident_id, $target.column, $target.existing_value, $target.incoming_value)

$body = @{ confirmed = $true; conflictIds = @($target.id) } | ConvertTo-Json
$queued = Invoke-RestMethod -Uri "$BaseUrl/api/conflicts/apply" -Method Post -WebSession $session `
  -ContentType 'application/json' -Body $body
Write-Host "live run #$($queued.runId) queued"

Start-Sleep -Seconds 8
$run = Invoke-RestMethod -Uri "$BaseUrl/api/runs/$($queued.runId)" -WebSession $session
Write-Host "status=$($run.run.status)"
Write-Host ($run.run.summary_json)
$after = Invoke-RestMethod -Uri "$BaseUrl/api/conflicts?status=open" -WebSession $session
Write-Host "open conflicts after: $($after.Count)"
