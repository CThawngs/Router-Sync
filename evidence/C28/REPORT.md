# Evidence C28 — H2 stale table, H3 balance, H4 package

- Branch: `evidence/c28` (from origin/main 2d4536f)
- Build checked: origin/main 2d4536f (H0: #39 merged; flake-hunt: #41; H1: open PR #40, NOT merged)
- Date: 2026-11-21

## H2 — Bảng stale trêi build mới

Command: `node packages/cli/dist/index.js combos stale --source official --json` → exit 0, status OK. `official[]` = 147 rows.

### Bảng (tóm tắt)

| conclusion | rows | provider detail |
|---|---|---|
| NOT-LISTED-UPSTREAM | 124 | hf 104, nvidia 19, openrouter 1 |
| NO-OFFICIAL-SOURCE | 23 | bai 1, bzl 4, ds 1, gemini 1, google 1, groq 2, oc 4, ocz 1, private-provider 8 |
| LISTED-UPSTREAM | 0 | — |
| UPSTREAM-UNREACHABLE | 0 | — |

Sample rows (g2-stale-official.out.txt):

- `hf/CohereLabs/aya-expanse-32b = NOT-LISTED-UPSTREAM`
- `hf/CohereLabs/aya-vision-32b = NOT-LISTED-UPSTREAM`
- `hf/CohereLabs/c4ai-command-a-03-2025 = NOT-LISTED-UPSTREAM`
- `nvidia/nvidia/ai-synthetic-video-detector = NOT-LISTED-UPSTREAM`
- `openrouter/xingchen-agi/xing4.0-29b-a4b:free = NOT-LISTED-UPSTREAM`

### Host cross-check (host-check-hf.json, measured 2026-11-21T06:24:07.762Z, network OK)

- HF per-id: aya-expanse-32b → 200, aya-vision-32b → 200, c4ai-command-a-03-2025 → 200, c4ai-command-r-08-2024 → 200, c4ai-command-r7b-12-2024 → 200, openai/gpt-4o → 401.
- HF root `/api/models`: status 200, size 1000; root.has(CohereLabs/aya-expanse-32b) = false (+4 more false).
- Interpretation: on build 2d4536f, origin/main `checkOfficial()` uses the root catalog (id ∈ catalog → LISTED). So the 104 NOT-LISTED hf rows are consistent with root-catalog semantics. H1 (PR #40, bcf99f7, per-id via `hfModelUrl`, NOT merged) would flip them to LISTED-UPSTREAM, because the host per-id calls return 200.
- NVIDIA source = models.dev `/api.json`: status 200; sample nvidia steps absent (all `inNvApi` = false).
- OpenRouter `/api/v1/models`: status 200; xingchen-agi/xing4.0-29b-a4b:free absent (`hasXing` = false).

### Bảng C27 (lưu ý so sánh)

Old build's `g3-e4-official` (git show main:evidence/C27/g3-e4-official.out.txt): 241 rows, statuses PRESENT 94 / ABSENT 24 / UNVERIFIABLE 123. New build: 147 rows, new conclusion vocabulary.

## H0 context (red runs that motivated the H2 table)

- Run 44871175326 (ubuntu-latest, job 136745839721, head 1e7d49c): 12/13 failed in 8.7s. First: `AssertionError: expected '' to match /0\.1\.0/` at e2e.test.ts:299.
- Run 44871171694 (ubuntu-24.04-arm, job 136745828806, head 1e7d49c): 12/13 failed. `AssertionError: expected '' to match /0\.1\.0/` + `daemon health failed; exited=true exitCode=1` (solveForCJSWithHooks).
- Root cause: flake-hunt lacked `pnpm build`; e2e spawnSync on node_modules/.bin/routersync → ''. Fixed by PR #41 (2a1de0c). Post-fix re-runs on main 2d4536f: 44872240753 (ubuntu-24.04-arm) success, 44872244089 (ubuntu-latest) success.

## H3 — Gân đối gói bằng chứng (records.jsonl)

| record | stdout file | sha256 (16) | lines | bytes | exitCode |
|---|---|---|---|---|---|
| g0-flakehunt-u24 | g0-flakehunt-u24.out.txt | 019ee69fd8651478 | 17011 | 1850204 | 0 |
| g0-flakehunt-arm | g0-flakehunt-arm.out.txt | 374b641af26e45cb | 13650 | 929831 | 0 |
| g2-stale-official | g2-stale-official.out.txt | 51f5bc0dbc2c97c3 | 2405 | 65808 | 0 |
| host-check-hf | host-check-hf.json | 4f884ad50323b9e5 | 28 | 1340 | 0 |

verify-package (tools/agent/verify-package.mjs): `OK: 4 records, no fake records, no personal identifiers`.

### Sanitization note (trước khi commit)

- Provider names riêng của owner (sanitize thành `private-provider`) trong g2 log + dòng tóm tắt REPORT.md; `[CI-HOME]` → `/home/user/...` trong g0-flakehunt-arm log. Nguyên nhân: repo guards (no-secrets / no-personal-paths) cấm allow-marker cho private provider name và personal paths. Số dòng/conclusion/row count không đổi; hashes trong records.jsonl đã tính lại sau khi sanitize.

## H4 — Gói evidence/C28 (branch evidence/c28)

- g0-flakehunt-u24.out.txt — red log, ubuntu-latest, job 136745839721 (44871175326).
- g0-flakehunt-arm.out.txt — red log, ubuntu-24.04-arm, job 136745828806 (44871171694).
- g2-stale-official.out.txt — new-build stale table (origin/main 2d4536f).
- host-check-hf.json — host cross-check.
- records.jsonl, REPORT.md.
