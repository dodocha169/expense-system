# ============================================================================
#  承認・取り下げの同時実行試験
#
#  同じ申請に対して「承認」と「取り下げ」を同時に投げます。
#  月末に承認者と申請者が同時に操作している状況を再現します。
#
#  使い方:
#    .\load-test-approve.ps1 -reportId 1 -rounds 20
#
#  実行後は必ずアプリのログも確認してください:
#    docker compose logs --tail=100 app
# ============================================================================
param(
    [int]$reportId = 1,
    [int]$rounds = 20,
    [string]$baseUrl = "http://localhost:3100"
)

Write-Host "Target report: $reportId"
Write-Host "Rounds: $rounds (each round fires approve and withdraw at the same time)"

$scriptBlock = {
    param($url, $body)
    $start = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest -Uri $url -Method POST -Body $body `
            -ContentType "application/json" -UseBasicParsing -TimeoutSec 30
        $start.Stop()
        @{ Status = $response.StatusCode; Time = $start.ElapsedMilliseconds; Body = $response.Content; Error = $null }
    } catch {
        $start.Stop()
        $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { 0 }
        @{ Status = $status; Time = $start.ElapsedMilliseconds; Body = $null; Error = $_.Exception.Message }
    }
}

$runspacePool = [runspacefactory]::CreateRunspacePool(1, 4)
$runspacePool.Open()

$ok = 0
$failed = 0
$connectionLost = 0

for ($r = 1; $r -le $rounds; $r++) {
    $approveBody  = @{ approverId = 8; comment = "round $r" } | ConvertTo-Json
    $withdrawBody = @{ userId = 1;     comment = "round $r" } | ConvertTo-Json

    $jobs = @()

    $ps1 = [powershell]::Create().AddScript($scriptBlock).
        AddArgument("$baseUrl/api/reports/$reportId/approve").AddArgument($approveBody)
    $ps1.RunspacePool = $runspacePool
    $jobs += @{ Name = "approve";  PowerShell = $ps1; Handle = $ps1.BeginInvoke() }

    $ps2 = [powershell]::Create().AddScript($scriptBlock).
        AddArgument("$baseUrl/api/reports/$reportId/withdraw").AddArgument($withdrawBody)
    $ps2.RunspacePool = $runspacePool
    $jobs += @{ Name = "withdraw"; PowerShell = $ps2; Handle = $ps2.BeginInvoke() }

    foreach ($job in $jobs) {
        $result = $job.PowerShell.EndInvoke($job.Handle)
        $job.PowerShell.Dispose()

        $label = "[round $r] $($job.Name)"
        if ($result.Status -eq 200) {
            $ok++
            Write-Host "$label -> 200 OK ($($result.Time)ms)"
        } elseif ($result.Status -eq 0) {
            $connectionLost++
            Write-Host "$label -> 接続できませんでした ($($result.Error))" -ForegroundColor Red
        } else {
            $failed++
            Write-Host "$label -> $($result.Status) ($($result.Time)ms)" -ForegroundColor Yellow
        }
    }

    Start-Sleep -Milliseconds 200
}

$runspacePool.Close()
$runspacePool.Dispose()

Write-Host "`n=== Results ==="
Write-Host "HTTP 200        : $ok"
Write-Host "HTTP error      : $failed"
Write-Host "接続不能         : $connectionLost"
Write-Host ""
Write-Host "接続不能が出た場合は、アプリのプロセス状態を確認してください:"
Write-Host "  docker compose ps"
Write-Host "  docker compose logs --tail=200 app"
