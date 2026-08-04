# Undo a live safe-copy run and report what the revert put back.
param(
  [Parameter(Mandatory = $true)][int]$RunId,
  [string]$BaseUrl = 'http://localhost:3001'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\smoke-common.ps1"
$session = Connect-SheetSmart -BaseUrl $BaseUrl

$queued = Invoke-RestMethod -Uri "$BaseUrl/api/runs/$RunId/revert" -Method Post -WebSession $session `
  -ContentType 'application/json' -Body (@{ confirmed = $true } | ConvertTo-Json)
Write-Host "revert run #$($queued.runId) queued for run #$RunId"

Start-Sleep -Seconds 8
$run = Invoke-RestMethod -Uri "$BaseUrl/api/runs/$($queued.runId)" -WebSession $session
Write-Host "status=$($run.run.status)"
Write-Host ($run.run.summary_json)
