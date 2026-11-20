# REPORT â€” C26: code on main, prepush e2e, ARM flake hunt, startup, public catalogs

**Date:** 2026-11-20 **Status:** D0â€“D5 mÃ£ Ä‘Ã£ trÃªn main (PR #32/#33/#34/#35); main CI run 44775807066 **failure** (hook timeout á»Ÿ at-108/at-143, khÃ´ng pháº£i mÃ£ C26). KhÃ´ng dÃ¹ng nhÃ£n XONG cho D0 khi main CI Ä‘á».
**Main tip:** 0271e22.

## Record IDs (capture.mjs; records.jsonl)
- `c26-d0-mainci` exit 11 â€” ci-watch trÃªn merge SHA 0271e22: job `verify (windows-latest, node 22)` code (hook timeout).
- `c26-d1-tests` exit 0 â€” prepush wiring + e2e tests pass.
- `c26-d2-flake` exit 0 â€” flake-hunt run 44764609302 summary (ARM 1/50 red, ubuntu 0/50).
- `c26-d3-smoke` exit 0 â€” 7 Product-smoke ARM runs classified.
- `c26-d4-startup` exit 0 â€” 6 scratch builds, 20 samples Ã— (version/scan/floor).
- `c26-d5-table` exit 0 â€” read-only table of the real 9Router DB.

## D0 â€” code C25 lÃªn main â€” Má»˜T PHáº¦N
- PR #32 (head e613d30) CI run 44758736134 success 18/18 â†’ squash merge 7408d64.
- PR #33 (flake-hunt workflow) run 44763180840 success â†’ merge 4c2c3d5.
- PR #34 (at-98 TTL fix) run 44766142846 success â†’ merge f3410b9.
- PR #35 (HF/NVIDIA catalogs) run 44773811831 success â†’ merge 0271e22.
- `pnpm prepush` exit 0 before each push; `ci-watch` on PR heads exit 0.
- **Main after merge:** run 44775807066 conclusion=failure; failing job `verify (windows-latest, node 22)`, step `Run Tests`, `Hook timed out in 10000ms` at `test/acceptance/at-108.test.ts:39` and `test/acceptance/at-143-combo-strategy.test.ts:235`. ci-watch exit=11 (code). Main run f3410b9 cÅ©ng failure â†’ baseline flake, khÃ´ng pháº£i diff C26. KhÃ´ng rerun Ä‘á»ƒ xanh.

## D1 â€” prepush e2e â€” XONG (mÃ£ trÃªn main)
- `test/agent/prepush-wiring.node.test.mjs`: chuá»—i prepush Ä‘Ãºng thá»© tá»± lint â†’ typecheck:changed â†’ heavy.test:related â†’ validate-workflows; `test:related` Ä‘i qua heavy.mjs.
- `c24-a0-mutation2.out.txt` giáº£i thÃ­ch: script C24 dÃ¹ng mutant `pnpm test:changed` (vitest `--changed` chá»‰ tháº¥y working tree, khÃ´ng tháº¥y file Ä‘Ã£ commit) + dá»±ng base diff trÃ¹ng HEAD nÃªn red test khÃ´ng náº±m trong diff â†’ exit 0. Lá»—i do cÃ¡ch dá»±ng thÃ­ nghiá»‡m, khÃ´ng pháº£i lá»— há»•ng prepush tháº­t (Ä‘Ã£ cÃ³ test D1 cháº·n).
- Mutation D1: Ä‘á»•i prepush â†’ `pnpm test:changed`, test Ä‘á»; sha256 `2738935eb06ebb9973caf880cabd31873a0edcc3d65fc46f433f36ec57378671` (trÃ¹ng báº£n mutant C24).

## D2 â€” tÃ¡ch tÃ­n hiá»‡u ARM â€” XONG (mÃ£ trÃªn main)
- 66 CI runs tá»« 2026-11-17: ARM24 failure(any)=11; **solo ARM24=1 (1.5%)** = run 44699916948; ARM22 solo=0. 10 run kia cÃ³ 2â€“8 job `verify` khÃ¡c Ä‘á» â†’ nhiá»…u, khÃ´ng Ä‘áº·c trÆ°ng ARM.
- Solo 44699916948: step `Run Tests`, `test/acceptance/at-98.test.ts:309`, `AssertionError: expected true to be false`.
- flake-hunt workflow `.github/workflows/flake-hunt.yml` (`workflow_dispatch` duy nháº¥t, 50 iterations, ARM node24 + ubuntu, `timeout-minutes: 60`, `fail-fast: false`, **khÃ´ng** continue-on-error); validate-workflows OK 2 files, tests 16 pass.
- Káº¿t quáº£ run 44764609302: ubuntu **0/50 red**; windows-11-arm **1/50 red** (iteration 9): `AssertionError: expected 'db-only (degraded)' to be 'full'` â†’ lá»—i test do `readBackTtlWaitMs: 1` race, Ä‘Ã£ sá»­a lÃªn 100ms (PR #34), assertion giá»¯ nguyÃªn.

## D3 â€” 7 run Product smoke ARM â€” Má»˜T PHáº¦N (chá»‰ bÃ¡o)
- 44667946979/44653292341/44583793409: step `Build`, exit 1 trÃªn cáº£ nhiá»u OS â†’ lá»—i mÃ£ chung, khÃ´ng pháº£i ARM riÃªng.
- 44459910287: Product smoke, timeout (retry timeout_minutes 40).
- 44299640069/44297272360: Product smoke, cÃ³ budget hits nhÆ°ng exit 1 (khÃ´ng kháº³ng Ä‘á»‹nh budget vÆ°á»£t).
- 44294930936: `Secret & Personal Path Guard`, Exit 1 (lá»—i guard).
- KhÃ´ng sá»­a ngÃ¢n sÃ¡ch (chá»‰ `build-budgets.mjs` Ä‘Æ°á»£c phÃ©p).

## D4 â€” khá»Ÿi Ä‘á»™ng CLI â€” Má»˜T PHáº¦N
- 6 báº£n scratch build riÃªng (`add0510`, `8363c5b`, `f3ed81e`, `d8233ba`, `93d1d84`, `4308465`), `pnpm install --frozen-lockfile` + `pnpm build` riÃªng; 20 máº«u/báº£n, ABBA, `node -e ""` lÃ m Ä‘Ã¡y.
- `--version`: p50 439.8â†’458.4â†’421.0â†’541.3â†’562.3â†’548.1 ms; p95 866.5â†’540.1â†’540.0â†’752.7â†’691.5â†’648.6 ms.
- `scan`: p50 702.7â†’686.1â†’639.8â†’779.0â†’772.9â†’758.7 ms; p95 966.6â†’824.0â†’784.6â†’1022.4â†’2020.3â†’1431.7 ms.
- P50 jump >15% Ä‘áº§u tiÃªn: **d8233ba** (+28.6% version, +21.8% scan) â€” commit "smoke budget truth + RAM-aware tests and honest stale evidence (C20 #24)" Ä‘á»•i 14 file (heavy.mjs, low-resource.mjs, vitest.config.ts, ci.yml, perf-hook...).
- Hai thÃ­ nghiá»‡m há»ng (gÃ³i file in rá»—ng; wrapper compile-cache exitâ‰ 0 20/20) khÃ´ng cÃ³ artifact trong repo Ä‘á»ƒ sá»­a trong phiÃªn nÃ y â†’ CHÆ¯A LÃ€M pháº§n Ä‘Ã³.

## D5 â€” danh má»¥c cÃ´ng khai â€” XONG (mÃ£ trÃªn main)
- DB tháº­t Ä‘á»‹nh vá»‹ theo default adapter: `%APPDATA%/9router/db/data.sqlite` (79 MB, read-only) â€” C25 Ä‘Ã£ bá» sÃ³t path nÃ y.
- Báº£ng provider theo sá»‘ dÃ²ng: hf=936, nvidia=270, oc=243, openrouter=144, `<pp01>`=99, ag=98, <pp07>=63, gemini=54, groq=54, ocz=45, bzl=31.
- ThÃªm source `hf` (Hugging Face public models API) vÃ  `nvidia` (models.dev **catalog**, khÃ´ng gá»™p vá»›i official); network error â†’ `UPSTREAM-UNREACHABLE`; cache 10 phÃºt; test 10/10.
- Mutation: Ä‘á»•i `kind` nvidia `catalog-api`â†’`model-list-api`, test Ä‘á»; sha256 `5f8243b972cd59929c492926187f45d051cd2fc31bc27ff69f946992f523cf42`.

## D6 â€” gÃ³i â€” XONG
- `evidence/c26`: 10 file, `[skip ci]`, email noreply `6+...`, khÃ´ng PR, khÃ´ng merge; `gh run list --branch evidence/c26` rá»—ng.
- `c26-b1-mutation` cá»§a C25 Ä‘Ã£ che `<USER_DIR>` vÃ  pháº§n repo OneDrive trong `command`; quÃ©t guard trÃªn gÃ³i C26: 0 khá»›p. verify-records: Sáº CH 6 dÃ²ng.

## PR / CI
- #32 7408d64, #33 4c2c3d5, #34 f3410b9, #35 0271e22 â€” táº¥t cáº£ PR CI xanh.
- Main run 44775807066 **failure** (hook timeout, baseline). KhÃ´ng rerun.

## UNKNOWN / chÆ°a lÃ m
- NguyÃªn nhÃ¢n hook-timeout trÃªn main (at-108/at-143); hai thÃ­ nghiá»‡m startup há»ng; ABSENT/UNVERIFIABLE theo status khÃ´ng tÃ¡ch Ä‘Æ°á»£c tá»« cá»™t `models` cá»§a DB; OmniRoute reader; apps drift; Notion; node:sqlite adapter.
