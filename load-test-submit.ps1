# ============================================================================
#  経費申請APIの並列負荷試験
#
#  使い方:
#    .\load-test-submit.ps1 -concurrent 10 -total 100 -category transport
#
#  カテゴリを変えて実行し、結果（成功件数・金額）を比較してください。
# ============================================================================
param(
    [int]$concurrent = 10,
    [int]$total = 100,
    [string]$category = "transport",
    [string]$baseUrl = "http://localhost:3100"
)

$url = "$baseUrl/api/reports/$category"

Write-Host "Starting load test: $concurrent concurrent, $total total requests"
Write-Host "Target: $url"

$runspacePool = [runspacefactory]::CreateRunspacePool(1, $concurrent)
$runspacePool.Open()

$jobs = @()
$scriptBlock = {
    param($url, $index)
    $body = @{
        userId = (($index % 40) + 1)
        title = "負荷試験 #$index"
        targetMonth = "2026-07"
        attendeeCount = 2
        items = @(
            @{ description = "明細A"; unitPrice = 1000; qty = 1 },
            @{ description = "明細B"; unitPrice = 500;  qty = 2 }
        )
    } | ConvertTo-Json -Depth 5

    $start = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $response = Invoke-WebRequest -Uri $url -Method POST -Body $body `
            -ContentType "application/json" -UseBasicParsing -TimeoutSec 30
        $start.Stop()
        $json = $response.Content | ConvertFrom-Json
        @{
            Status = $response.StatusCode
            Time = $start.ElapsedMilliseconds
            Total = if ($json.data) { $json.data.total } else { $null }
            Error = $null
        }
    } catch {
        $start.Stop()
        @{ Status = 0; Time = $start.ElapsedMilliseconds; Total = $null; Error = $_.Exception.Message }
    }
}

for ($i = 0; $i -lt $total; $i++) {
    $powershell = [powershell]::Create().AddScript($scriptBlock).AddArgument($url).AddArgument($i)
    $powershell.RunspacePool = $runspacePool
    $jobs += @{ PowerShell = $powershell; Handle = $powershell.BeginInvoke() }
}

Write-Host "Waiting for results..."
$results = @()
$errors = 0
foreach ($job in $jobs) {
    $result = $job.PowerShell.EndInvoke($job.Handle)
    if ($result.Error) { $errors++ }
    $results += $result
    $job.PowerShell.Dispose()
}

$runspacePool.Close()
$runspacePool.Dispose()

$successful = $results | Where-Object { $_.Status -eq 200 }
$times = $successful | ForEach-Object { $_.Time }
$avgTime = ($times | Measure-Object -Average).Average
$sortedTimes = $times | Sort-Object
$p95 = if ($sortedTimes.Count -gt 0) { $sortedTimes[[math]::Floor($sortedTimes.Count * 0.95)] } else { 0 }

# 登録された合計金額の分布（同じ入力なのにばらつく場合は要調査）
$distinctTotals = $successful | ForEach-Object { $_.Total } | Sort-Object -Unique

Write-Host "`n=== Results ==="
Write-Host "Category: $category"
Write-Host "Total requests: $total"
Write-Host "Concurrent: $concurrent"
Write-Host "Successful (HTTP 200): $($successful.Count)"
Write-Host "Errors: $errors"
Write-Host "Avg response time: $([math]::Round($avgTime, 2))ms"
Write-Host "P95 response time: $([math]::Round($p95, 2))ms"
Write-Host "Distinct total amounts: $($distinctTotals -join ', ')"
