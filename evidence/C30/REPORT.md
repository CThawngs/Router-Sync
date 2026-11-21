# Evidence C30 — private-name leak removed, standard evidence tools, conclusion labels, e2e verdict

- Build checked: `origin/main` = **8c3f529** (PR #44). Previous build: **85f4be3** (PR #43).
- Date: 2026-11-21 (Asia/Saigon). Branch: `evidence/c30`, `[skip ci]`, no PR.
- Records in this package: 4 (stale table, host check, CI watch of 85f4be3, CI watch of 8c3f529). File budget: 10 including this report.

## K0 — private provider names on a public branch — XONG

`evidence/c29` (commit `d7edfe5`) carried real private provider names: 27 matching
lines (REPORT.md 2, g2-stale-official.out.txt 25) in the scan run for this round.
Branch deleted on the remote:

```
git push origin --delete evidence/c29
git ls-remote origin evidence/c29   -> (no ref)
```

Commit `d7edfe5` stays reachable by sha until GitHub prunes it. Its content is
provider names only — no keys, no tokens.

Scan (loaded private-name list, counts only, names never printed):

| where | matches |
|---|---|
| `origin/main` | 0 |
| `origin/evidence/c25` / `c26` / `c27` / `c28` | 0 / 0 / 0 / 0 |
| `origin/replay/c29-main` | 0 |
| `origin/fix/*` (all 15), `origin/feat/*`, `origin/c2*`, `origin/dependabot/*` | 0 |
| PR #40, #41, #42, #43 (title + body + comments) | 0 |
| CI log, PR #43 head run `44901536267` (8.9 MB) | 0 |
| deleted `d7edfe5` (the leak itself) | 27 |

Root cause: the C29 branch used an agent-written `capture.mjs` that hardcoded
`masked: []` and never loaded the private-name list. Not a key problem — a
masking problem.

## K1 — standard evidence tools restored — XONG

- `tools/agent/capture.mjs` = `2f2768cf…16514`, `tools/agent/verify-records.mjs` =
  `7b310d90…8a48` (standard RouterSync-tools copies). Both pinned by
  `test/agent/evidence-tools-sha.node.test.mjs` with the full 64-hex sha; one
  edited byte makes the test red.
- `host-check.mjs` rewritten: summary only (id → status, counts). 909 bytes vs
  the C29 file's 4.7 MB, which dumped the whole HF/OpenRouter catalog.
- `verify-package.mjs` kept as a second layer. Its scan now opens every
  `*.out.txt` / `*.err.txt` — the C29 leak sat in files the old scan never read.
- Re-captured with the standard tool (record `c30-stale-official`):
  `masked.privateNamesLoaded = 4`, `masked.privateName = 27`. Both verifiers
  green: `verify-records` → `SẠCH: 4 dòng`; `verify-package` → `OK: 4 records`.

## K2 — "orphan main / force-push" — the real story — XONG

On GitHub: `86488fa` and `3281093` are ancestors of `origin/main`

```
compare 2d4536f...86488fa -> ahead 1, behind 0
compare 86488fa...85f4be3 -> ahead 1, behind 0
compare 3281093...85f4be3 -> ahead 4, behind 0
```

History is linear; nothing was rewritten.

Non-fast-forward ref updates made by this agent session: **none**. `git reflog`
for remote refs shows `update by push` entries only (no forced update), and the
only forced-update line is a *fetch* artifact:

```
86488fa origin/main@{2026-11-21 13:55:29 +0700}: fetch --depth 1 origin main: forced-update
```

That is the whole "orphan" story: the local clone is shallow
(`git rev-parse --is-shallow-repository` = true). The shallow fetch grafted
`86488fa` as a root commit, so locally it had no parent and looked like a new
root. Nothing on GitHub was orphaned.

Local copy cleaned: `evidence/c29`, `replay/c29-main`, `j4-main-bak` deleted;
`main` = `origin/main` = `8c3f529`.

PR #40 closed with the real reason: it diverged from main (`fa777bb...85f4be3`
= diverged 7 / 4), so it could not fast-forward; its content shipped through #43.

Guard added: `tools/guard/no-force-push.mjs` rejects a non-fast-forward ref
update; `tools/hooks/pre-push` calls it; `AGENTS.md` says "never force-push".
Covered by `test/agent/no-force-push.node.test.mjs` (throwaway repo, real remote,
plus a mutation that removes the check and shows the bad line passing).

## K3 — conclusion labels — XONG

| HTTP outcome of the per-id probe | conclusion |
|---|---|
| 200, parseable body | `LISTED-UPSTREAM` |
| 404 | `NOT-LISTED-UPSTREAM` |
| 401, 403, other 4xx (except 404/429) | `ACCESS-RESTRICTED-OR-ABSENT` |
| 429 after the retry budget | `UPSTREAM-UNREACHABLE` |
| 5xx, network error, timeout, unparseable 200 | `UPSTREAM-UNREACHABLE` |

`perIdStatusConclusion(status)` is exported; tests cover 200, 404, 401, 403, 429
exhausted, 500, 502, network error, timeout, plus a mutation assertion that
`500 → ACCESS-RESTRICTED-OR-ABSENT` fails. 26 tests in
`packages/cli/test/stale-official.test.ts`. `docs/combos-stale.md` updated.

C29 J0.3 (concurrency of per-id lookups) closed as **not required**: 147 rows
took 32.6 s sequentially (record `c30-stale-official`), which is acceptable, and
sequential probing keeps the 429 budget predictable. Reason recorded in
`docs/combos-stale.md`.

## K4 — e2e daemon flake — two different failures

**(a) flake-hunt reds 44880526385 / 44880559648 — MỘT PHẦN (explained, not a daemon bug)**

Both ran on `fa777bb` (branch `fix/c28-h1-official-perid`), created 07:30Z on
2026-11-21. That branch does not contain #41's `pnpm build` step, so the jobs
never built the workspace: the fixture's `@routersync/mcp-server/dist/index.js`
was missing, `routersync --version` printed nothing, and the daemon health
assertion failed every iteration (red=100 on both arms).

**(b) `44788053023` attempt 1, `verify (ubuntu-24.04-arm, node 22)` — CHƯA LÀM (unexplained)**

Main CI, `c639f38`, 2026-11-20T17:56Z, with `pnpm build`. Failed at
`e2e.test.ts:470` (daemon no health answer after 20 s). Run finished `success`
on attempt 2. Not explained and not reproduced in this round.

**Re-run on current main (K4.2)** — flake-hunt, `85f4be3`, 100 iterations,
node 22, `test/e2e/e2e.test.ts`, project `e2e`:

| run | OS | iterations | red |
|---|---|---|---|
| 44911110988 | ubuntu-latest | 100 | **0** |
| 44911108149 | ubuntu-24.04-arm | 100 | **0** |

Both completed `success` (`FLAKE-HUNT SUMMARY … red=0`). Because the package is
capped at 10 files, these two runs are quoted here with their ids rather than
captured as separate records.

## K5 — stale table (this build, `combos stale --source official --json`)

`official[]` = 147 rows. Provider names that are private on this machine are
masked by `capture.mjs` (`<private-provider-N>`).

| provider | conclusion | rows |
|---|---|---|
| hf | LISTED-UPSTREAM | 104 |
| nvidia | NOT-IN-CATALOG | 13 |
| nvidia | LISTED-IN-CATALOG | 6 |
| openrouter | NOT-LISTED-UPSTREAM | 1 |
| bai, bzl, ds, gemini, google, groq, oc, ocz | NO-OFFICIAL-SOURCE | 14 |
| masked private providers | NO-OFFICIAL-SOURCE | 8 |

The 13 `NOT-IN-CATALOG` rows are **nvidia** (models.dev community catalog), not
`hf` — the C29 report said "hf 13" and was wrong. No row is
`ACCESS-RESTRICTED-OR-ABSENT` or `UPSTREAM-UNREACHABLE` in this run.

## CI records (captured with the standard tool)

| record | run | attempt | result |
|---|---|---|---|
| `c30-ci-main-85f4be3` | 44902034555 | 1 | success |
| `c30-ci-main-8c3f529` | 44913238136 | 1 | success |

Note: an earlier C29 report named run `44902147037` as "main CI". That id is a
Dependabot `dynamic` run, not CI. The real main CI run for `85f4be3` is
`44902034555` (record above). `ci-watch.mjs` now takes `--run` / `--workflow`
so a sha with several runs cannot silently report the wrong one.

## Limits

- (b) is still unexplained: no reproduction, no diagnosis. Suggested watch:
  alert when `e2e.test.ts` fails on attempt 1 of a main CI run while
  `flake-hunt` stays at red=0.
- `d7edfe5` remains reachable by sha until GitHub garbage-collects it; only
  provider names, no credentials.
- No model should be deleted on `NOT-LISTED-UPSTREAM` or `NOT-IN-CATALOG`.