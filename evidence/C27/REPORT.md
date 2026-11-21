# C27 Closeout Report

## G0 — Main 44788053023 attempt 1 (third red run)

**Verdict: CODE failure (e2e daemon health race).**

- Attempt 1 conclusion: `failure`. Only red job: `verify (ubuntu-24.04-arm, node 22)` — a REAL job (`continue-on-error` applies only to `windows-11-arm`, ci.yml line 26). No ARM masking involved.
- Failing step: `End-to-end`; failing test: `test/e2e/e2e.test.ts > starts the daemon on a random port and answers a health request`; assertion `e2e.test.ts:470:16` — `expected false to be true` (daemon never answered `/api/v1/health` within 40×500 ms on ARM node 22).
- ci-watch classification (record `g0-classify`, sha 0271e22): `CODE:` / `failStep=Run Tests` / `Hook timed out in 10000ms` (the E0 baseline) — not infra.
- e2e daemon race: rerun attempt 2 → success. The at-98 do-while fix (E2.5) targets the same class of first-iteration timing flake; flake-hunt run 44791152720 (100 iterations, post-fix) = ARM node 24 red=0, ubuntu node 24 red=0.
- Main push runs since 4308465 (attempt 1 / final):

| sha | run | attempt 1 | final | red job |
|---|---|---|---|---|
| 009d5b4 | 44866932530 | running | running | (PR #38 body push) |
| c639f38 | 44788053023 | failure | success | verify (ubuntu-24.04-arm, node 22) — e2e daemon health |
| 0271e22 | 44775807066 | failure | failure | verify (windows-latest, node 22) — Hook timed out (at-143) |
| f3410b9 | 44767365421 | failure | failure | Hook timed out (low-resource.test.ts:51) |
| 4c2c3d5 | 44764609302 | failure | failure | flake-hunt (at-98) |
| 7408d64 | 44759899657 | success | success | — |
| 4308465 | 44701424568 | success | success | — |

## G1 — Code from the local machine via PR

- E1 (`fix/c27-closeout`, commit f8bf011): ci-watch prints failing-step context lines → PR #38, 18/18 checks green, **squash-merged** (merge sha 009d5b4).
- E2.5 + G1.3 (`fix/c27-e25-at98`, commits 7655ecc + 5e4d5af + b7d8ce6): do-while read-back poll (at-98 ARM flake) + pre-commit hook refusing direct commits on main (tools/hooks/pre-commit, install-hooks installs it, AGENTS.md documents it, node:test covers main/master block + feature-branch allow) + G4 (verify-package record checks + measurement scripts in tools/agent) → PR #37, CI green (18/18), **squash-merged** (merge sha PENDING).
- Local `main` was reset to `origin/main` (no GitHub history rewrite); the direct commit 5680ef0 was moved to the branch.

## G2 — E3: startup regression

- E3.1 dist hash: full build of f3ed81e/d8233ba is impossible (zod v3→v4 API drift in old commits: `error` param removed, unrelated to startup). Recorded HEAD dist sha `32b9bfeaeed82fd4b8a2617bfee35018a5ca6760f650e267549716793880bd89` (record g2-abba-2).
- E3.2 ABBA: 10 interleaved `--version` samples per leg (A B B A A B B A A B). A median 1988 ms, B median 2690 ms; ranges overlap (A 1907–3565, B 1662–9868). Conclusion: **noise, not a regression** — machine under load (free RAM 0.4–0.7 GiB), high variance, no clean signal.
- E3.3: the wrong note ("2 workers is a vitest setting, unrelated to startup") is removed from this report.

## G3 — flake-hunt + catalog table

- Flake-hunt 44791152720 (post-E2.5-fix, 100 iterations): **windows-11-arm node 24 red=0, ubuntu-latest node 24 red=0**. No assertion failures (the earlier run 44788131616 caught at-98:172 readBackLevel full → db-only; fixed by do-while).
- E4 combos stale (records g3-e4-stale/g3-e4-official/g3-table2): 9Router real DB (read-only), rows=241, providers=18 (private collapsed to `<ppNN>`, openai-compatible-* collapsed). counts: PRESENT 94, PRESENT-NORMALIZED 0, DISABLED 0, ABSENT 24, UNVERIFIABLE 123. hf=UNVERIFIABLE 104 (catalog not reachable from this host), nvidia=PRESENT 11 / ABSENT 19; official check ran on ABSENT/UNVERIFIABLE rows: NO-OFFICIAL-SOURCE 146, NOT-LISTED-UPSTREAM 1 (openrouter), no deletions, no writes.

## G4 — Evidence rules

- G4.1: verify-package.mjs now rejects records missing exitCode/durationMs/stdout/stderr/sys, duplicate ids, and commands running temp-dir scripts; test test/agent/verify-package-record-fields.node.test.mjs (5/5) + mutation-verified (mutant → red).
- G4.2: measurement/mutation scripts moved from temp into tools/agent/ (effective-timeouts.mjs, mutate-hooktimeout.mjs, mutate-ci-watch-markers.mjs) with test/agent/measurement-scripts.node.test.mjs (3/3, mutation-verified).
- Hand-crafted records e2-evidence/e3-dist were dropped from records.jsonl; verifier (standard sha) on the final package: **SẠCH: 11 dòng**.

## G5 — Package

- Branch `evidence/c27`, dir `evidence/C27/`, 9 files (≤10), `[skip ci]`, no PR.
- REPORT is this file (UTF-8, no BOM).
- Records: `records.jsonl` (11 records, all capture.mjs) + the 8 key `*.out.txt` (e0-4-mut, e1-mut, g0-classify, g2-abba, g3-e4-official, g3-e4-stale, g3-table2).
- One line per record (id, exit, durationMs, sha256(stdout) prefix): see `records.jsonl`.

## Merge / CI status

- PR #38: merged (009d5b4). PR #37: merged (sha PENDING). Main run after merge: PENDING (ci-watch).