# Manual smoke test for the add-captain-created-residents playbook. Approves a
# deliberately tiny number of CLEAN (unflagged) candidates so the append ->
# snapshot -> undo loop can be watched on the safe copies.
param(
  [int]$Count = 1,
  [string]$BaseUrl = 'http://localhost:3001'
)

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\smoke-common.ps1"
$session = Connect-SheetSmart -BaseUrl $BaseUrl

$preview = Invoke-RestMethod -Uri "$BaseUrl/api/execution/new-residents/preview" -Method Post -WebSession $session
Write-Host "preview run #$($preview.runId)"
Write-Host "  $($preview.impact.headline)"
Write-Host "  clean=$($preview.impact.clean) likely=$($preview.impact.likelyDuplicates) possible=$($preview.impact.possibleDuplicates)"

$clean = @($preview.residents | Where-Object { $_.risk -eq 'none' } | Select-Object -First $Count)
if ($clean.Count -eq 0) { throw 'No unflagged candidates to approve.' }
foreach ($r in $clean) {
  Write-Host ("  approving {0} ({1}) captain row {2}" -f $r.residentName, $r.residentId, $r.captainRow)
}

$body = @{
  previewRunId = $preview.runId
  confirmed    = $true
  residentIds  = @($clean | ForEach-Object { $_.residentId })
} | ConvertTo-Json -Depth 5
$queued = Invoke-RestMethod -Uri "$BaseUrl/api/execution/new-residents/apply" -Method Post -WebSession $session `
  -ContentType 'application/json' -Body $body
Write-Host "live run #$($queued.runId) queued"

Start-Sleep -Seconds 8
$run = Invoke-RestMethod -Uri "$BaseUrl/api/runs/$($queued.runId)" -WebSession $session
Write-Host "status=$($run.run.status)"
Write-Host ($run.run.summary_json)
