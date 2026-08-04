# Read-only: print how many captain-created residents are still missing from the
# configured master copy. Handy before/after an append or an undo.
param([string]$BaseUrl = 'http://localhost:3001')

$ErrorActionPreference = 'Stop'
. "$PSScriptRoot\smoke-common.ps1"
$session = Connect-SheetSmart -BaseUrl $BaseUrl

$preview = Invoke-RestMethod -Uri "$BaseUrl/api/execution/new-residents/preview" -Method Post -WebSession $session
$i = $preview.impact
Write-Host ("preview #{0}: candidates={1} clean={2} likely={3} possible={4}" -f `
  $preview.runId, $i.candidates, $i.clean, $i.likelyDuplicates, $i.possibleDuplicates)
