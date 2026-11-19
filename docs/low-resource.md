# Low-Resource Mode

RouterSync detects resource-constrained machines automatically and adjusts behaviour to reduce memory, CPU, and I/O pressure.

## How it works

| Trigger | Behaviour |
|---|---|
| `ROUTERSYNC_LOW_RESOURCE=1` | Force on |
| `ROUTERSYNC_LOW_RESOURCE=0` | Force off |
| Auto (no env var) | On when **total RAM ≤ 8 GiB**, or **available cores ≤ 4**, or **free RAM at startup < 2 GiB** |

When auto-detected, RouterSync prints a one-line reason to stderr:

```
[routersync] low-resource mode: auto: freeMem 1.3 GiB < 2 GiB
```

`routersync doctor --json` reports the active state in two fields:

```json
{ "lowResource": true, "lowResourceReason": "auto: freeMem 1.3 GiB < 2 GiB" }
```

When the env var forces the mode, the reason is `ROUTERSYNC_LOW_RESOURCE=1 (manual)`.
When forced off, `lowResourceReason` is `null`.

## What changes in low-resource mode

- **Network (`scan`)**: 1 concurrent request per host (normal: 4), timeout capped at 10 s.
- **SQLite**: read-only connections execute `PRAGMA query_only = ON`.
- **tick / daemon**: the process calls `os.setPriority` with `PRIORITY_LOW` at startup.
- **rank / verify**: `--json` prints a compact summary (≤ 100 KB) by default; use `--full` for the complete result.

## CLI watchdog

Every CLI command exits with code **124** after **120 s**, except `daemon` (long-running by design).
This prevents a hung provider request from blocking an agent indefinitely.

## Verify deadline

`routersync verify` finishes within **60 s**. If the deadline fires first, the summary
contains `incomplete: true` (and `--json` marks it too). Override with `--deadline-ms <ms>`.

## Large JSON output

Both `rank --json` and `verify --json` default to a compact summary (≤ 100 KB).
Use `--full` for the complete result and `--out <file>` to write to a file via a stream:

```sh
routersync rank --json --full --out rank-output.json
routersync verify --json --full --out verify-output.json
```

Without `--out`, JSON goes to stdout.

## Local agent mode (LIGHT-DEV)

Run `node tools/agent/preflight.mjs` before starting agent work. It prints
available RAM, core count, and whether the repo is inside a cloud-synced folder.
The script is **advisory only**: it reports `FULL` or `LIGHT-DEV` and exits 0;
it does not block commands or enforce the policy below. It is self-contained
and can run before `pnpm build`. The local-agent rule is enforced by following
the documented command list. When available RAM < 1.5 GiB, use `LIGHT-DEV`:

```sh
pnpm lint
pnpm typecheck:changed
pnpm test:changed          # vitest run --changed origin/main, fork cap kept
```

Do **not** run `pnpm test`, `pnpm e2e`, bare `vitest run`, or `pnpm test:slow`
locally in LIGHT-DEV. The full suite runs in PR CI.

`pnpm test:changed` is memory-bounded by the workspace fork limit, but it is not
guaranteed to finish faster than the full suite. Vitest's changed-file graph can
select most of the workspace after a shared-module change; measure the command
instead of treating its name as a performance promise.

## Cold-start measurement (C17)

C17 measured a fresh Node.js process for each layer on Windows x64, Node.js
24.18.0, in a cloud-synced repository with 884 MiB free RAM at start. Each
layer used two batches of 10 samples with a three-minute idle interval between
batches. Every `verify` sample used a fresh state directory.

| Layer | Samples | p50 | p95 | max |
|---|---:|---:|---:|---:|
| Node.js runtime | 20 | 49.1 ms | 66.2 ms | 92.4 ms |
| Core import | 20 | 134.5 ms | 192.0 ms | 192.8 ms |
| CLI import | 20 | 481.2 ms | 559.1 ms | 628.6 ms |
| CLI dispatch | 20 | 489.7 ms | 543.5 ms | 563.2 ms |
| Mock verify | 20 | 528.1 ms | 579.6 ms | 619.0 ms |

The fixed startup cost is dominated by loading the CLI module graph: the paired
median increment over core import was 350.3 ms. The three-minute idle interval
produced only small batch-2 p50 differences (between -15.6 and +3.9 ms), not a
material warm-up penalty. A separate C16 request-bearing `verify` run took about 10.2 s
while using only about 546 ms of CPU and reporting two requests; the offline
run reported zero requests and took about 315 ms. The observed long outlier was
therefore network/I/O variance, not module-import cold start.

## Tips for low-memory machines

- **Keep the repo outside cloud-synced folders** (OneDrive, Dropbox). Sync software causes extra I/O during builds and tests, which can push free RAM below the 2 GiB threshold.
- **Run one agent at a time**. Multiple agent processes sharing a low-RAM machine compete for memory.
- **Close heavy applications** (browsers, Electron apps) before running `pnpm test` or `pnpm build`.
- Use `RS_TEST_WORKERS=1` to cap parallel test forks to 1 if memory is critically low:

  ```sh
  RS_TEST_WORKERS=1 pnpm test
  ```

## Environment variables

| Variable | Values | Effect |
|---|---|---|
| `ROUTERSYNC_LOW_RESOURCE` | `1` / `0` | Override auto-detection |
| `ROUTERSYNC_PERF` | `1` | Print peak RSS (`maxRssMB`) and CPU on exit |
| `RS_TEST_WORKERS` | number | Override vitest fork count (default 2 on dev machines) |

## Auto-detection thresholds

| Condition | Threshold |
|---|---|
| Total RAM | ≤ 8 GiB |
| Available CPU cores | ≤ 4 |
| Free RAM at startup | < 2 GiB |

These thresholds are intentionally conservative. A 16 GiB machine with many processes running can trigger auto-detection via the free-RAM check.
