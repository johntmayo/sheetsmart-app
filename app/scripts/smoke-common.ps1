# Shared login helper for the manual smoke scripts. The admin password is read
# from SHEETSMART_ADMIN_PASSWORD or from app/.env, never stored in the repo.

function Get-SheetSmartPassword {
  if ($env:SHEETSMART_ADMIN_PASSWORD) { return $env:SHEETSMART_ADMIN_PASSWORD }
  $envFile = Join-Path (Split-Path $PSScriptRoot -Parent) '.env'
  if (Test-Path $envFile) {
    $line = Get-Content $envFile | Where-Object { $_ -match '^\s*ADMIN_PASSWORD\s*=' } | Select-Object -First 1
    if ($line) { return ($line -replace '^\s*ADMIN_PASSWORD\s*=', '').Trim() }
  }
  throw 'No admin password found. Set SHEETSMART_ADMIN_PASSWORD or add ADMIN_PASSWORD to app/.env.'
}

function Connect-SheetSmart {
  param([string]$BaseUrl = 'http://localhost:3001')
  $session = New-Object Microsoft.PowerShell.Commands.WebRequestSession
  $body = @{ password = (Get-SheetSmartPassword) } | ConvertTo-Json
  Invoke-RestMethod -Uri "$BaseUrl/api/login" -Method Post -WebSession $session `
    -ContentType 'application/json' -Body $body | Out-Null
  return $session
}
