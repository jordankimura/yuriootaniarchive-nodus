$ErrorActionPreference = 'Stop'
$nodusRuntime = Join-Path (Split-Path -Parent $PSScriptRoot) '.local'
foreach ($nodusService in @('gateway','vite')) {
    $nodusRecordPath = Join-Path $nodusRuntime ($nodusService + '-process.json')
    if (Test-Path -LiteralPath $nodusRecordPath) {
        $nodusRecord = Get-Content -LiteralPath $nodusRecordPath -Raw | ConvertFrom-Json
        $nodusProcess = Get-Process -Id $nodusRecord.pid -ErrorAction SilentlyContinue
        if ($nodusProcess -and $nodusProcess.ProcessName -eq 'node' -and $nodusProcess.StartTime.ToUniversalTime().Ticks -eq $nodusRecord.startTicks) {
            Stop-Process -Id $nodusProcess.Id
        }
    }
}
Write-Host 'The local website preview is stopped. Warudo, Connectome and the voice app remain running.'
