# ADR-SQLITE-01: Empirical Trade-Off Evaluation of `better-sqlite3` vs Built-In `node:sqlite`

- **ID:** ADR-SQLITE-01
- **Status:** **PROPOSED (Owner Decision Required — chờ chủ dự án; NO dependency swap in v0.1 code)**
- **Date:** 2026-11-24
- **Milestone:** M3 (`M3-02` / `P5`)
- **Related Files:** `packages/core/src/sqlite/driver.ts`, `packages/core/src/sqlite/better-sqlite3.ts`, `packages/core/package.json`, `packages/adapter-9router/package.json`, `packages/adapter-omniroute/package.json`, `footprint.json`, `budgets.json`, `tools/agent/pack-verify.mjs`, `.github/workflows/ci.yml`

---

## 1. Context & Problem Statement

RouterSync reads and snapshots local router SQLite databases (`9Router` and `OmniRoute`) through the synchronous `SqliteDriver` abstraction in `packages/core/src/sqlite/driver.ts`. Today, `packages/core/src/sqlite/better-sqlite3.ts` implements `SqliteDriver` exclusively on top of `better-sqlite3@13.0.3`.

While `better-sqlite3@13.0.3` is battle-tested and ships prebuilt native N-API/V8 binaries for mainstream x64/arm64 targets, native addons carry ongoing operational costs across RouterSync's 5-OS × 2-Node CI matrix (`ubuntu-latest`, `ubuntu-24.04-arm`, `macos-latest`, `windows-latest`, `windows-11-arm` × `Node 22` and `Node 24` in `.github/workflows/ci.yml`). At the same time, Node.js now ships a built-in synchronous `DatabaseSync` API under `node:sqlite`.

Per Milestone `M3` (`P5`), this ADR records empirical measurements and trade-offs without modifying any `package.json` dependency list in `v0.1.0`. Any migration or dual-driver implementation remains strictly queued in **`chờ chủ dự án`**.

---

## 2. Empirical & Architectural Comparison Tables

### 2.1. Install Cost & Build Toolchain

| Dimension | `better-sqlite3@13.0.3` (Current `v0.1.0`) | Built-In `node:sqlite` (`DatabaseSync`) | Source / Evidence |
|---|---|---|---|
| External npm dependencies | `better-sqlite3@13.0.3` + transitive `bindings`, `prebuild-install`, `file-uri-to-path`, `tar-fs`, `pump`, `simple-get` | `0` external npm packages (bundled inside Node.js binary) | `packages/core/package.json`, `footprint.json` |
| Install-time binary fetch | Runs `prebuild-install` lifecycle script during `npm install` (or requires `pnpm rebuild better-sqlite3` when `pnpm` blocks build scripts by default) | `0` lifecycle scripts, `0` network prebuild downloads | `packages/core/src/sqlite/better-sqlite3.ts`, `tools/ci/footprint.mjs` |
| C++ compiler fallback risk (`node-gyp`) | Falls back to `node-gyp` (`Python` + `Visual Studio Build Tools` / `clang` / `make`) whenever a new Node ABI or niche OS/arch lacks a published GitHub release asset | None — compiled as part of upstream Node.js distribution | `tools/ci/footprint.mjs` (`nodeGyp: false` gate) |
| Offline / air-gapped clean install | Requires pre-cached `.node` prebuild or local C++ toolchain matching exact `process.versions.modules` ABI | Works 100% offline wherever a supported Node.js binary is installed | `tools/agent/pack-verify.mjs` |

### 2.2. 5-OS & Node 22 / Node 24 Compatibility Matrix

RouterSync's `engines.node` contract requires `>=22.12.0`, and `.github/workflows/ci.yml` runs on 5 OS runners across Node 22 and Node 24:

| Target Runner / Runtime | `better-sqlite3@13.0.3` | `node:sqlite` (`DatabaseSync`) | Operational Notes |
|---|---|---|---|
| `ubuntu-latest` (`linux/x64`, Node 22 & 24) | Prebuilt binary available; passes CI | Built into Node binary | Parity on both Node 22 and Node 24 |
| `ubuntu-24.04-arm` (`linux/arm64`, Node 22 & 24) | Prebuilt `linux-arm64` binary available | Built into Node binary | Parity on glibc `arm64`; `alpine/musl` arm64 often triggers `node-gyp` on `better-sqlite3` |
| `macos-latest` (`darwin/arm64`, Node 22 & 24) | Prebuilt `darwin-arm64` binary available | Built into Node binary | Parity on Apple Silicon |
| `windows-latest` (`win32/x64`, Node 22 & 24) | Prebuilt `win32-x64` binary available | Built into Node binary | Native `.node` DLL file-locking in worker pools requires careful `.close()` before temp-dir `rmSync` |
| `windows-11-arm` (`win32/arm64`, Node 22 & 24) | **High friction:** `win32-arm64` prebuilds lag or require ARM64 MSVC `node-gyp` compilation (`.github/workflows/ci.yml` keeps `continue-on-error` on `windows-11-arm`) | **Zero addon friction:** ships directly inside the official `win-arm64` Node.js binary | Eliminating native `.node` prebuilds directly removes the primary native ABI risk on `windows-11-arm` |
| Flag & `stderr` warning behavior (`>=22.12.0` vs `24.x`) | Zero Node experimental flags or warnings on all supported Node versions | **Node `22.12.x`:** requires `--experimental-sqlite` CLI flag. **Node `>=22.13.0`:** unflagged, but emits `ExperimentalWarning: SQLite is an experimental feature` on `stderr` in `22.x`. **Node `24.18.0` (verified):** unflagged (`typeof DatabaseSync === 'function'`) with `stderr === ""` | On Node `22.12.x`, unflagged `import('node:sqlite')` fails without `--experimental-sqlite`; on Node `22.13+`, `ExperimentalWarning` on `stderr` must be accounted for in strict `stderr`-clean CLI / stdio MCP tests |

### 2.3. Package & Clean-Install Footprint

Measured from `footprint.json`, `budgets.json`, `tools/agent/pack-verify.mjs`, and the local `pnpm` store on `win32/x64` (`Node v24.18.0`):

| Metric | Measured Value (`v0.1.0` with `better-sqlite3@13.0.3`) | Projected Value with `node:sqlite` Only | Source |
|---|---|---|---|
| All 8 publishable `@routersync/*` tarballs (packed `.tgz` sum, source maps excluded) | `484,382 B` (`~0.46 MiB`, `344` files total across 8 packages) | `484,382 B` (workspace tarballs unchanged except manifest deps) | `tools/agent/pack-verify.mjs` |
| All 8 publishable `@routersync/*` tarballs (unpacked `dist/` + `package.json` sum) | `1,918,349 B` (`~1.83 MiB`) | `1,918,349 B` | `tools/agent/pack-verify.mjs` |
| `better-sqlite3@13.0.3` package directory alone (including C/SQLite amalgamation sources + `.node` binary) | `27,302,969 B` (`~26.04 MiB`) | **`0 B`** external npm delta | Measured `node_modules` directory size of `better-sqlite3@13.0.3` |
| `cli-only` clean-install scenario (`@routersync/cli` + 6 internal workspace deps + npm prod deps) | `35,229,573 B` (`~33.60 MiB`, `1,551` files; CI budget `38,748,489 B`) | **`~7.9 MiB`** (`~77.5%` reduction in `cli-only` `node_modules` bytes) | `footprint.json`, `budgets.json` |
| `cli-mcp-server` clean-install scenario | `46,677,287 B` (`~44.51 MiB`, `4,383` files; CI budget `51,350,996 B`) | **`~19.4 MiB`** (`~58.5%` reduction) | `footprint.json`, `budgets.json` |

### 2.4. Measured Read-Only Query & `VACUUM INTO` Performance (`n = 7` Runs)

Measured side-by-side on `Node v24.18.0` (`win32/x64`) in an isolated temporary directory against an identical WAL-mode SQLite database seeded with `25` `combos` rows, `1` `settings` row, and `2,000` `usageHistory` rows. Both drivers enforced `PRAGMA busy_timeout = 5000` and `PRAGMA query_only = ON`:

| Workload (`n = 7` runs, sample `stddev`) | `better-sqlite3@13.0.3` | `node:sqlite` (`DatabaseSync`) | Delta / Observation |
|---|---|---|---|
| **50x Read-Only Diagnostic Batch** (`open` + `PRAGMA busy_timeout=5000` + `PRAGMA query_only=ON` + `50` iterations of `combos` `ORDER BY name`, `settings` `WHERE id=1`, and `usageHistory` `GROUP BY comboName, status` + `close`) | `mean = 42.351 ms`, `stddev = 4.986 ms`, `min = 35.914 ms`, `max = 50.224 ms` (`0.847 ms` / batch) | `mean = 38.938 ms`, `stddev = 8.184 ms`, `min = 27.431 ms`, `max = 50.591 ms` (`0.779 ms` / batch) | Sub-millisecond per read batch (`~0.78 ms` vs `~0.85 ms`); both are >`100x` below CLI cold-start budgets in `budgets.json` |
| **Atomic Snapshot Backup (`VACUUM INTO`)** (`open` read-only + `VACUUM INTO '<dest>'` + `close`) | `mean = 13.362 ms`, `stddev = 3.080 ms`, `min = 10.353 ms`, `max = 19.672 ms` | `mean = 17.001 ms`, `stddev = 3.121 ms`, `min = 14.258 ms`, `max = 23.405 ms` | Both execute `VACUUM INTO` synchronously and safely in WAL mode (`+3.64 ms` on `node:sqlite`) |
| **`SqliteDriver` API Mapping (`packages/core/src/sqlite/driver.ts`)** | Native `.pragma(name, { simple: true })` and `.backup(dest)` + `VACUUM INTO` | Requires `prepare('PRAGMA ' + name).get()` scalar helper + `exec("VACUUM INTO ...")` (no separate async online backup binding; `SqliteDriver.backup` already uses `VACUUM INTO`) | `SqliteDriver` synchronous interface (`exec`, `prepare`, `transaction`, `pragma`, `backup`, `close`) maps 1-to-1 to `DatabaseSync` with `null`-prototype row normalization (`{ ...row }`) |

---

## 3. Pros, Cons & Risk Summary

### Option 1: Retain `better-sqlite3@13.0.3` as Sole Driver (Status Quo in `v0.1.0`)
- **Pros:**
  - Zero `ExperimentalWarning` or `--experimental-sqlite` flag divergence across `Node 22.12.0` through `Node 24.x`.
  - Proven stability across all existing unit, acceptance, and e2e suites (`backupAsync` online backup API + `VACUUM INTO` already validated).
  - Plain `Object.prototype` row objects returned by `.get()` / `.all()` out of the box.
- **Cons:**
  - Accounts for `27.3 MB` (`77.5%`) of the `35.2 MB` `cli-only` clean install footprint.
  - Requires `pnpm rebuild better-sqlite3` when `pnpm` blocks native build scripts, and carries native ABI / `node-gyp` friction on `windows-11-arm` and bleeding-edge Node releases.

### Option 2: Dual-Driver Adapter Behind `SqliteDriver` (`node:sqlite` Primary on Node `>=24` / Fallback when Native Addon Unavailable)
- **Pros:**
  - Preserves backward compatibility on `Node 22.12.x` while providing automatic resilience when `better-sqlite3` prebuilds are skipped by `pnpm` or unavailable on `windows-11-arm`.
  - Zero adapter changes required in `@routersync/adapter-9router` or `@routersync/adapter-omniroute` because both already depend on `SqliteDriver` (`packages/core/src/sqlite/driver.ts`).
- **Cons:**
  - Still downloads `better-sqlite3` unless moved to `optionalDependencies`, and requires testing both drivers in CI.
  - `DatabaseSync` row objects use `null` prototypes (`Object.create(null)`), requiring shallow `{ ...row }` normalization in `SqliteStatement` if callers invoke `hasOwnProperty`.

### Option 3: Full Migration to Built-In `node:sqlite` (`DatabaseSync`) & Removal of `better-sqlite3`
- **Pros:**
  - Cuts `cli-only` installed footprint by `~27.3 MB` (`~77.5%`), eliminates `100%` of native addon / `node-gyp` / `pnpm rebuild` issues across all 5 OSes including `windows-11-arm`, and matches `better-sqlite3` read latency (`0.779 ms` vs `0.847 ms` per diagnostic batch).
- **Cons:**
  - Requires raising `engines.node` floor from `>=22.12.0` to at least `>=22.13.0` (where `node:sqlite` was unflagged) or `>=24.0.0` (where `stderr` emits zero `ExperimentalWarning`), and replacing `backupAsync` (`packages/core/src/sqlite/better-sqlite3.ts:340`) with `VACUUM INTO`.

---

## 4. Recommendation & Owner Decision Gate (`chờ chủ dự án`)

1. **For `v0.1.0` (Current Release Line):** Keep `better-sqlite3@13.0.3` **unchanged** in `packages/core/package.json`, `packages/adapter-9router/package.json`, `packages/adapter-omniroute/package.json`, and root `package.json`. No dependency swap is performed in Milestone `M3`.
2. **Queued Proposal (`chờ chủ dự án`):**
   - **Short-term (`v0.2` candidate):** Implement an opt-in / fallback `NodeSqliteDriver` behind `SqliteDriver` (`packages/core/src/sqlite/driver.ts`) tested on Node 24 in CI, normalizing `DatabaseSync` `null`-prototype rows and mapping `pragma()` via `prepare('PRAGMA ...').get()`.
   - **Medium-term (`engines.node` policy decision for Owner):** Once Owner approves raising `engines.node` to `>=22.13.0` (with warning filter) or `>=24.0.0`, drop `better-sqlite3` from production `dependencies` to reclaim `~27.3 MB` (`77.5%`) of `cli-only` install size and eliminate native prebuild friction on `windows-11-arm`.
