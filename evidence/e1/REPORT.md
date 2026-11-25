# C46 Evidence Report — `evidence/e1` (`Phục vụ: S1, S3, S4, S7, S9`)

## 1. Scope & Anchor Metadata

- **Repository:** `https://github.com/CThawngs/Router-Sync`
- **Branch:** `origin/evidence/e1` (branched cleanly from `origin/main` @ `8e3dc3a81310a2a4481d9485b2b250e25d57194d`)
- **Coverage:** `C46-F1` (`P2` — Human Approval Gate on `propose`), 4-Path Write-Gate Audit, and `C46-F5` (`P5` — Security & Gate Negative Proofs)
- **Prior Baseline Anchor:** `origin/evidence/d3` (base `main` `0062e1754576f7162d1136e0ec026d6fedf73473`)
- **Isolation Guarantee:** Captured inside a fresh `os.tmpdir()` clone; `0` touches to live router DBs, harness configs, release tags, or npm registry; commit guarded with `[skip ci]`, no PR, no tags.

---

## 2. Four-Gate RACI Proofs (`C46-F1` & `C46-F5`)

| Ticket | Priority / Serves | PR & Head SHA | PR 5-OS CI (`attempt=1`) | QA Independent Sign-Off & Mutation Kill | Merged `main` SHA | Post-Merge `main` CI (`attempt=1`) |
|---|---|---|---|---|---|---|
| **`C46-F1`** | `P2` · `S3, S4, S9` | [#78](https://github.com/CThawngs/Router-Sync/pull/78) (`09526fcf5723`) | Run [`45540441441`](https://github.com/CThawngs/Router-Sync/actions/runs/45540441441) — **`18/18` `SUCCESS`** | [`#issuecomment-7152244167`](https://github.com/CThawngs/Router-Sync/pull/78#issuecomment-7152244167) — `6/6` Engineer M-mutations + `9/9` QA Q-mutations **`100% KILLED`** | `d2c8e8218db6dce9e19e714106edfa774edaa976` | Run [`45543669347`](https://github.com/CThawngs/Router-Sync/actions/runs/45543669347) — **`18/18` `SUCCESS`** |
| **`C46-F5`** | `P5` · `S1, S3, S4, S7, S9` | [#79](https://github.com/CThawngs/Router-Sync/pull/79) (`b8c78da1e083`) | Run [`45559546370`](https://github.com/CThawngs/Router-Sync/actions/runs/45559546370) — **`18/18` `SUCCESS`** | [`#issuecomment-7155254302`](https://github.com/CThawngs/Router-Sync/pull/79#issuecomment-7155254302) — `F5-1..F5-9` + `Q8a..Q8d` (`22/22` tests), `17/17` Engineer + `14/14` QA mutations **`100% KILLED`**, `0` `no-secrets:allow:` markers | `8e3dc3a81310a2a4481d9485b2b250e25d57194d` | Run [`45567507968`](https://github.com/CThawngs/Router-Sync/actions/runs/45567507968) — **`18/18` `SUCCESS`** |

### Key Security & Gate Properties Proven
- **`C46-F1` (Human Approval Gate on `propose`):** Non-TTY `apply --write` and tokenless MCP `apply_plan` are fail-closed on `propose` targets, mixed `auto-safe`/`propose` batches, and dual-scope conflicts. Promotion to `auto-safe` requires a verified, non-rolled-back, human-authorized `propose` receipt (`findVerifiedProposeReceipt` rejects `authorizedVia === 'standing-consent'`, invalid HMAC, or negative flags with `AUTO_SAFE_RECEIPT_MISSING`).
- **`C46-F5` (Security & Gate Negative Proofs):** Rejects spoofed/cross-provider/non-HTTPS research domains (`F5-1..F5-2`), rejects secret-like payloads across `quote`/`conclusion`/`replacementModelId` with `SECRET_DETECTED_IN_EVIDENCE` without echoing secrets or mutating files (`F5-3`), enforces weekly `5/5` research cap, `0`-cap, same-week dedup, and cross-week replay rejection (`F5-4..F5-5`), enforces single-use `approvalToken` + `planHash` + HMAC + TTL (`F5-6..F5-8`), and proves active or corrupted `freeze.json` fails closed across CLI `apply`, MCP `apply_plan`, and `tick` without consuming tokens (`F5-9`).

---

## 3. 4-Path Write-Gate Audit Summary

| Write Path | Primary Code Locations | Audit Status | Enforced Gate & Fail-Closed Behavior |
|---|---|---|---|
| **`CLI apply --write`** | `packages/cli/src/commands/apply.ts` | **Fixed** (`#78`) | Requires interactive TTY + `'chay'` (`interactive-tty`, `appliedAtLevel: 'propose'`) whenever any target combo is at `propose` or has dual-scope conflict; standing-consent bypass allowed only when 100% of candidate combos have verified `auto-safe` + non-rolled-back human-authorized `propose` receipt (`AUTO_SAFE_RECEIPT_MISSING` fail-closed). |
| **`MCP apply_plan`** | `packages/mcp-server/src/apply-plan.ts` | **Fixed** (`#78`) | Gate 3 requires single-use `approvalToken` matching `planHash` for every `propose` target (`APPROVAL_TOKEN_REQUIRED`); tokenless execution allowed only when every target is `auto-safe` with verified `propose` receipt; `findVerifiedProposeReceipt` rejects `authorizedVia === 'standing-consent'`. |
| **`maintain`** | `packages/cli/src/commands/maintain.ts`, `packages/daemon/src/handlers/maintain.ts` | **Clean** | Daemon `/maintain` (`GET /api/v1/maintain/plan`) is GET-only read-only (HTTP 405 on non-GET); CLI `maintain apply`/`create` requires interactive TTY `'chay'` or HMAC-verified `apply-grant.json` + single-use secret. |
| **`tick`** | `packages/cli/src/commands/tick.ts`, `packages/mcp-server/src/tick-if-due.ts` | **Clean** | `tick_if_due` hardcodes `--mode observe`; `tick` writes `0` bytes in `observe`/`propose` and in `auto-safe` writes only `auto-safe` targets passing `assertEligibleForAutoSafe`. |

---

## 4. Isolated Execution Captures (`evidence/e1/records.jsonl`)

Built sequentially (`pnpm -r --workspace-concurrency=1 build`, no `RS_FORCE_HEAVY`, no `CI=true`) and captured via `tools/agent/capture-evidence.mjs` (`privateNamesLoaded=12` on all 3 rows):

| # | Record ID | Command (`SAFE_VERBS`) | Exit | Duration | Verified Outcome | `stdout` SHA-256 (12) | `stderr` SHA-256 (12) |
|---:|---|---|---:|---:|---|---|---|
| 1 | `f1-propose-gate-proofs` | `pnpm test:file packages/cli/test/c46-f1-propose-gate.test.ts packages/mcp-server/test/c46-f1-apply-plan-propose.test.ts` | `0` | `33192 ms` | `2/2` files, `12/12` tests passed (`9` CLI + `3` MCP) | `5440a2d8d1db` | `4873947490a9` |
| 2 | `f5-negative-gate-proofs` | `pnpm test:file packages/core/test/c46-f5-research-and-cost-gates.test.ts packages/mcp-server/test/c46-f5-mcp-negative-gates.test.ts packages/cli/test/c46-f5-freeze-and-cli-gates.test.ts` | `0` | `43023 ms` | `3/3` files, `22/22` tests passed (`13` core + `6` MCP + `3` CLI) | `6c5846329a95` | `f0afd8b7df7c` |
| 3 | `security-audit-local` | `node tools/agent/security-audit.mjs --json` | `0` | `52884 ms` | `ok=true`, `high=0 medium=0 low=0`; `repoFiles=731`, `evidenceRefs=27/1154`, `tarballs=8`, `writeGates` (`grant 5/5`, `approvalToken 5/5`, `yesWriteRouter 2/2`) | `ba11175f6c3a` | `e3b0c44298fc` |

---

## 5. Package Hygiene & Verifier Checklist

All mandatory gates verified `exit 0` before pushing `origin/evidence/e1` (`9` files `<= 10`, `REPORT.md <= 120` lines, `[skip ci]`, no PR, no tags):
1. `node tools/agent/verify-records.mjs evidence/e1/records.jsonl evidence/e1` -> `SẠCH: 3 dòng`
2. `node tools/agent/verify-package.mjs evidence/e1` -> `OK` (`3` records, `0` personal identifiers, `privateNamesLoaded >= 12`)
3. `node tools/guard/no-secrets.mjs` & `node tools/guard/no-personal-paths.mjs` -> `0` findings
4. `node tools/agent/scan-private-names.mjs origin/main HEAD` -> `0` delta (`0` hits in `evidence/e1/*`)
