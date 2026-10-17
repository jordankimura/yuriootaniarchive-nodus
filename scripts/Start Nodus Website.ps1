param([switch]$NoBrowser)
$ErrorActionPreference = 'Stop'
$nodusProject = Split-Path -Parent $PSScriptRoot
$nodusRuntime = Join-Path $nodusProject '.local'
$nodusNode = (Get-Command node -ErrorAction Stop).Source
New-Item -ItemType Directory -Force -Path $nodusRuntime | Out-Null
$nodusBuiltRoom = Join-Path $nodusProject 'dist\nodus\index.html'
$nodusRoomSource = Get-ChildItem -LiteralPath (Join-Path $nodusProject 'public\nodus') -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
if (-not (Test-Path -LiteralPath $nodusBuiltRoom) -or $nodusRoomSource.LastWriteTimeUtc -gt (Get-Item -LiteralPath $nodusBuiltRoom).LastWriteTimeUtc) {
    Push-Location $nodusProject
    try { & npm.cmd run build *> (Join-Path $nodusRuntime 'build.log'); if ($LASTEXITCODE -ne 0) { throw 'The website build failed. See .local/build.log.' } } finally { Pop-Location }
}
if (-not (Test-Path -LiteralPath (Join-Path $nodusProject 'node_modules/vite/bin/vite.js'))) {
    throw 'Run npm ci in the website folder once before using this shortcut.'
}
$nodusGateway = Get-NetTCPConnection -LocalPort 8794 -State Listen -ErrorAction SilentlyContinue
if ($nodusGateway) {
    $nodusExisting = Invoke-WebRequest -Uri 'http://127.0.0.1:8794/operator' -UseBasicParsing -TimeoutSec 3
    if ($nodusExisting.Content -notmatch '<title>Nodus.*Local publisher</title>') {
        throw 'Port 8794 is occupied by another service. Nothing was changed.'
    }
} else {
    $nodusStarted = Start-Process -FilePath $nodusNode -ArgumentList @('server/local-preview.mjs', '--connect-private-nodus') -WorkingDirectory $nodusProject -WindowStyle Hidden -RedirectStandardOutput (Join-Path $nodusRuntime 'gateway.log') -RedirectStandardError (Join-Path $nodusRuntime 'gateway-error.log') -PassThru
    @{pid=$nodusStarted.Id;startTicks=$nodusStarted.StartTime.ToUniversalTime().Ticks} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $nodusRuntime 'gateway-process.json')
}
# The room program now serves the built site itself; no separate site server is started.
Write-Host 'Local website preview is starting. Warudo and the Nodus voice app must already be running.'
Write-Host 'Camera publisher: http://127.0.0.1:8794/operator'
Write-Host 'Visitor preview: http://127.0.0.1:8794/nodus/'
Write-Host 'Choose Share Warudo window in the publisher. This does not make the demo public.'
Start-Sleep -Seconds 2
if (-not $NoBrowser) { Start-Process 'http://127.0.0.1:8794/operator' }
