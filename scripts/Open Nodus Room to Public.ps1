$ErrorActionPreference = 'Stop'
$nodusProject = Split-Path -Parent $PSScriptRoot
$nodusRuntime = Join-Path $nodusProject '.local'
$nodusNode = (Get-Command node -ErrorAction Stop).Source
$nodusTailscale = 'C:\Program Files\Tailscale\tailscale.exe'
New-Item -ItemType Directory -Force -Path $nodusRuntime | Out-Null

# Funnel needs a signed-in Tailscale with HTTPS and Funnel enabled for this PC.
if (-not (Test-Path -LiteralPath $nodusTailscale)) { throw 'Tailscale is not installed.' }
$nodusTailnet = & $nodusTailscale status --json | ConvertFrom-Json
if ($nodusTailnet.BackendState -ne 'Running') { throw 'Sign in to Tailscale first, then run this again. The room was not opened.' }
$nodusDoor = 'https://' + $nodusTailnet.Self.DNSName.TrimEnd('.')

$nodusVoice = Invoke-RestMethod -Uri 'http://127.0.0.1:8788/api/status' -TimeoutSec 5
if (-not $nodusVoice.hasVoiceKey -or -not $nodusVoice.brainConnected) { throw 'Start Nodus Studio and load the voice key first. The room was not opened.' }

# Rebuild the site if the room page changed since the last build.
$nodusBuiltRoom = Join-Path $nodusProject 'dist\nodus\index.html'
$nodusRoomSource = Get-ChildItem -LiteralPath (Join-Path $nodusProject 'public\nodus') -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not (Test-Path -LiteralPath $nodusBuiltRoom) -or $nodusRoomSource.LastWriteTimeUtc -gt (Get-Item -LiteralPath $nodusBuiltRoom).LastWriteTimeUtc) {
    Push-Location $nodusProject
    try { & npm.cmd run build *> (Join-Path $nodusRuntime 'build.log'); if ($LASTEXITCODE -ne 0) { throw 'The website build failed. See .local/build.log.' } } finally { Pop-Location }
}

# Replace the local-only room with the public room. Both keep the publisher on 8794.
& (Join-Path $PSScriptRoot 'Stop Nodus Website.ps1')
if (Get-NetTCPConnection -LocalPort 8794 -State Listen -ErrorAction SilentlyContinue) { throw 'Port 8794 is still in use. Close the other room first. Nothing was made public.' }
$nodusStarted = Start-Process -FilePath $nodusNode -ArgumentList @('server/local-preview.mjs', '--connect-private-nodus', '--public') -WorkingDirectory $nodusProject -WindowStyle Hidden -RedirectStandardOutput (Join-Path $nodusRuntime 'gateway.log') -RedirectStandardError (Join-Path $nodusRuntime 'gateway-error.log') -PassThru
@{pid=$nodusStarted.Id;startTicks=$nodusStarted.StartTime.ToUniversalTime().Ticks} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $nodusRuntime 'gateway-process.json')
for ($nodusAttempt = 0; $nodusAttempt -lt 40; $nodusAttempt++) {
    Start-Sleep -Milliseconds 250
    if (Get-NetTCPConnection -LocalPort 8795 -State Listen -ErrorAction SilentlyContinue) { break }
}
if (-not (Get-NetTCPConnection -LocalPort 8795 -State Listen -ErrorAction SilentlyContinue)) { throw 'The public room did not start. See .local/gateway-error.log. Nothing was made public.' }

# Only the visitor door (8795) goes on the internet; the publisher and worker stay on loopback.
& $nodusTailscale funnel --bg 8795
if ($LASTEXITCODE -ne 0) { throw 'Tailscale Funnel did not start. Enable HTTPS and Funnel for this PC in the Tailscale admin console.' }

Write-Host ''
Write-Host 'The Nodus room is OPEN to the public.'
Write-Host ('Visitor door (Vercel NODUS_GATEWAY_URL): ' + $nodusDoor)
Write-Host 'Website: https://yuriootani.vercel.app/nodus/'
Write-Host 'Publisher (keep open, choose the Warudo camera): http://127.0.0.1:8794/operator'
Write-Host 'Close it with Close Nodus Room to Public.'
Start-Process 'http://127.0.0.1:8794/operator'
