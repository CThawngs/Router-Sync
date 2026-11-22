# `combos stale` — evidence rules

> Muốn biết gọi combo thật thì kết quả ra sao, xem `combos probe` trong
> [docs/combos-probe.md](combos-probe.md). `stale` chỉ đọc trạng thái; `probe`
> gửi request thật (cần `--yes-spend-tokens`).

`routersync combos stale` is read-only. It answers one question: for each step in
a combo, did the router itself show any evidence that the model is available?

## Routers with a state reader

| Router | Evidence source | Notes |
|---|---|---|
| `9router` | `kv` (`disabledModels`, `customModels`, `modelAliases`), `providerConnections`, `model-catalog.json` | Original reader. |
| `omniroute` | `key_value` namespaces `syncedAvailableModels` (`<provider>:<connectionId>` → model array), `customModels`, `modelAliases`; `radar_local_model_state` for DISABLED | C31 L1. There is no RouterSync registry mirroring its provider pages, so `snapshot` behaves like `direct`. |

OmniRoute combo steps carry fully-qualified ids (`vendor/model`) while the synced
list carries the bare id; the last path segment is matched for OmniRoute only and
reported as `PRESENT-NORMALIZED`. A provider with no `syncedAvailableModels` row
is `UNVERIFIABLE`, never `ABSENT`.

## Evidence source

- `direct` (default, `DEFAULT_STALE_SOURCE`): only what the router database
  reports — provider connections, custom models, aliases, disabled flags.
- `snapshot`: the provider registry shipped with RouterSync.
- `official` (C21): runs the `direct` classification, then asks the upstream
  catalog of each **public** provider whether the model is listed. Providers
  with a machine-readable catalog: OpenRouter (`model-list-api`); Hugging Face
  (probed per id via `hfModelUrl` — `NOT-LISTED-UPSTREAM` only on a definitive
  404); NVIDIA via the `models.dev` community catalog (`catalog-api` —
  `NOT-IN-CATALOG` when the id is absent from a reachable catalog). C29 J0
  added `LISTED-IN-CATALOG` / `NOT-IN-CATALOG` for catalog conclusions and
  `ACCESS-RESTRICTED-OR-ABSENT` for a gated per-id repo. C30 K3.1 narrowed
  that label to real access restrictions only (401/403 and other 4xx except
  404/429); rate-limit exhaustion, 5xx, network errors, timeouts and an
  unparseable 200 body are `UPSTREAM-UNREACHABLE`.
- The report prints `source=<value>` as its first line when the evidence is
  readable, and always carries `source` and `diagnostics.availabilitySource` in
  JSON, including under `--json`.

### UNVERIFIABLE is not ABSENT (C32 M3)

`UNVERIFIABLE` = the router carried **no availability evidence** for that provider.
It is not a statement about the upstream and never a removal argument. In the
2026-11-21 run, all 104 `hf` rows were `UNVERIFIABLE` in the router while the
official per-id probe said `LISTED-UPSTREAM` for the same 104 ids — reading
`UNVERIFIABLE` as "absent" would have deleted models that work.

### Official conclusions

| Conclusion | Meaning |
|---|---|
| `LISTED-UPSTREAM` | The provider's own catalog lists the model (OpenRouter/HF per-id). |
| `NOT-LISTED-UPSTREAM` | The catalog answered (200/404 for the HF per-id probe) and does not list the model. |
| `NO-OFFICIAL-SOURCE` | No machine-readable catalog is configured for that provider. |
| `UPSTREAM-UNREACHABLE` | The upstream said nothing about this model: network error, timeout, unparseable 200 body, HTTP 5xx, or HTTP 429 after the retry budget is spent. |
| `ACCESS-RESTRICTED-OR-ABSENT` | The endpoint answered but the repo is gated: HTTP 401, 403, or another 4xx except 404/429. Neither listed nor proven absent (low confidence). |
| `LISTED-IN-CATALOG` | The provider's community catalog (models.dev, NVIDIA) lists the model. |
| `NOT-IN-CATALOG` | The reachable community catalog does not list the model (low confidence). |

**Never delete a model because it is `NOT-LISTED-UPSTREAM`.** A catalog can lag,
paginate or omit a model the router still serves. The removal decision belongs to
the owner, and needs a human confirmation of the upstream state.

`DEFAULT_AVAILABILITY_SOURCE` (tier classification) stays `snapshot` because
tier parity is defined against the 9Router provider page. Staleness deliberately
does not reuse it: a combo must not be able to validate its own members.

## Statuses

| Status | Meaning |
|---|---|
| `PRESENT` | Exact step found in available models. |
| `PRESENT-NORMALIZED` | Found after dropping a `models/` prefix. |
| `DISABLED` | The router marks the model disabled (`disabledModels` for 9Router). |
| `ABSENT` | The provider carried availability evidence, but this model was not in it. |
| `UNVERIFIABLE` | The provider carried no availability evidence at all (e.g. a custom provider with no connection evidence). |

`UNKNOWN` is a report-level status, not a row status: the router database could
not be resolved, opened, or queried. In that case the command exits non-zero,
prints the reason on the first line, and emits no rows.


## C38 W2: chiến lược combo và xoay vòng tài khoản

Kế hoạch (`combos plan`) ghi thêm trường `strategy` cho từng combo và cảnh báo
`RISK-ROUND-ROBIN` kèm số đo W1 (số lần treo / số lần thử). Cảnh báo chỉ nêu dữ kiện,
không tự đổi cấu hình router.

**Không nhầm hai cấp chiến lược:**

| cấp | nơi | tác dụng |
|---|---|---|
| provider / account | `settings.providerStrategies` | xoay vòng giữa các tài khoản của cùng provider — "hết quota account 1 thì sang account 2" |
| combo | `settings.comboStrategies[<tên combo>]` | thứ tự giữa các bước model: `fallback` hoặc `round-robin` |

Đổi chiến lược **cấp combo** không làm mất xoay vòng **cấp tài khoản**. Trên máy đo
W0, `providerStrategies` đang **rỗng** — không khẳng định được hành vi mặc định;
ghi "không rõ" cho tới khi có số liệu.

## Removal rule

Never delete a model because it is `ABSENT` or `UNVERIFIABLE`.

- `ABSENT` says "the router did not list it", not "the upstream provider killed it".
- `UNVERIFIABLE` says "we have no evidence either way".
- Only a model the owner confirms as gone upstream may be removed, and the
  removal decision belongs to the owner, not to this report.

## Known limitations

The labels below are the ones introduced by the C18 audit. C19 briefly re-used
G4/G5/G7 for different findings; that re-use is reverted here and the mapping is
recorded so old notes stay readable.

| Label | Meaning (C18 audit) | Status |
|---|---|---|
| G4 | The `DISABLED` group never fired even though the router held 54 `disabledModels` entries. | Closed in C20: `DISABLED` is implemented and covered by a test. |
| G5 | With no network the staleness step silently degrades to `ABSENT`. | Open. |
| G7 | 4 OmniRoute rows were dropped from the report. | Open. |
| G8 | A provider with no availability evidence is reported as `UNVERIFIABLE`, not `ABSENT`. | Closed in C19. |
| G9 | An unreadable router database exits non-zero with `UNKNOWN` instead of an empty report. | Closed in C19. |
| G10 | Alias expansion can report the same model twice (`google/...` and `gemini/...`). | Open. |

### C30 K3.3: per-id lookups stay sequential (deliberate)

The `official` source probes each id one at a time. For 147 steps that took
29.9 s on the reference machine, which is acceptable for a report run, so the
concurrency question (C29 J0.3) is closed as **not required**: sequential
probes keep the request rate to the upstream low and keep the 429 retry budget
predictable. If a future run needs to be faster, parallelise with a bounded
pool and re-measure — do not raise the request rate unbounded.

### C19 → C20 label mapping

| C19 label | C20 label | Note |
|---|---|---|
| G4 (9Router reader schema) | G11 | Unrelated to the C18 G4; renumbered to free the original. |
| — | G12 | C21: `official` covers only providers with a machine-readable catalog (OpenRouter today); every other public provider is `NO-OFFICIAL-SOURCE`. |
| G5 (OmniRoute reader absent) | G7 | Same finding as the C18 G7 family; merged. |
| G7 (alias expansion) | G10 | Unrelated to the C18 G7; renumbered. |