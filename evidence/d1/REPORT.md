# C45 Stage 1 Evidence Report (`evidence/d1`) — WP0, WP1, WP2, WP3

- **Repository:** `https://github.com/CThawngs/Router-Sync`
- **Base `origin/main` SHA:** `cf88423d6f70fd682ee5c121b8bb32bd04a469e7` (`cf88423`)
- **Evidence Branch:** `evidence/d1` (direct push with `[skip ci]`, no Pull Request, never merged to `main`)
- **Stage Scope:** `WP0` (`S10`), `WP1 + WP2` (`S2, S3, S6`), `WP3` (`S1, S3, S7`)
- **Main 5-OS CI Gate:** Run `45465646777` — `status=completed`, `conclusion=success`, `18/18` jobs green, `attempt=1`

---

## 1. Stage 1 Work Package Audit Summary (4 RACI Proofs)

| WP | Serves | PR # & Head SHA | Squash-Merge `main` SHA | PR 5-OS CI (`attempt=1`) | QA Audit Sign-Off & Mutations Killed | `main` Push 5-OS CI (`attempt=1`) | Status |
|---|---|---|---|---|---|---|---|
| **WP0** | `S10` | PR #70 (`cefeb0b`) | `a22a48d490760a68441a86e69c8fd4e1ddb8c3ff` (`a22a48d`) | Run `45325224073` (`18/18`) | QA `SIGNED OFF` | Run `45338891630` (`18/18`) | **DONE (XONG)** |
| **WP1 + WP2** | `S2, S3, S6` | PR #71 (`04a84a2`) | `1ce5bbde75fb7909fa03280bc7c0006fa17eeda8` (`1ce5bbd`) | Run `45370088843` (`18/18`) | QA `SIGNED OFF` (`#issuecomment-7128685453`; `9/9` QA `Q1..Q9` + `5/5` Engineer `M1..M5` killed) | Run `45396026567` (`18/18`) | **DONE (XONG)** |
| **WP3** | `S1, S3, S7` | PR #72 (`c236d28`) + PR #73 (`ee77750`, surgical arm64 timing fix) | `7bd0160a10dc04971676e6b2eb8d0adedd1fce48` (`7bd0160`) -> `cf88423d6f70fd682ee5c121b8bb32bd04a469e7` (`cf88423`) | Run `45398100573` (`18/18`) + Run `45445558524` (`18/18`) | QA `SIGNED OFF` (`#issuecomment-7132658363`: `6/6` QA `Q1..Q6` + `6/6` Eng `M1..M6` killed; `#issuecomment-7140311112`: `2/2` QA `Q1..Q2` + `1/1` `M1` killed) | Run `45465646777` (`18/18`) | **DONE (XONG)** |

---

## 2. Isolated Evidence Captures (`evidence/d1/records.jsonl`)

Captured in an isolated temporary clone checked out directly from `origin/main` (`cf88423d6f70fd682ee5c121b8bb32bd04a469e7`) with zero writes to user router databases, live localhost ports, or user home configurations.

| # | Record ID | Command (`SAFE_VERBS`) | Exit | Duration | Key Verified Result | `stdout` SHA-256 (12) | `stderr` SHA-256 (12) |
|---:|---|---|---:|---:|---|---|---|
| 1 | `full-test-and-e2e` | `pnpm verify:release` | `0` | `360302 ms` | `typecheck` + `lint` + `build` + `test` (`180/180` files, `1441 passed \| 1 skipped`) + `e2e` (`1/1` file, `13/13` passed) | `dc0ea79d9838` | `83020efb6be0` |
| 2 | `stage1-harness-and-research` | `pnpm vitest run test/docs/c45-wp0-spec.test.ts packages/core/test packages/mcp-server/test` | `0` | `26435 ms` | `21/21` test files passed, `176 passed \| 1 skipped` (`177` total) | `1ae61da910ef` | `40dcff7c6f8a` |
| 3 | `security-and-pack-audit` | `node tools/agent/security-audit.mjs` | `0` | `66887 ms` | `repo-files` (`669`), `evidence-refs` (`24` refs / `996` blobs), `tarballs` (`8` pkgs), `write-gates`: `ok=true high=0 medium=0 low=0` | `67f4dcb11f9f` | `e3b0c44298fc` |

- All 3 records loaded `privateNamesLoaded=12` automatically via `tools/agent/capture-evidence.mjs`.

---

## 3. Compact 9-Harness Capability Matrix (`harness-matrix.json`)

| Harness | MCP Format & Install Strategy | Native Scheduler & Fallback | User-Editable Model List (Direction A Mode) | Evidence Tier |
|---|---|---|---|---|
| **Hermes** (`hermes`) | `yaml` (`yaml-comment-preserving-merge`) | Native 0-token script (`os-scheduler` fallback) | Yes (`write-adapter`) | **A** |
| **Claude Code** (`claude-code`) | `json` (`prefer-native-cli-else-atomic-json-merge`) | Native LLM-only (`os-scheduler-and-tick-if-due`) | Yes (`report-only`) | **A** |
| **Codex** (`codex`) | `toml` (`prefer-native-cli-else-toml-append-table`) | Native LLM-only (`os-scheduler-and-tick-if-due`) | Yes (`report-only`) | **A** |
| **Antigravity** (`antigravity`) | `json` (`atomic-json-merge`) | Native 0-token script (`os-scheduler` fallback) | No (`report-only`) | **A** |
| **OpenCode** (`opencode`) | `jsonc` (`jsonc-comment-preserving-merge`) | None (`os-scheduler-and-tick-if-due`) | Yes (`write-adapter`) | **A** |
| **Cursor** (`cursor`) | `json` (`atomic-json-merge`) | Native LLM-only (`os-scheduler-and-tick-if-due`) | No (`report-only`) | **A** |
| **Grok-Bot** (`grok-bot`) | Unsupported local stdio (`unsupported-local-stdio-guide-https-tunnel-or-grok-cli`) | Native LLM-only (`os-scheduler-and-tick-if-due`) | No (`report-only`) | **B** |
| **OpenMausBot** (`openmausbot`) | `json` (`atomic-json-merge`) | Native LLM-only (`os-scheduler-and-tick-if-due`) | Yes (`write-adapter`) | **A** |
| **DeepSeek Harness** (`dsh`) | `yaml` (`yaml-cordis-insert-merge`) | Native LLM-only (`os-scheduler-and-tick-if-due`) | Yes (`write-adapter`) | **A** |

---

## 4. Packaging & Hygiene Compliance

- Package file budget: **9 files (`<= 10`)** inside `evidence/d1/`.
- Verified before push via `verify-records.mjs`, `verify-package.mjs`, `scan-private-names.mjs`, and `no-personal-paths.mjs`.
- Zero live writes to owner configs or router databases; workspace package versions remain at `0.1.0`; no release tags or registry publishes.