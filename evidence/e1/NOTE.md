# Audit Manifest & SHA Cross-Reference — `evidence/e1` (C46 F1, F5 & 4-Path Write-Gate Audit)

## Branch & Anchor Metadata
- **Repository:** `https://github.com/CThawngs/Router-Sync`
- **Branch:** `evidence/e1` (branched cleanly from `origin/main` at `8e3dc3a81310a2a4481d9485b2b250e25d57194d`)
- **Serves:** `Phục vụ: S1, S3, S4, S7, S9`
- **Prior Baseline Anchor:** `origin/evidence/d3` (base `main` `0062e1754576f7162d1136e0ec026d6fedf73473`)
- **CI Trigger Guard:** Commit includes `[skip ci]`; pushed directly to `origin/evidence/e1` with no Pull Request and no git tags.

## Merged `main` Commit Chain Covered by `evidence/e1`
1. `d2c8e8218db6dce9e19e714106edfa774edaa976` — PR #78 (`C46-F1`, `P2`, HEAD `09526fcf5723607ff646dd5fdc54a9febc9f44fb`, `Phục vụ: S3, S4, S9`)
   - PR 5-OS CI Run `45540441441`: `18/18 SUCCESS` (`attempt=1`)
   - Post-merge `main` 5-OS CI Run `45543669347`: `18/18 SUCCESS` (`attempt=1`)
   - QA Sign-Off: `https://github.com/CThawngs/Router-Sync/pull/78#issuecomment-7152244167` (`6/6` Engineer M-mutations + `9/9` QA Q-mutations `100% KILLED`)
2. `8e3dc3a81310a2a4481d9485b2b250e25d57194d` — PR #79 (`C46-F5`, `P5`, HEAD `b8c78da1e0833670c74b1f879a1758a1b0841450`, `Phục vụ: S1, S3, S4, S7, S9`)
   - PR 5-OS CI Run `45559546370`: `18/18 SUCCESS` (`attempt=1`)
   - Post-merge `main` 5-OS CI Run `45567507968`: `18/18 SUCCESS` (`attempt=1`)
   - QA Sign-Off: `https://github.com/CThawngs/Router-Sync/pull/79#issuecomment-7155254302` (`F5-1..F5-9` + `Q8a..Q8d` `22/22` tests, `17/17` Engineer mutations + `14/14` QA mutations `100% KILLED`, `0` `no-secrets:allow:` markers)

## 4-Path Write-Gate Audit Cross-Reference
- **CLI `apply --write`** (`packages/cli/src/commands/apply.ts`): Fixed in PR #78. Enforces interactive TTY `'chay'` (`interactive-tty`, `appliedAtLevel: 'propose'`) for any `propose` target or dual-scope conflict; standing-consent non-TTY execution requires 100% `auto-safe` candidates with verified non-rolled-back human-authorized `propose` receipt (`AUTO_SAFE_RECEIPT_MISSING` fail-closed).
- **MCP `apply_plan`** (`packages/mcp-server/src/apply-plan.ts`): Fixed in PR #78. Gate 3 requires single-use `approvalToken` bound to canonical `planHash` for every `propose` target (`APPROVAL_TOKEN_REQUIRED`); tokenless execution allowed only when all targets are `auto-safe` with verified human `propose` receipt (`findVerifiedProposeReceipt` rejects `authorizedVia === 'standing-consent'`).
- **`maintain`** (`packages/cli/src/commands/maintain.ts`, `packages/daemon/src/handlers/maintain.ts`): Clean. Daemon `/maintain` handler enforces `req.method === "GET"` read-only (HTTP 405 otherwise); CLI `maintain apply`/`create` requires interactive TTY `'chay'` or HMAC-verified `apply-grant.json` + single-use secret.
- **`tick`** (`packages/cli/src/commands/tick.ts`, `packages/mcp-server/src/tick-if-due.ts`): Clean. `tick_if_due` hardcodes `--mode observe`; `tick` writes `0` bytes in `observe`/`propose` and in `auto-safe` writes only `auto-safe` targets passing `assertEligibleForAutoSafe`.

## Captured Artifact Digests (`9` Files in `evidence/e1/`)
- `records.jsonl` — 3 valid execution records (`privateNamesLoaded=12` on every row, `2298` bytes)
- `f1-propose-gate-proofs.out.txt` — `sha256: 5440a2d8d1db96e3852c9d618adf9b79b32664b75a719603f3bf11fc7c9b3135` (`4567` bytes, `38` lines)
- `f1-propose-gate-proofs.err.txt` — `sha256: 4873947490a9c3219c4d5fb7de93de63ddf201cfa6571c79f1f1bbcc3e93d697` (`4937` bytes, `22` lines)
- `f5-negative-gate-proofs.out.txt` — `sha256: 6c5846329a9586d0373973b328a20207e87de6b40fa4ad46ee3fd7a3fa2d7ac7` (`4547` bytes, `35` lines)
- `f5-negative-gate-proofs.err.txt` — `sha256: f0afd8b7df7c76e6a4c675eb58a0c7b87bc2c824c1ee89c04cd366080e2ee4aa` (`1528` bytes, `8` lines)
- `security-audit-local.out.txt` — `sha256: ba11175f6c3a2a7dbd6306cf18313c91a2b41413adb468235ae3f8b9879202b8` (`1038` bytes, `54` lines)
- `security-audit-local.err.txt` — `sha256: e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` (`0` bytes, `0` lines)
- `REPORT.md` — Self-contained C46 `e1` report (`<= 120` lines)
- `NOTE.md` — This audit manifest

## Local Security Audit Surface Summary (`security-audit-local.out.txt`)
- Overall: `ok=true`, `highCount=0`, `mediumCount=0`, `lowCount=0`, `findings=[]`
- `repoFiles`: `731` files scanned, `0` findings
- `evidenceRefs`: `27` refs / `1154` blobs scanned, `0` findings
- `tarballs`: `8` workspace packages packed & scanned, `0` findings
- `ciLogs`: `skipped_offline_flag` (`0` findings locally; GitHub PR/main CI runs verified `18/18 SUCCESS` separately)
- `writeGates`: `grant` `5/5`, `approvalToken` `5/5`, `yesWriteRouter` `2/2` (`0` findings)

## Mandatory Pre-Push Verifier Gate
1. `node tools/agent/verify-records.mjs evidence/e1/records.jsonl evidence/e1` -> `SẠCH: 3 dòng` (`exit 0`)
2. `node tools/agent/verify-package.mjs evidence/e1` -> `OK` (`exit 0`)
3. `node tools/guard/no-secrets.mjs` -> `exit 0`
4. `node tools/guard/no-personal-paths.mjs` -> `exit 0`
5. `node tools/agent/scan-private-names.mjs origin/main HEAD` -> `0` delta (`0` hits in `evidence/e1/*`)
