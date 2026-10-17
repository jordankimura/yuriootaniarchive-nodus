$ErrorActionPreference = 'Stop'
$nodusTailscale = 'C:\Program Files\Tailscale\tailscale.exe'

# Take the visitor door off the internet first, then return to the local-only room.
if (Test-Path -LiteralPath $nodusTailscale) {
    & $nodusTailscale funnel reset
    if ($LASTEXITCODE -ne 0) { Write-Warning 'Tailscale did not confirm Funnel was turned off. Check it in the Tailscale app.' }
}
& (Join-Path $PSScriptRoot 'Stop Nodus Website.ps1')
& (Join-Path $PSScriptRoot 'Start Nodus Website.ps1') -NoBrowser
Write-Host 'The Nodus room is CLOSED to the public. The local room is running again.'
