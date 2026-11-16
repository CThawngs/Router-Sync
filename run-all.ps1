# run-all.ps1 — Thuc thi toan bo bo kiem thu va chan doan RouterSync
# Tao cac tep log thuc nghiem va tong hop RUN.txt

$ErrorActionPreference = "Continue"
if (Test-Path variable:PSNativeCommandUseErrorActionPreference) {
    $PSNativeCommandUseErrorActionPreference = $false
}
$outDir = ".agent/send-final/C4l"

Write-Host "=== 1. Tao thu muc ban giao C4l ==="
New-Item -ItemType Directory -Force $outDir | Out-Null

Write-Host "=== 2. pnpm build ==="
& pnpm build > "$outDir/build.log" 2>&1
Get-Content "$outDir/build.log" -Tail 10

Write-Host "=== 3. pnpm typecheck ==="
& pnpm typecheck > "$outDir/typecheck.log" 2>&1
Get-Content "$outDir/typecheck.log" -Tail 10

Write-Host "=== 4. tools/guard/no-secrets.mjs ==="
& node tools/guard/no-secrets.mjs > "$outDir/no-secrets.log" 2>&1
Get-Content "$outDir/no-secrets.log"

Write-Host "=== 5. pnpm test ==="
& pnpm test > "$outDir/test.log" 2>&1
Get-Content "$outDir/test.log" -Tail 10

Write-Host "=== 6. pnpm e2e ==="
& pnpm e2e > "$outDir/e2e.log" 2>&1
Get-Content "$outDir/e2e.log" -Tail 10

Write-Host "=== 7. doctor --json ==="
& node packages/cli/dist/index.js doctor --json | Out-File -FilePath "$outDir/doctor.json" -Encoding utf8
Get-Content "$outDir/doctor.json" -Tail 10

Write-Host "=== 8. rank-health test (k3) ==="
& pnpm vitest run packages/cli/test/rank-health.test.ts > "$outDir/k3-health-types.log" 2>&1
Get-Content "$outDir/k3-health-types.log" -Tail 10

Write-Host "=== 9. Sao chep k1-quickstart-clean.log ==="
if (Test-Path "k1-quickstart-clean.log") {
    Copy-Item "k1-quickstart-clean.log" "$outDir/k1-quickstart-clean.log" -Force
}

Write-Host "=== Hoan tat chay tat ca kiem thu ==="
