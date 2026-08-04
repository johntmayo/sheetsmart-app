# Manual smoke test for the pull-to-master playbook against the safe copies.
# Runs a preview, applies a deliberately tiny approved subset, and prints the
# resulting run so the loop (preview -> approve -> write -> undo) can be watched.
param(
  [int]$CellCount = 2,
  [string]$BaseUrl = 'http://localhost:3001'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\smoke-common.ps1"
$session = Connect-SheetSmart -BaseUrl $BaseUrl

$preview = Invoke-RestMethod -Uri "$BaseUrl/api/execution/pull-to-master/preview" -Method Post -WebSession $session
Write-Host "preview run #$($preview.runId): $($preview.impact.headline)"
Write-Host "fills=$($preview.impact.fills) overwrites=$($preview.impact.overwrites) conflicts=$($preview.impact.conflicts) unmatched=$($preview.impact.unmatchedResidents)"

$cells = @($preview.cells | Select-Object -First $CellCount | ForEach-Object {
  Write-Host ("  approving {0} / {1} = '{2}'" -f $_.residentId, $_.column, $_.captainValue)
  @{ residentId = $_.residentId; column = $_.column }
})

$body = @{ previewRunId = $preview.runId; confirmed = $true; cells = $cells } | ConvertTo-Json -Depth 5
$queued = Invoke-RestMethod -Uri "$BaseUrl/api/execution/pull-to-master/apply" -Method Post -WebSession $session `
  -ContentType 'application/json' -Body $body
Write-Host "live run #$($queued.runId) queued"

Start-Sleep -Seconds 8
$run = Invoke-RestMethod -Uri "$BaseUrl/api/runs/$($queued.runId)" -WebSession $session
Write-Host "status=$($run.run.status)"
Write-Host ($run.run.summary_json)
