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
