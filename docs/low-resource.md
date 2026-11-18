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

## What changes in low-resource mode

- **Network**: max 1–2 concurrent requests (vs 4–6 normal), timeout ≤ 10 s, retry ≤ 1
- **SQLite**: sequential reads, `PRAGMA query_only=ON` on read-only connections
- **tick / daemon**: process priority lowered via `os.setPriority`
- **rank**: compact JSON summary output by default

## rank --json output size

`rank --json` always produces a compact summary ≤ 100 KB by default regardless of mode.

Use `--full` to get the complete output (may be several MB):

```sh
routersync rank --json --full
```

Write large output to a file with `--out`:

```sh
routersync rank --json --full --out rank-output.json
```

## Tips for low-memory machines

- **Keep the repo outside cloud-synced folders** (OneDrive, Dropbox). Sync software causes extra I/O during builds and tests, which can push free RAM below the 2 GiB threshold.
- **Run one agent at a time**. Multiple agent processes sharing a low-RAM machine compete for memory.
- **Close heavy applications** (browsers, Electron apps) before running `pnpm test` or `pnpm build`.
- Use `RS_TEST_WORKERS=1` to cap parallel test forks to 1 if memory is critically low:
  ```sh
  RS_TEST_WORKERS=1 pnpm test:quick
  ```

## Environment variables

| Variable | Values | Effect |
|---|---|---|
| `ROUTERSYNC_LOW_RESOURCE` | `1` / `0` | Override auto-detection |
| `ROUTERSYNC_PERF` | `1` | Print peak RSS and CPU on exit |
| `RS_TEST_WORKERS` | number | Override vitest fork count (default 2 on dev machines) |

## Auto-detection thresholds

| Condition | Threshold |
|---|---|
| Total RAM | ≤ 8 GiB |
| Available CPU cores | ≤ 4 |
| Free RAM at startup | < 2 GiB |

These thresholds are intentionally conservative. A 16 GiB machine with many processes running can trigger auto-detection via the free-RAM check.
